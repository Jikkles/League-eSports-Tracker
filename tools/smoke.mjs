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
 * for. Install it without creating one — and install axe-core in the SAME
 * command, because with no package.json to read npm treats node_modules as the
 * whole dependency tree and quietly uninstalls whatever you leave out:
 *
 *   npm install --no-save playwright axe-core && npx playwright install chromium
 *
 * axe-core is optional; without it the accessibility check reports as skipped
 * rather than failing, so the render checks still run on a bare install.
 *
 * Plain node 18+ otherwise.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
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

/* Optional: the a11y check reports as skipped without it rather than failing,
   so a bare `npm install --no-save playwright` still runs everything else. */
let axePath = null;
try {
  axePath = createRequire(import.meta.url).resolve('axe-core');
} catch { /* not installed; handled at the check */ }

const results = [];
const ok = (name, note) => { results.push({ name, ok: true, note }); console.log(`  ok   ${name}${note ? ` — ${note}` : ''}`); };
const bad = (name, why) => { results.push({ name, ok: false, why }); console.log(`  FAIL ${name} — ${why}`); };
const skip = (name, why = 'the page is already broken') => { results.push({ name, ok: true, skipped: true }); console.log(`  --   ${name} — skipped, ${why}`); };

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
/* A failed request logs "Failed to load resource: ... 404" and names nothing,
   which is a poor thing to find in a CI log — it was a hotlinked logo, and
   working that out took a bisect. The URL is on the message's location. */
