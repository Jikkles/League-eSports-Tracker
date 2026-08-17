#!/usr/bin/env node
/*
 * Loads the real page in a real browser and checks it actually renders.
 *
 * Why this exists: tools/check.mjs proves the script parses and
 * tools/api-canary.mjs proves the API answers, but neither proves the page
 * works. A parse-clean edit that throws on first render, or a payload the
 * canary is happy with but the render code chokes on, gets through both and
 * lands on Pages looking like a black screen. This is the check that opens it
 * and looks.
 *
 * It serves the repo over http rather than opening a file:// URL, because
 * file:// gives the page a null origin, which changes how its API fetches and
 * its CORS-proxy fallbacks behave — that is not the thing we want to test.
 * Everything runs against a cold browser profile, so empty localStorage: the
 * first-visit path, which is the one most likely to be broken and the least
 * likely to be noticed by whoever already has the site cached.
 *
 *   node tools/smoke.mjs             # exit 1 on any failure
 *   node tools/smoke.mjs --headed    # watch it happen
 *   node tools/smoke.mjs --shot x.png  # save a full-page screenshot
 *
 * Needs playwright, which this repo deliberately does not carry a package.json
 * for. Install it without creating one:
 *
 *   npm install --no-save playwright && npx playwright install chromium
 *
 * Plain node 18+ otherwise.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// --root points the server at a different copy of the site; used to run this
// against a deliberately broken index.html and confirm the checks still bite
const ROOT = process.argv.includes('--root')
  ? resolve(process.argv[process.argv.indexOf('--root') + 1])
  : join(HERE, '..');

const HEADED = process.argv.includes('--headed');
const SHOT = process.argv.includes('--shot')
  ? process.argv[process.argv.indexOf('--shot') + 1] : null;

const LEAGUES = ['lec', 'lck', 'lpl', 'lcs'];
const LEAGUE_COUNT = LEAGUES.length;
const LOAD_MS = 45000;   // cold profile, live API, CI runner — be generous
const STEP_MS = 10000;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright is not installed. From the repo root:\n');
  console.error('  npm install --no-save playwright && npx playwright install chromium\n');
  process.exit(1);
}

const results = [];
const ok = (name, note) => { results.push({ name, ok: true, note }); console.log(`  ok   ${name}${note ? ` — ${note}` : ''}`); };
const bad = (name, why) => { results.push({ name, ok: false, why }); console.log(`  FAIL ${name} — ${why}`); };
const skip = (name) => { results.push({ name, ok: true, skipped: true }); console.log(`  --   ${name} — skipped, the page is already broken`); };

/* Once the page is fundamentally broken there is no point waiting out a
   timeout on every downstream check — a failing run should take seconds, not
   minutes, or nobody will run it locally. A failed `fatal` check stops the
   rest. */
let broken = false;

async function check(name, fn, { fatal = false, always = false } = {}) {
  if (broken && !always) return skip(name);
  try {
    ok(name, await fn());
  } catch (e) {
    bad(name, (e.message || String(e)).split('\n')[0].slice(0, 200));
    if (fatal) broken = true;
  }
}

/* ---- serve the repo ----------------------------------------------------- */

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const path = join(ROOT, normalize(rel === '/' ? '/index.html' : rel));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    const ext = path.slice(path.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

/* ---- drive it ----------------------------------------------------------- */

const browser = await chromium.launch({ headless: !HEADED });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

// Anything the page throws on its own is a bug in the page, full stop.
const crashes = [];
const consoleErrors = [];
page.on('pageerror', e => crashes.push(e.message.split('\n')[0]));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().split('\n')[0].slice(0, 200)); });

/* If the page has thrown, whatever we are waiting for is probably never going
   to arrive — say why now rather than after another timeout. */
function raceCrash(promise) {
  // any uncaught exception counts, including one thrown during load before
  // this check started — that is the usual case for a broken first render
  return Promise.race([promise, new Promise((_, reject) => {
    const t = setInterval(() => {
      if (crashes.length) { clearInterval(t); reject(new Error(`the page threw: ${crashes[0]}`)); }
    }, 100);
    promise.finally(() => clearInterval(t)).catch(() => {});
  })]);
}

