#!/usr/bin/env node
/*
 * Link-rot check for the URLs baked into index.html.
 *
 * Why this exists: REGIONS carries a wiki, Liquipedia, stream and VOD link for
 * every region, and every HONOURS entry carries two more. They are hand-written
 * against wikis that rename their pages every single split — LEC/2026/Spring
 * becomes LEC/2026/Summer, LCK_Cup_2026 quietly turns into LCK/2026_Season/Cup —
 * and a renamed page is invisible from inside this repo. stale.mjs looks at the
 * *year* in those URLs (a 2025 link on a 2026 page), which catches the annual
 * rollover and nothing else: a link naming the right year and the wrong split
 * reads as perfectly current right up until a user clicks it and lands on a
 * 404. Nothing else in the repo ever fetches them.
 *
 * So: resolve every baked-in link, once a week, and say which no longer go
 * anywhere.
 *
 *   node tools/links.mjs                 # human-readable, exit 1 on a dead link
 *   node tools/links.mjs --report out.md # also write a markdown report
 *   node tools/links.mjs --verbose       # list the links that are fine too
 *
 * Two severities, following stale.mjs, because they want different reactions:
 *
 *   DEAD — the target does not exist. Fails the run, opens the issue.
 *   NOTE — worth a look but not broken: the page was renamed and the old title
 *          still redirects, or the host refused to answer so nothing was
 *          actually proven. Rides along; never fails the run on its own.
 *
 * Both wikis (Liquipedia and Leaguepedia/Fandom) return 403 to a plain fetch of
 * an article, whatever method or User-Agent you send, so pinging those URLs the
 * way a naive link checker would proves nothing at all. Both do answer their
 * MediaWiki api.php with a descriptive User-Agent, which is the sanctioned
 * route and a strictly better one: it separates "no such page" from "page was
 * renamed and your link now redirects", and it takes ONE request per host for
 * every title rather than one per link. Don't swap it for a browser User-Agent
 * against the article URLs — that is evading a block rather than using the
 * door, and Liquipedia in particular is a small volunteer-run site.
 *
 * Everything else (YouTube, Twitch, CHZZK, Bilibili) is checked with a plain
 * HEAD, falling back to GET for hosts that refuse HEAD outright.
 *
 * No dependencies, no build step. Plain node 18+ for global fetch.
 */

import { writeFileSync } from 'node:fs';
import { readDataConstants } from './constants.mjs';

const UA = 'LeagueEsportsTracker-links/1.0 (+https://github.com/Jikkles/League-eSports-Tracker)';

const TIMEOUT_MS = 20000;
const RETRIES = 3;
const POLITE_MS = 1500;   // between calls to one host; see the note above

const arg = name => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const reportPath = arg('--report');
const VERBOSE = process.argv.includes('--verbose');

const findings = [];
const dead = (where, url, what, fix) => findings.push({ level: 'DEAD', where, url, what, fix });
const note = (where, url, what, fix) => findings.push({ level: 'NOTE', where, url, what, fix });
const fine = (where, url, what)      => findings.push({ level: 'ok',   where, url, what });

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- collect every URL the constants carry ------------------------------- */

/* Walked rather than read field by field: the link fields have grown before
   (vods arrived after wiki/liqui) and a new one should be covered the day it
   lands, not the day someone remembers this file exists. */
function collectURLs(value, path, into) {
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) {
      const url = value.trim();
      if (!into.has(url)) into.set(url, []);
      into.get(url).push(path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectURLs(v, path + '[' + i + ']', into));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectURLs(v, path + '.' + k, into);
  }
}

const C = readDataConstants();
const urls = new Map();   // url -> [path, ...]
for (const name of ['REGIONS', 'EVENT', 'HONOURS', 'STORYLINES', 'POWER_RANKINGS']) {
  if (C[name] !== undefined) collectURLs(C[name], name, urls);
}

if (!urls.size) {
  console.log('No links found in the baked-in constants — which is itself suspicious.');
  process.exitCode = 1;
}

/* The shortest unambiguous label for where a link lives, for the report. */
const label = paths => paths.length === 1 ? paths[0] : `${paths[0]} (+${paths.length - 1} more)`;