page.on('console', m => {
  if (m.type() !== 'error') return;
  const url = m.location()?.url || '';
  const line = m.text().split('\n')[0] + (url ? ` [${url.slice(0, 120)}]` : '');
  consoleErrors.push(line.slice(0, 320));
});

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
    // the four leagues, plus the international-event tab leading them
    const tabs = await page.$$eval('nav .tab', t => t.length);
    if (tabs !== LEAGUE_COUNT + 1) throw new Error(`nav has ${tabs} tabs, expected ${LEAGUE_COUNT + 1}`);
    if (!await page.$('nav .tab-evt')) throw new Error('the international-event tab is missing from the nav');
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

    /* "Fill from results" reads the played bracket out of the feed, and its
       failure mode is silence: a wrong pair key, a block regex that stops
       matching a renamed round, a variant search that picks the worst fit —
       all of them leave a rendered bracket with nothing in it and throw
       nothing. So this clicks the real button and holds the outcome to the
       feed the page itself is reading.

       Two invariants, and both matter. Every winner it writes has to be one of
       the two teams actually in that match, or the bracket is asserting a
       result nobody played. And where the feed has completed bracket games,
       it has to fill at least one — a league between splits legitimately
       fills none, but one mid-playoffs filling none is the silent failure. */
    await check(`${slug}: fill from results`, async () => {
      const r = await page.evaluate(s => {
        const btn = document.querySelector('#simFill-' + s);
        if (!btn) return { err: 'no "Fill from results" button on this tab' };
        btn.click();
        const S = simLoad(s), F = FORMATS[S.format], res = simResolve(s);
        const played = [...simRealGames(s).values()].reduce((n, v) => n + v.length, 0);
        const filled = Object.keys(S.winners).length;
        for (const m of F.matches) {
          const w = S.winners[m.id];
          if (w && !res[m.id].includes(w))
            return { err: `${m.id} was won by ${w}, who is not in it (${res[m.id].join(' v ')})` };
        }
        return { played, filled, msg: document.querySelector('#simFillMsg-' + s)?.textContent || '' };
      }, slug);
      if (r.err) throw new Error(r.err);
      if (!r.msg.trim()) throw new Error('the fill reported nothing at all');
      if (r.played && !r.filled)
        throw new Error(`the feed has ${r.played} completed bracket game(s) and the fill placed none`);
      return `${r.filled} of ${r.played} played`;
    });

    /* The race board is computed rather than fetched, which makes its failure
       mode quiet: a broken edit renders "the race board fills in once the
       standings load" and throws nothing, so every other check here stays
       green. The arithmetic is the real guard. Exactly `cut` teams qualify in
       every ending — a team above the line counts 1, and a tied band straddling
       it splits one place between its members — so a group's odds have to add
       up to its number of places no matter what the ranking, the tiebreaks and
       the fraction handling did on the way there. */
    await check(`${slug}: playoff race adds up`, async () => {
      const r = await page.evaluate(s => {
        const st = raceRun(s);
        if (!st) return { none: true };
        return {
          rows: document.querySelectorAll(`#raceTable-${s} tr.race-row`).length,
          teams: st.C.teams.length,
          fixtures: st.C.fixtures.length,
          exact: st.exact,
          chips: [...document.querySelectorAll(`#raceTable-${s} .race-chip`)].map(c => c.textContent),
          groups: st.C.groups.filter(g => g.cut).map(g => ({
            name: g.name,
            places: Math.min(g.cut, g.members.length),
            sum: g.members.reduce((a, ti) => a + st.acc[ti].pIn, 0),
          })),
        };
      }, slug);

      if (r.none) throw new Error('no table to race — the panel rendered its empty state');
      if (r.rows !== r.teams) throw new Error(`${r.rows} race rows for ${r.teams} teams`);
      if (!r.groups.length) throw new Error('no qualification cut resolved for this league');

      // "play-in" / "playoffs" (and the "?" forms) mark a team that missed the
      // cut being raced for but still has a place below it — see raceStatus()
      const VOCAB = new Set(['Locked', 'Near-certain', 'Alive', 'Eliminated', 'No path seen',
                             'play-in', 'playoffs', 'play-in?', 'playoffs?']);
      const odd = r.chips.filter(c => !VOCAB.has(c));
      if (odd.length) throw new Error(`unexpected status chip: "${odd[0]}"`);

      for (const g of r.groups)
        if (Math.abs(g.sum - g.places) > 0.01)
          throw new Error(`${g.name || 'table'}: odds sum to ${g.sum.toFixed(3)} for ${g.places} places`);

      return `${r.rows} rows, ${r.fixtures} games left, ${r.exact ? 'exact' : 'sampled'}, `
        + `odds sum to ${r.groups.map(g => g.places).join(' + ')}`;
    });

    /* The odds can add up perfectly while the table still contradicts itself,
       because the panel draws its rows in one order and computes everything
       else in another: the row number and the cut line come from the standings
       feed's ordinal, the Range column and the status chip from this page's
       own ranking. When the two disagree you get a row printed below the
       qualification line and labelled "Locked" — which is how the LCK read for
       a week, its feed ranking the whole four-round season while the page
       ranked the eight games of one group. Nothing else here notices: the
       arithmetic above was green throughout.

       So: read what the panel actually rendered and hold the two halves against
       each other. A team drawn above the line cannot be eliminated, one drawn
       below it cannot be locked in, and the place printed in the rank column
       has to be a place its own Range says is available. */
    await check(`${slug}: race table agrees with itself`, async () => {
      const bad = await page.evaluate(s => {
        const ORD = { '1st':1,'2nd':2,'3rd':3,'4th':4,'5th':5,'6th':6,'7th':7,'8th':8,'9th':9,'10th':10,
                      '11th':11,'12th':12,'13th':13,'14th':14 };
        const out = [];
        const cuts = raceRun(s)?.C.groups || [];
        let gi = -1;
        for (const tbl of document.querySelectorAll(`#raceTable-${s} table.tbl-race`)) {
          gi++;
          const cut = cuts[gi]?.cut || 0;
          const rows = [...tbl.querySelectorAll('tr.race-row')];
          rows.forEach((tr, i) => {
            const cell = n => tr.children[n]?.textContent.trim() || '';
            const team = cell(1), range = cell(4), chip = cell(6);
            const place = parseInt(cell(0), 10);
            const above = cut && i < cut;
            if (above && chip === 'Eliminated')
              out.push(`${team} is drawn above the cut line but marked Eliminated`);
            if (cut && !above && chip === 'Locked')
              out.push(`${team} is drawn below the cut line but marked Locked`);
            if (above && /^play-?in/i.test(chip))
              out.push(`${team} is drawn above the cut line but marked ${chip}`);
            // Range reads "3rd" or "5th=-8th"; the printed place must sit in it
            const ends = range.replace(/=/g, '').split('–').map(x => ORD[x.trim()]);
            if (Number.isFinite(place) && ends.length && ends.every(Number.isFinite)) {
              const lo = ends[0], hi = ends[ends.length - 1];
              if (place < lo || place > hi)
                out.push(`${team} is drawn ${place} but its range is ${range}`);
            }
          });
        }
        return out;
      }, slug);
      if (bad.length) throw new Error(bad[0] + (bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''));
      return 'rank, cut line and status tell one story';
    });
  }

  /* ---- the international-event tab ---- */

  /* Built from the EVENT constant and from nothing else, so it cannot fail the
     way a league tab fails — there is no feed to be down. What it can do is go
     blank: buildEventPage() returns silently when its section is missing, and
     the tab would then open an empty page throwing nothing. check.mjs holds the
     slug together across the constant and the markup; this holds the render. */
  await check('event tab renders', async () => {
    await page.click('.tab-evt');
    const slug = await page.$eval('.tab-evt', b => b.dataset.tab);
    await page.waitForSelector(`#page-${slug}.active`, { timeout: STEP_MS });
    const r = await page.evaluate(s => {
      const pg = document.querySelector(`#page-${s}`);
      return {
        panels: pg.querySelectorAll('.panel').length,
        rows: pg.querySelectorAll('.nxt.tbd').length,
        wip: !!pg.querySelector('.wip-badge'),
        mark: !!document.querySelector('.tab-evt .evt-mark'),
        label: document.querySelector('.tab-evt')?.getAttribute('aria-label') || '',
      };
    }, slug);
    if (!r.panels) throw new Error('the event page rendered nothing');
    if (!r.rows) throw new Error('no TBD fixtures on the event page');
    if (!r.wip) throw new Error('the work-in-progress badge is missing — the page reads as broken without it');
    if (!r.mark) throw new Error('the nav tab has no mark in it');
    if (!r.label) throw new Error('the nav tab is a mark with no accessible name');
    return `${r.label}: ${r.panels} panels, ${r.rows} TBD fixtures`;
  });

  /* The stage strip is the second thing on that tab with facts in it, and like
     the qualification board it comes from a constant nothing fetches — so a
     render that quietly dropped the dates would leave three cards reading TBD,
     which is exactly what the page looked like before Riot published them and
     exactly what every other check would go on calling healthy. This reads the
     cards back against EVENT.stages. */
  await check('event tab: stage strip', async () => {
    const r = await page.evaluate(() => {
      const stages = typeof EVENT !== 'undefined' ? (EVENT.stages || []) : [];
      const cards = [...document.querySelectorAll('.evt-stages .ov-rg')];
      if (!stages.length) return { err: 'EVENT.stages is not on the page' };
      if (cards.length !== stages.length) return { err: `${stages.length} stages in the constant, ${cards.length} cards drawn` };
      for (let i = 0; i < stages.length; i++) {
        const st = stages[i], c = cards[i];
        const txt = s => c.querySelector(s)?.textContent.trim() || '';
        if (txt('.top') !== st.name) return { err: `card ${i} is titled "${txt('.top')}", not "${st.name}"` };
        const n = txt('.n');
        if (st.when && n !== st.when) return { err: `${st.name} should print "${st.when}" and prints "${n}"` };
        if (!st.when && n !== 'TBD') return { err: `${st.name} has no date but prints "${n}" rather than TBD` };
        const venues = [].concat(st.venue || []);
        const drawn = [...c.querySelectorAll('.st-where')].map(v => v.textContent.trim());
        if (drawn.join('|') !== venues.join('|')) return { err: `${st.name} draws venues [${drawn}] rather than [${venues}]` };
        if (st.detail && txt('.st-when') !== st.detail) return { err: `${st.name} lost its breakdown` };
      }
      return { dated: stages.filter(s => s.when).length, n: stages.length };
    });
    if (r.err) throw new Error(r.err);
    return `${r.dated} of ${r.n} stages carry a published window`;
  });


  /* The bracket is the one panel on this tab drawn from the feed rather than
     from a constant, and it fails the way every computed panel fails: quietly.
     A slot that resolved to neither a team nor a route renders as an empty box
     and throws nothing, which is the bug worth catching — it means the origin
     wiring stopped resolving and the panel is now a wall of blanks pretending
     to be a bracket.

     An absent bracket is reported, not failed. Riot publishing one at all is a
     data question, and this file does not decide those — the canary asks
     whether the call still answers, and this asks whether the answer drew. */
  await check('event tab: published bracket', async () => {
    const r = await page.evaluate(() => {
      const body = document.querySelector('#evtBracketBody');
      if (!body) return { err: 'the bracket panel is not on the page' };
      const br = body.querySelector('.bracket');
      if (!br) return { none: (body.textContent || '').trim().slice(0, 80) };
      const slots = [...br.querySelectorAll('.bslot')];
      if (!slots.length) return { err: 'the bracket drew no slots' };
      const blank = slots.filter(s => !(s.querySelector('.tname')?.textContent || '').trim());
      if (blank.length) return { err: `${blank.length} of ${slots.length} slots named neither a team nor a route` };
      const untitled = slots.filter(s => !(s.querySelector('.tname')?.title || '').trim());
      if (untitled.length) return { err: `${untitled.length} slots carry no title` };
      /* Half the point of the panel: an undrawn slot says which match fills it
         rather than TBD. Before the draw every slot after round one is wired,
         so a bracket with none of them has lost evtOriginLabel(). */
      const routed = slots.filter(s => /^(Winner|Loser) of /.test(s.querySelector('.tname').textContent.trim()));
      const named = slots.filter(s => !s.querySelector('.tname').classList.contains('tbd'));
      if (!routed.length && !named.length) return { err: 'no slot names a team or a route' };
      return {
        cols: br.querySelectorAll('.bcell').length,
        matches: br.querySelectorAll('.bmatch').length,
        routed: routed.length, named: named.length, slots: slots.length,
        title: document.querySelector('#evtBracketTitle')?.textContent.trim() || '',
      };
    });
    if (r.err) throw new Error(r.err);
    if (r.none) return `no bracket published — "${r.none}"`;
    return `${r.title}: ${r.matches} matches over ${r.cols} columns, ${r.named} teams + ${r.routed} routes in ${r.slots} slots`;
  });

  /* The three fixture boards fall back to the TBD placeholder when the feed has
     nothing, and that fallback is the whole reason the tab can be wired before
     the draw exists. What must never happen is the middle state — a board that
     is neither real rows nor placeholder rows, which is what an exception
     halfway through evtFillList() would leave. */
  await check('event tab: fixture boards', async () => {
    const r = await page.evaluate(() => {
      const read = id => {
        const box = document.querySelector('#' + id);
        if (!box) return null;
        const rows = [...box.querySelectorAll('.nxt')];
        return {
          rows: rows.length,
          tbd: rows.filter(x => x.classList.contains('tbd')).length,
          real: rows.filter(x => !x.classList.contains('tbd') && !x.classList.contains('empty')).length,
        };
      };
      return { next: read('evtNext'), recent: read('evtRecent'),
               live: !!document.querySelector('#evtLive .lc-off, #evtLive .lcard') };
    });
    for (const k of ['next', 'recent']) {
      if (!r[k]) throw new Error(`the ${k} board is not on the page`);
      if (!r[k].rows) throw new Error(`the ${k} board drew no rows at all`);
      if (!r[k].tbd && !r[k].real) throw new Error(`the ${k} board drew ${r[k].rows} rows that are neither fixtures nor placeholders`);
    }
    if (!r.live) throw new Error('the live panel drew neither a card nor an offline state');
    return `next ${r.next.real || r.next.tbd + ' TBD'}, recent ${r.recent.real || r.recent.tbd + ' TBD'}`;
  });
  /* The qualification board is the only thing on that tab with facts in it, and
     it is drawn from a constant the page never fetches: evtQual() returns an
     empty string when EVENT.qual is gone, so the tab would lose it and still
     render, still pass every other check here, and still say nothing. This
     reads the pips back and holds them against the constant that drew them. */
  await check('event tab: qualification board', async () => {
    const r = await page.evaluate(() => {
      const q = typeof EVENT !== 'undefined' ? EVENT.qual : null;
      const rows = [...document.querySelectorAll('.qual-panel .q-rg')];
      if (!q) return { err: 'EVENT.qual is not on the page' };
      if (rows.length !== q.regions.length)
        return { err: `${rows.length} region rows drawn for ${q.regions.length} in the constant` };
      let pips = 0, on = 0;
      for (let i = 0; i < rows.length; i++) {
        const p = rows[i].querySelectorAll('.q-slot');
        if (p.length !== q.regions[i].routes.length)
          return { err: `${q.regions[i].rg} drew ${p.length} slots for ${q.regions[i].routes.length} places` };
        pips += p.length;
        on += rows[i].querySelectorAll('.q-slot.on').length;
      }
      const want = q.regions.reduce((n, x) => n + x.thru.length, 0);
      if (on !== want) return { err: `${on} places drawn as filled, ${want} teams on the board` };

      /* Crests do all the naming on this board, so a filled slot that draws
         nothing is a team with no name at all. An initials fallback counts as
         drawn — that is the offline answer — but an empty box does not. Every
         slot, filled or not, has to say what it is: the words this board does
         not print are the ones a pointer and a screen reader ask for. */
      const badges = [...document.querySelectorAll('.qual-panel .q-slot.on')];
      const blank = badges.filter(b => !b.querySelector('img, .ini'));
      if (blank.length) return { err: `${blank.length} team crest slot(s) drew nothing` };
      const untitled = [...document.querySelectorAll('.qual-panel .q-slot')].filter(b => !b.title.trim());
      if (untitled.length) return { err: `${untitled.length} slot(s) carry no title` };

      /* The seed is the only thing this board prints, so it is the only thing
         a broken caption loses in a way no crest check would notice: a team
         through with no seed under it, or a range drawn where the constant
         says the games have decided. Both render perfectly. */
      const seated = t => {
        if (Number.isInteger(t.seed)) return 1;
        if (Array.isArray(t.seed)) return t.seed.length;
        return 0;   // resolved off the route below, where there is one
      };
      for (let i = 0; i < rows.length; i++) {
        const reg = q.regions[i];
        const caps = [...rows[i].querySelectorAll('.q-slot.on')]
          .map(b => b.parentElement.querySelector('.q-seed'));
        if (caps.some(c => !c || !c.textContent.trim()))
          return { err: `${reg.rg} drew a qualified team with no seed under it` };
        const want = reg.thru.filter(t => {
          const n = seated(t);
          return n === 1 || (n === 0 && reg.routes.some(x => x.via === t.via));
        }).length;
        const set = caps.filter(c => c.classList.contains('set')).length;
        if (set !== want)
          return { err: `${reg.rg} drew ${set} settled seed(s) for ${want} in the constant` };
      }
      const marks = [...document.querySelectorAll('.qual-panel .q-lg')].filter(b => b.querySelector('img, .ini'));
      if (marks.length !== q.regions.length)
        return { err: `${marks.length} league marks drawn for ${q.regions.length} regions` };

      return { pips, on, sub: document.querySelector('.qual-panel .p-sub')?.textContent.trim() || '' };
    });
    if (r.err) throw new Error(r.err);
    if (!r.sub.includes(`${r.on} of ${r.pips}`))
      throw new Error(`the panel's count reads "${r.sub}" against ${r.on} of ${r.pips} slots`);
    return r.sub;
  });

  await check('back to home', async () => {
    await page.click('.fchip[data-f=all]');
    await page.waitForSelector('#page-home.active', { timeout: STEP_MS });
    return 'nav round-trips';
  });

  /* The spoiler guard, on a cold profile — which is the visit it exists for.
     It fails open by nature: a row that loses its `spoil` class renders a
     perfectly good result and throws nothing, so nothing else here would ever
     notice the guard had stopped guarding.

     Three things are checked, because hiding the number alone is not hiding
     the result: the score must not be painted, the loser must not be dimmed,
     and the reveal must not also trip the row's own click handler, which
     expands the series and hands over the same result game by game. */
  await check('home: spoiler guard hides scores', async () => {
    await page.waitForSelector('#recentStrip .nxt', { timeout: STEP_MS });
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#recentStrip .nxt')]
        .filter(x => x.querySelector('.n-sc') && !x.querySelector('.n-sc.tbc'));
      if (!rows.length) return { none: true };
      const hidden = rows.filter(x => x.classList.contains('spoil'));
      if (!hidden.length) return { err: `${rows.length} finished results and none hidden — the guard is off by default` };
      const row = hidden[0];
      const sc = row.querySelector('.n-sc');
      const painted = [...sc.querySelectorAll('span, i')]
        .filter(x => getComputedStyle(x).visibility !== 'hidden');
      if (painted.length) return { err: 'the score is still painted inside a hidden row' };
      if (!row.querySelector('.sp-btn')) return { err: 'a hidden row carries no reveal button' };
      if (getComputedStyle(row.querySelector('.sp-btn')).display === 'none')
        return { err: 'the reveal button is not displayed, so the score cannot be got at' };
      /* The dimming is half the tell. A hidden row must not visually mark
         either side as the loser. */
      const dim = [...row.querySelectorAll('.n-a.lost .n-lg, .n-b.lost .n-lg')]
        .filter(x => Number(getComputedStyle(x).opacity) < 1);
      if (dim.length) return { err: 'a hidden row still dims the loser, which gives the result away' };
      return { rows: rows.length, hidden: hidden.length,
               label: document.querySelector('#spoilBtn')?.textContent.trim() || '' };
    });
    if (r.err) throw new Error(r.err);
    if (r.none) return 'no finished results on the board to hide';
    if (!r.label) throw new Error('the panel has no spoiler toggle');
    return `${r.hidden} of ${r.rows} results hidden · "${r.label}"`;
  });

  await check('home: revealing a score does not open the series', async () => {
    const before = await page.locator('#recentStrip .sdet').count();
    const btn = page.locator('#recentStrip .nxt.spoil .sp-btn').first();
    if (!await btn.count()) return 'skipped — nothing hidden to reveal';
    const stillHidden = await page.locator('#recentStrip .nxt.spoil').count();
    await btn.click();
    await page.waitForTimeout(500);
    /* The row's own handler expands the series. If the reveal click reaches it,
       the guard hands over exactly what it was withholding — this is the check
       that the listener is still in the capture phase. */
    if (await page.locator('#recentStrip .sdet').count() > before)
      throw new Error('revealing a score also expanded the series, handing over the result game by game');
    const after = await page.locator('#recentStrip .nxt.spoil').count();
    if (after !== stillHidden - 1)
      throw new Error(`revealing one row changed the hidden count from ${stillHidden} to ${after}`);
    const shown = await page.locator('#recentStrip .nxt').first().evaluate(() => {
      const row = document.querySelector('#recentStrip .nxt:not(.spoil) .n-sc:not(.tbc)');
      return row ? [...row.querySelectorAll('span')].every(x => getComputedStyle(x).visibility !== 'hidden') : false;
    });
    if (!shown) throw new Error('the revealed row still does not show its score');
    return `one row revealed, ${after} still hidden, series untouched`;
  });

  /* The third row shape, and the one a viewer walks into first: the live card.
     A series score is a result while it is still being played — 1–0 in a Bo5
     hands over game one — and so is the game number beside it, since a Bo5 on
     game 5 is 2–2 without the score being drawn at all. Only checkable while
     something is actually on air, so it skips itself the rest of the time
     rather than failing on an empty panel. */
  await check('live: on-air scores are hidden too', async () => {
    const r = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#homeLive .lcard')]
        .filter(c => c.querySelector('.lc-score:not(.tbc)'));
      if (!cards.length) return { none: true };
      const hidden = cards.filter(c => c.classList.contains('spoil'));
      if (!hidden.length) return { err: `${cards.length} live scores on the board and none hidden` };
      for (const c of hidden) {
        const painted = [...c.querySelectorAll('.lc-score > span')]
          .filter(x => getComputedStyle(x).visibility !== 'hidden');
        if (painted.length) return { err: 'a hidden live card still paints its score' };
        const btn = c.querySelector('.sp-btn');
        if (!btn) return { err: 'a hidden live card carries no reveal button' };
        if (getComputedStyle(btn).display === 'none')
          return { err: 'the live reveal button is not displayed, so the score cannot be got at' };
        const g = c.querySelector('.lc-game');
        if (g && getComputedStyle(g).visibility !== 'hidden')
          return { err: 'a hidden live card still names the game number, which gives a decider away' };
      }
      return { cards: cards.length, hidden: hidden.length };
    });
    if (r.err) throw new Error(r.err);
    if (r.none) return 'nothing on air with a published score';

    /* And it has to open: applySpoil() walks up from the button to its row, and
       a selector that only knows the other two shapes seals every live card
       permanently — which looks exactly like a working guard until you click. */
    await page.locator('#homeLive .lcard.spoil .sp-btn').first().click();
    await page.waitForTimeout(300);
    const after = await page.locator('#homeLive .lcard.spoil').count();
    if (after !== r.hidden - 1)
      throw new Error(`revealing a live card left ${after} hidden, not ${r.hidden - 1} — the card was never unmarked`);
    return `${r.hidden} of ${r.cards} live scores hidden, one revealed`;
  });

  /* The region pages draw a different row (`.match`, not `.nxt`) with a
     different tell: no dimmed crest, but a green diamond beside the winner's
     name that answers the question on its own. Same guard, second shape — and
     the shape is the thing most likely to be missed when either row is next
     edited, which is why it gets its own check rather than being assumed from
     the home board's. */
  await check('region: spoiler guard hides results', async () => {
    await page.click('.tab[data-tab=lck]');
    await page.waitForSelector('#page-lck.active', { timeout: STEP_MS });
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#results-lck .match')];
      if (!rows.length) return { none: true };
      const hidden = rows.filter(x => x.classList.contains('spoil'));
      if (!hidden.length) return { err: `${rows.length} results and none hidden on the region page` };
      for (const row of hidden) {
        const painted = [...row.querySelectorAll('.score > span')]
          .filter(x => getComputedStyle(x).visibility !== 'hidden');
        if (painted.length) return { err: 'a hidden region row still paints its score' };
        const tag = [...row.querySelectorAll('.winner-tag')]
          .filter(x => getComputedStyle(x).visibility !== 'hidden');
        if (tag.length) return { err: 'a hidden region row still shows the winner diamond, which gives the result away' };
        if (!row.querySelector('.sp-btn')) return { err: 'a hidden region row carries no reveal button' };
      }
      return { rows: rows.length, hidden: hidden.length };
    });
    if (r.err) throw new Error(r.err);
    if (r.none) return 'no completed LCK results fetched to hide';

    /* And it has to open. The reveal walks up from the button to its row, and
       the two shapes are found by different selectors — a handler that only
       knows `.nxt` leaves every region row permanently sealed, which looks
       exactly like a working guard until you click one. */
    const before = await page.locator('#results-lck .sdet').count();
    await page.locator('#results-lck .match.spoil .sp-btn').first().click();
    await page.waitForTimeout(500);
    const after = await page.locator('#results-lck .match.spoil').count();
    if (after !== r.hidden - 1)
      throw new Error(`clicking a region row's reveal left ${after} hidden, not ${r.hidden - 1} — the row was never unmarked`);
    if (await page.locator('#results-lck .sdet').count() > before)
      throw new Error('revealing a region score also expanded the series');
    return `${r.hidden} of ${r.rows} region results hidden, one revealed`;
  });

  /* Form and Streak are the two standings columns that are not standings — the
     last five matches and the current run, drawn as pips. A W-L total gives
     away no single game; "L2" says you lost on Tuesday. They are masked rather
     than revealed row by row, which is a second mechanism (`body.spoil-free`
     plus `sp-mask`) and so a second thing that can quietly stop working while
     the score half goes on looking fine. */
  await check('region: form and streak are masked', async () => {
    const r = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('#table-lck .sp-mask')];
      if (!cells.length) return { err: 'the standings table has no maskable form/streak cells' };
      if (!document.body.classList.contains('spoil-free'))
        return { err: 'the page is not in spoiler-free mode by default' };
      const painted = cells.filter(x => getComputedStyle(x).visibility !== 'hidden');
      if (painted.length) return { err: `${painted.length} of ${cells.length} form/streak cells are still painted` };
      /* The mask has to be drawn, not just the content hidden: an empty Form
         column reads as missing data rather than as withheld data. */
      const masked = [...document.querySelectorAll('#table-lck .sp-cell')]
        .filter(c => (c.dataset.mask || '').trim());
      if (masked.length !== cells.length)
        return { err: `${cells.length} hidden cells but ${masked.length} carry a placeholder` };
      return { n: cells.length };
    });
    if (r.err) throw new Error(r.err);
    return `${r.n} form/streak cells masked`;
  });

  /* One switch for the page, in the header. It is a class flip rather than a
     re-render — the only reason it can reach every board at once — so what it
     must actually do is reach them: the region results, the home board and the
     standings columns, all from one click. */
  await check('spoiler switch reaches every board', async () => {
    const count = () => page.evaluate(() => ({
      rows: document.querySelectorAll('#results-lck .match.spoil, #recentStrip .nxt.spoil').length,
      masked: [...document.querySelectorAll('#table-lck .sp-mask')]
        .filter(x => getComputedStyle(x).visibility === 'hidden').length,
    }));
    const before = await count();
    if (!before.rows) throw new Error('no results were hidden before the switch was touched');
    if (!before.masked) throw new Error('no form/streak cells were masked before the switch was touched');
    await page.click('#spoilBtn');
    await page.waitForTimeout(250);
    const off = await count();
    if (off.rows) throw new Error(`${off.rows} rows still hidden after the switch was turned off`);
    if (off.masked) throw new Error(`${off.masked} form/streak cells still masked after the switch was turned off`);
    const label = await page.textContent('#spoilBtn');
    if (!/shown/i.test(label || '')) throw new Error(`the switch still reads "${label}" after being turned off`);
    await page.click('#spoilBtn');
    await page.waitForTimeout(250);
    const back = await count();
    if (back.rows < before.rows) throw new Error(`turning the guard back on hid ${back.rows} rows, not the ${before.rows} it started with`);
    if (back.masked !== before.masked) throw new Error(`turning the guard back on masked ${back.masked} cells, not ${before.masked}`);
    return `${before.rows} rows and ${before.masked} cells, off and on again`;
  });

  if (SHOT) {
    await page.screenshot({ path: SHOT, fullPage: true });
    console.log(`  ..   screenshot written to ${SHOT}`);
  }

  /* ---- the same page on a phone ---- */

  /* The page ships viewport-fit=cover and the full apple-mobile-web-app meta
     set, so a phone is a first-class target rather than an afterthought — but
     every check above this line ran at 1440px, where a table that bursts its
     container has plenty of room to hide. Re-run the nav at 390x844 and look
     for anything sticking out past the viewport.

     Content wider than the screen is not automatically a bug: the standings
     and the bracket are *meant* to scroll inside their own containers. So an
     element only counts if nothing between it and the body scrolls or clips
     horizontally — that is the difference between "scrolls in its box" and
     "drags the whole page sideways". */

  const overflowingAt = () => page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!el.getClientRects().length) continue;              // not rendered
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= vw + 1) continue;

      let p = el.parentElement, contained = false;
      while (p && p !== document.body) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') { contained = true; break; }
        p = p.parentElement;
      }
      if (contained) continue;

      const id = el.id ? `#${el.id}` : el.className && typeof el.className === 'string'
        ? `.${el.className.trim().split(/\s+/)[0]}` : '';
      out.push(`${el.tagName.toLowerCase()}${id} +${Math.round(r.right - vw)}px`);
    }
    return { vw, page: document.documentElement.scrollWidth, out: [...new Set(out)].slice(0, 6) };
  });

  await check('mobile: home fits 390px', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);   // let the layout settle before measuring
    const { vw, page: sw, out } = await overflowingAt();
    if (out.length) throw new Error(`${out.length} element(s) past the ${vw}px viewport: ${out.join(', ')}`);
    if (sw > vw + 1) throw new Error(`the document scrolls sideways: ${sw}px wide in a ${vw}px viewport`);
    return `no horizontal overflow`;
  });

  await check('mobile: league tabs render', async () => {
    const seen = [];
    // the event tab too: it is the widest thing in the strip, being a wordmark
    // rather than three letters, and so the likeliest to drag the nav sideways
    const evt = await page.$eval('.tab-evt', b => b.dataset.tab).catch(() => null);
    for (const slug of evt ? [...LEAGUES, evt] : LEAGUES) {
      await page.click(`.tab[data-tab=${slug}]`);
      await page.waitForSelector(`#page-${slug}.active`, { timeout: STEP_MS });
      await page.waitForTimeout(250);
      const { vw, out } = await overflowingAt();
      if (out.length) throw new Error(`${slug} pushes past the ${vw}px viewport: ${out.join(', ')}`);
      seen.push(slug);
    }
    return `${seen.length} tabs, none overflowing`;
  });

  /* ---- accessibility ---- */

  /* The modals were taught to behave like real dialogs (focus trapping, Escape,
     aria-modal, a labelled heading) and nothing stopped that quietly regressing
     on the next edit. axe catches exactly that class of regression: a dialog
     that loses its label, a control that becomes a bare <div>, an input with no
     accessible name.

     color-contrast is deliberately excluded from what fails the run. Every one
     of its findings traces back to --faint (#6A6A6A) on the near-black panels,
     which lands at ~3.5:1 against the 4.5:1 the rule wants — that is the
     documented lolesports-derived palette in :root doing exactly what it was
     designed to do. Whether to lighten that token is a design decision for a
     human, not something CI should hold the branch hostage over. It is still
     counted and printed on every run so the debt stays visible rather than
     being silently excluded and forgotten. */

  const A11Y_ADVISORY = ['color-contrast'];

  /* .page.active runs a 250ms fade from opacity:0 (see the `fade` keyframes),
     and waitForSelector resolves the moment the class lands — so axe run
     straight after a tab switch measures half-faded text and invents contrast
     failures, a different number of them on every run depending on where in
     the fade it landed. Wait for the page to actually be opaque first. */
  const settled = sel => page.waitForFunction(
    s => { const e = document.querySelector(s); return e && getComputedStyle(e).opacity === '1'; },
    sel, { timeout: STEP_MS });

  async function axeRun() {
    await page.addScriptTag({ path: axePath });
    return page.evaluate(async () => await window.axe.run(document, {
      resultTypes: ['violations'],
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    }));
  }

  const a11ySummary = v => `${v.id} (${v.impact}, ${v.nodes.length} node${v.nodes.length === 1 ? '' : 's'})`;

  if (!axePath) {
    skip('accessibility: no serious violations', 'axe-core is not installed');
  } else {
    await check('accessibility: no serious violations', async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.click('.fchip[data-f=all]');
      await page.waitForSelector('#page-home.active', { timeout: STEP_MS });
      await settled('#page-home');

      const { violations } = await axeRun();
      const blocking = violations.filter(v =>
        ['serious', 'critical'].includes(v.impact) && !A11Y_ADVISORY.includes(v.id));
      const advisory = violations.filter(v => !blocking.includes(v));

      if (blocking.length)
        throw new Error(blocking.map(a11ySummary).join(', '));

      return advisory.length
        ? `clean; ${advisory.length} advisory: ${advisory.map(a11ySummary).join(', ')}`
        : 'clean';
    });

    /* The bracket and standings only exist once a league tab is open, so the
       home sweep above never sees them. */
    await check('accessibility: league tab', async () => {
      await page.click(`.tab[data-tab=${LEAGUES[0]}]`);
      await page.waitForSelector(`#page-${LEAGUES[0]}.active`, { timeout: STEP_MS });
      await settled(`#page-${LEAGUES[0]}`);

      const { violations } = await axeRun();
      const blocking = violations.filter(v =>
        ['serious', 'critical'].includes(v.impact) && !A11Y_ADVISORY.includes(v.id));
      if (blocking.length) throw new Error(blocking.map(a11ySummary).join(', '));
      return `${LEAGUES[0]}: clean`;
    });
  }

  /* ---- the failure path ---- */

  /* Every check above this line proves the page works when the API answers.
     None of them touched the code that runs when it doesn't — the transport
     fallback, the err dot, the cached-data restore, the empty states — which is
     the code most likely to be quietly wrong, because it only ever runs on a
     day when something else is already going wrong.

     This is also the only check in the repo that does not need the network: the
     API is blocked on purpose, so it keeps working during exactly the upstream
     outage that turns the rest of this file red. */

  const API_HOSTS = [
    '**://esports-api.lolesports.com/**',
    '**://feed.lolesports.com/**',
    '**://corsproxy.io/**',
    '**://api.codetabs.com/**',
  ];

  async function offlinePage(context) {
    const p = await context.newPage();
    const threw = [];
    p.on('pageerror', e => threw.push(e.message.split('\n')[0]));
    return { p, threw };
  }
  const blockAPI = p => Promise.all(API_HOSTS.map(h => p.route(h, r => r.abort())));

  /* First visit with the API down: nothing cached, nothing to fall back to.
     This is the case that used to claim it was "showing cached data" while
     rendering empty boards underneath. */
  await check('offline: first visit says there is no data', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const { p, threw } = await offlinePage(ctx);
      await blockAPI(p);
      await p.goto(origin, { waitUntil: 'domcontentloaded', timeout: LOAD_MS });

      await p.waitForSelector('#apiStatus .dot.err', { timeout: LOAD_MS });
      const status = (await p.textContent('#apiStatus'))?.trim() || '';
      if (/cached/i.test(status))
        throw new Error(`claims cached data on a first visit: "${status}"`);

      // the clock must not imply a successful refresh either
      const stamp = (await p.textContent('#lastRefresh'))?.trim() || '';
      if (!/no data/i.test(stamp))
        throw new Error(`#lastRefresh reads "${stamp}", expected it to say there is no data`);

      // and the boards should explain themselves rather than just being blank
      const agenda = (await p.textContent('#homeAgenda'))?.trim() || '';
      if (!/unreachable/i.test(agenda))
        throw new Error('the fixtures board is empty without saying why');

      if (threw.length) throw new Error(`the page threw: ${threw[0]}`);
      return `"${status}"`;
    } finally { await ctx.close(); }
  });

  /* Return visit with the API down: there IS a cache, so the page should say so
     and render it. Seeded by letting one real load succeed first. */
  await check('offline: return visit falls back to cache', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const { p, threw } = await offlinePage(ctx);
      await p.goto(origin, { waitUntil: 'domcontentloaded', timeout: LOAD_MS });
      await p.waitForSelector('#apiStatus .dot.ok', { timeout: LOAD_MS });   // writes schedCache

      // now take the API away and make it refresh
      await blockAPI(p);
      await p.click('#refreshBtn');
      await p.waitForSelector('#apiStatus .dot.err', { timeout: LOAD_MS });

      const status = (await p.textContent('#apiStatus'))?.trim() || '';
      if (!/cached/i.test(status))
        throw new Error(`expected the cached-data message, got "${status}"`);

      // the cache is only worth claiming if it actually rendered something
      const rows = await p.$$eval('#homeAgenda .nxt:not(.empty)', n => n.length);
      if (!rows) throw new Error('says it is showing cached data but the board is empty');

      if (threw.length) throw new Error(`the page threw: ${threw[0]}`);
      return `"${status}", ${rows} row${rows === 1 ? '' : 's'} from cache`;
    } finally { await ctx.close(); }
  });

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