let loaded = true;
try {
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: LOAD_MS });
} catch (e) {
  loaded = false;
  bad('page loads', e.message.split('\n')[0]);
}

if (loaded) {
  await check('page loads', async () => {
    // there is no data-tab=home button — home is the "All" chip, and the
    // .tab[data-tab=home] CSS rule is left over from an older nav
    await raceCrash(page.waitForSelector('.fchip[data-f=all]', { timeout: STEP_MS }));
    const tabs = await page.$$eval('nav .tab', t => t.length);
    if (tabs !== LEAGUE_COUNT) throw new Error(`nav has ${tabs} league tabs, expected ${LEAGUE_COUNT}`);
    return await page.title() || 'untitled';
  }, { fatal: true });

  /* The API status dot is the page's own verdict on whether live data arrived.
     Green means fetch, parse and render all worked — a stronger statement than
     the canary can make, because it is the page's real code path saying it. */
  await check('live data reaches the page', async () => {
    await raceCrash(page.waitForSelector('#apiStatus .dot.ok', { timeout: LOAD_MS }));
    return (await page.textContent('#apiStatus'))?.trim() || 'ok';
  }, { fatal: true });

  /* ---- the home board ---- */

  for (const [name, sel] of [
    ['power rankings', '#rankList'],
    ['storylines', '#storylines'],
    ['honours board', '#honoursBoard'],
  ]) {
    await check(`home: ${name} renders`, async () => {
      await page.waitForFunction(
        s => (document.querySelector(s)?.children.length ?? 0) > 0, sel, { timeout: STEP_MS });
      const n = await page.$eval(sel, el => el.children.length);
      return `${n} entries`;
    });
  }

  /* ---- each league tab ---- */

  for (const slug of LEAGUES) {
    await check(`${slug}: tab renders`, async () => {
      await page.click(`.tab[data-tab=${slug}]`);
      await page.waitForSelector(`#page-${slug}.active`, { timeout: STEP_MS });

      // standings arrive from the API, so give them a moment to land
      await page.waitForFunction(
        s => (document.querySelectorAll(`#table-${s} tr`).length) > 1, slug, { timeout: STEP_MS });
      const rows = await page.$$eval(`#table-${slug} tr`, r => r.length);

      // the bracket wiring is measured from laid-out boxes, so it can only be
      // drawn once the tab is visible — a regression here is invisible on load
      const wires = await page.$$eval(`#simBracket-${slug} svg, #simBracket-${slug} line, #simBracket-${slug} path`, n => n.length)
        .catch(() => 0);

      return `${rows - 1} standings rows, ${wires} bracket wires`;
    });
  }

  await check('back to home', async () => {
    await page.click('.fchip[data-f=all]');
    await page.waitForSelector('#page-home.active', { timeout: STEP_MS });
    return 'nav round-trips';
  });

  if (SHOT) {
    await page.screenshot({ path: SHOT, fullPage: true });
    console.log(`  ..   screenshot written to ${SHOT}`);
  }

  /* ---- what the page said while we were poking it ---- */

  await check('no uncaught exceptions', async () => {
    if (crashes.length) throw new Error(`${crashes.length}: ${[...new Set(crashes)].join(' | ')}`);
    return 'none';
  }, { always: true });

  await check('no console errors', async () => {
    if (consoleErrors.length) throw new Error(`${consoleErrors.length}: ${[...new Set(consoleErrors)].join(' | ')}`);
    return 'none';
  }, { always: true });
}

await browser.close();
server.close();

/* ---- report ------------------------------------------------------------- */

const failed = results.filter(r => !r.ok);
const skipped = results.filter(r => r.skipped).length;
console.log(failed.length
  ? `\n${failed.length} of ${results.length} checks failed${skipped ? `, ${skipped} skipped` : ''}.`
  : `\nAll ${results.length} checks passed.`);

process.exitCode = failed.length ? 1 : 0;