/* ---- wiki links, through each wiki's MediaWiki API ----------------------- */

/* Both wikis put the article title straight in the path, so the title is what
   follows the wiki root. Anything carrying a query string is not an article
   link and falls through to the plain HTTP check below. */
function wikiTarget(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.search) return null;

  if (u.hostname === 'lol.fandom.com') {
    const m = u.pathname.match(/^\/wiki\/(.+)$/);
    return m && { api: 'https://lol.fandom.com/api.php', wiki: 'Leaguepedia', title: decodeURIComponent(m[1]) };
  }
  if (u.hostname === 'liquipedia.net') {
    const m = u.pathname.match(/^\/([^/]+)\/(.+)$/);
    if (!m || m[2] === 'api.php') return null;
    return { api: `https://liquipedia.net/${m[1]}/api.php`, wiki: 'Liquipedia', title: decodeURIComponent(m[2]) };
  }
  return null;
}

async function fetchRetry(url, init) {
  let lastErr;
  for (let i = 0; i < RETRIES; i++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      lastErr = e;
      if (i < RETRIES - 1) await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

/* One call per API for up to 50 titles, which is the whole point of going
   through the API — 30-odd Liquipedia links cost a single request. */
async function resolveWiki(api, titles) {
  const out = new Map();   // requested title -> { missing, invalid, redirectedTo }

  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const u = new URL(api);
    u.searchParams.set('action', 'query');
    u.searchParams.set('format', 'json');
    u.searchParams.set('formatversion', '2');
    u.searchParams.set('redirects', '1');
    u.searchParams.set('titles', batch.join('|'));

    if (i) await sleep(POLITE_MS);
    const res = await fetchRetry(u, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(api).hostname}`);
    const j = await res.json();
    const q = j?.query;
    if (!q) throw new Error('the API answered without a query block');

    /* MediaWiki answers about the *normalised*, *redirect-followed* title, so
       walk the chains it reports to get from what we asked for to what it
       answered about. */
    const normalised = new Map();
    for (const n of q.normalized || []) normalised.set(n.from, n.to);
    const redirect = new Map();
    for (const r of q.redirects || []) redirect.set(r.from, r.to);

    const pages = new Map();
    for (const p of q.pages || []) pages.set(p.title, p);

    for (const asked of batch) {
      const norm = normalised.get(asked) ?? asked;
      const target = redirect.get(norm) ?? norm;
      const page = pages.get(target);
      out.set(asked, {
        missing: !page || page.missing === true,
        invalid: !!page?.invalid,
        redirectedTo: redirect.has(norm) ? target : null,
      });
    }
  }
  return out;
}

/* Group the wiki links by API so each host is asked once. */
const byAPI = new Map();
const plainHTTP = [];
for (const [url, paths] of urls) {
  const t = wikiTarget(url);
  // a title carrying the API's own separator can't ride in a batch; check it as a URL
  if (t && !t.title.includes('|')) {
    if (!byAPI.has(t.api)) byAPI.set(t.api, { wiki: t.wiki, items: [] });
    byAPI.get(t.api).items.push({ url, paths, title: t.title });
  } else {
    plainHTTP.push({ url, paths });
  }
}

for (const [api, { wiki, items }] of byAPI) {
  const titles = [...new Set(items.map(i => i.title))];
  let resolved;
  try {
    resolved = await resolveWiki(api, titles);
  } catch (e) {
    // Couldn't ask, so nothing was proven. Calling these dead would be a lie.
    note(wiki, api, `Could not be reached (${e.message}), so ${items.length} link${items.length > 1 ? 's were' : ' was'} not checked.`,
      `Most likely transient. If it persists, check whether ${new URL(api).hostname} has changed its API rules.`);
    continue;
  }

  for (const { url, paths, title } of items) {
    const r = resolved.get(title);
    if (!r || r.invalid) {
      dead(label(paths), url, `${wiki} rejects "${title}" as a malformed title.`,
        'Fix the URL in index.html.');
    } else if (r.missing) {
      dead(label(paths), url, `${wiki} has no page called "${title}".`,
        `Find the current page on ${new URL(url).hostname} and update the link.`);
    } else if (r.redirectedTo) {
      note(label(paths), url, `Renamed: "${title}" now redirects to "${r.redirectedTo}".`,
        'Still works, but the link is out of date — point it at the new title.');
    } else {
      fine(label(paths), url, `${wiki}: "${title}"`);
    }
  }
  await sleep(POLITE_MS);
}

/* ---- everything else, over plain HTTP ------------------------------------ */

const lastHit = new Map();
async function politely(host) {
  const wait = POLITE_MS - (Date.now() - (lastHit.get(host) || 0));
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

for (const { url, paths } of plainHTTP) {
  const host = (() => { try { return new URL(url).hostname; } catch { return null; } })();
  if (!host) { dead(label(paths), url, 'Not a valid URL.', 'Fix it in index.html.'); continue; }

  await politely(host);
  let res;
  try {
    res = await fetchRetry(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': UA } });
    // plenty of hosts serve the page fine and simply refuse HEAD
    if (res.status === 405 || res.status === 501) {
      await politely(host);
      res = await fetchRetry(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': UA } });
    }
  } catch (e) {
    note(label(paths), url, `Request failed (${e.message}).`,
      'Usually the network rather than the link; confirm by opening it.');
    continue;
  }

  if (res.status === 404 || res.status === 410) {
    dead(label(paths), url, `${host} returns ${res.status}.`, 'Find the current URL and update it.');
  } else if (res.status === 403 || res.status === 429) {
    // A bot block says nothing about whether the page exists.
    note(label(paths), url, `${host} returns ${res.status} to an automated request, so this was not verified.`,
      'Expected from some hosts. Open it by hand if you want certainty.');
  } else if (!res.ok) {
    note(label(paths), url, `${host} returns ${res.status}.`,
      'Probably transient; worth a look if it repeats next week.');
  } else {
    fine(label(paths), url, `${res.status}`);
  }
}

/* ---- report -------------------------------------------------------------- */

const deads = findings.filter(f => f.level === 'DEAD');
const notes = findings.filter(f => f.level === 'NOTE');
const oks = findings.filter(f => f.level === 'ok');
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

for (const f of findings) {
  if (f.level === 'ok') { if (VERBOSE) console.log(`  ok   ${f.where} — ${f.what}`); continue; }
  console.log(`  ${f.level === 'DEAD' ? 'DEAD' : 'note'} ${f.where} — ${f.what}\n       ${f.url}\n       ${f.fix}`);
}
console.log(`\n${urls.size} link${urls.size === 1 ? '' : 's'} checked, ${oks.length} fine.`);
console.log(deads.length
  ? `${deads.length} dead${notes.length ? `, plus ${notes.length} worth a look` : ''}.`
  : `Nothing is dead${notes.length ? `, but ${notes.length} thing${notes.length > 1 ? 's are' : ' is'} worth a look` : ''}.`);

if (reportPath) {
  const rows = list => list.map(f => `| \`${f.where}\` | [${f.url.replace(/^https?:\/\//, '')}](${f.url}) | ${f.what} | ${f.fix} |`);
  const head = [`| where | link | what | fix |`, `|---|---|---|---|`];
  const lines = [
    `Links baked into [index.html](../blob/main/index.html) no longer go where they claim.`,
    ``,
    `They are hand-written against wikis that rename a page every split, and nothing about the page breaks when one dies — it keeps rendering a link that 404s when a user clicks it. **Checked ${stamp}: ${urls.size} links, ${oks.length} fine.**`,
    ``,
  ];
  if (deads.length) lines.push(`## Dead`, ``, ...head, ...rows(deads), ``);
  if (notes.length) {
    lines.push(`## Worth a look`, ``,
      `Renames that still redirect, and hosts that refused to answer. These do not fail the run on their own.`, ``,
      ...head, ...rows(notes), ``);
  }
  lines.push(
    `Reproduce locally with \`node tools/links.mjs\`.`, ``,
    `<sub>Posted by [links.yml](../blob/main/.github/workflows/links.yml). Updated in place on each run, and closed automatically once every link resolves again.</sub>`,
  );
  writeFileSync(reportPath, lines.join('\n'));
}

// Set the code rather than calling process.exit(): exiting while a rejected
// fetch's socket is still closing trips a libuv assertion on Windows.
process.exitCode = deads.length ? 1 : 0;
