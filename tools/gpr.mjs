#!/usr/bin/env node
/*
 * Rebuilds POWER_RANKINGS / POWER_RANKINGS_ASOF inside index.html from
 * lolesports.com's official Global Power Rankings.
 *
 * Why this exists: the rankings board on the home tab is a mirror of Riot's
 * GPR, and it was mirrored by hand. A hand-mirrored board goes stale in a way
 * nothing on the page notices — every check stays green while the home tab
 * advertises a top ten from three weeks ago — so stale.mjs had to nag about it
 * on a timer. This removes the nagging by doing the mirroring.
 *
 *   node tools/gpr.mjs             # update index.html in place
 *   node tools/gpr.mjs --dry-run   # report what would change, write nothing
 *   node tools/gpr.mjs --top 10    # how many teams the board carries (default 10)
 *   node tools/gpr.mjs --year 2026 # override the season (default: this year,
 *                                    falling back to last year in January)
 *
 * The board is not fetched at runtime for two reasons. lolesports.com is a
 * Next.js page, not an API — the rankings arrive as 2 MB of server-rendered
 * React payload, which is not something to make a phone download — and its
 * GraphQL endpoint (/api/gql) refuses freeform queries, accepting only
 * persisted operation IDs that change with every deploy of their site. So this
 * bakes the numbers in ahead of time, exactly as tools/drafts.mjs does for
 * gol.gg, and the page stays a single offline-capable file.
 *
 * Where the numbers come from, field by field:
 *
 *   pts   currentTeamGPR.gprScore   — the score the board itself prints
 *   wl    teamMatchRecord           — matches, not games; this is the "46-10"
 *                                     the GPR table shows beside the score
 *   move  teamGPRHistory            — rank change against the most recent
 *                                     published board at least MOVE_DAYS older
 *                                     than the current one. Riot's own
 *                                     `previousTeamGPR` is the day before,
 *                                     which is flat for ~90% of teams and makes
 *                                     the arrow column say nothing; the history
 *                                     is published roughly every ten days and
 *                                     reproduces the movement the board has
 *                                     been carrying by hand.
 *   t     /getTeams by team id      — Riot spells the same team differently in
 *                                     different places, and the page matches
 *                                     rankings to fixtures by name (isTop10,
 *                                     and the simulator's rating base). Taking
 *                                     the name from the team-list API — the
 *                                     same spelling the schedule feed uses —
 *                                     is what keeps that match working. The
 *                                     hand-mirrored board had 'Gen.G' where
 *                                     every feed says 'Gen.G Esports', so
 *                                     Gen.G's games were never marked a top-10
 *                                     clash and the simulator rated them off
 *                                     the fallback.
 *
 * No dependencies, no build step. Plain node 18+ for global fetch.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, '..', 'index.html');

const SITE = 'https://lolesports.com';
const API = 'https://esports-api.lolesports.com/persisted/gw';
const API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const UA = 'LeagueEsportsTracker-gpr/1.0 (+https://github.com/Jikkles/League-eSports-Tracker)';

const MOVE_DAYS = 7;             // window the ▲/▼ column measures over
const TIMEOUT_MS = 30000;
const RETRIES = 3;

const arg = name => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const DRY = process.argv.includes('--dry-run');
const TOP = Number(arg('--top') || 10);
const YEAR_ARG = arg('--year');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, opts = {}) {
  for (let i = 0; i < RETRIES; i++) {
    /* An explicit controller rather than AbortSignal.timeout, so the timer is
       always cleared: a pending one keeps the loop alive after the work is done. */
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, {
        ...opts,
        signal: ctl.signal,
        headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      });
    } catch (e) {
      if (i === RETRIES - 1) throw e;
      await sleep(900 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ---- reading the rankings out of the page ---------------------------------
   The GPR page is a Next.js app that ships its Apollo cache inline, so the
   whole board is already in the HTML: one `"teamGPR":[ ... ]` array pushed into
   the SSR data transport. Rather than regex the numbers out of the rendered
   table — which is a wall of generated class names and would break on any
   restyle — find that key and bracket-match to the end of its array, which
   gives back the real JSON Riot's own client renders from.

   The scan tracks string literals so a brace or bracket inside a team name
   ("Anyone's Legend" is fine; something with a bracket in it one day would not
   be) cannot throw the depth count off. */
function sliceJSONArray(html, key) {
  const at = html.indexOf(key);
  if (at === -1) return null;
  const start = at + key.length - 1;         // the '[' itself
  let depth = 0, inStr = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

async function fetchBoard(year) {
  const url = `${SITE}/en-GB/gpr/${year}/current`;
  const res = await get(url);
  if (res.status === 404) return null;       // that season has no board yet
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const html = await res.text();

  const raw = sliceJSONArray(html, '"teamGPR":[');
  if (!raw)
    throw new Error(`No teamGPR payload in ${url} — the page's data transport has moved.`);

  let teams;
  try { teams = JSON.parse(raw); }
  catch (e) { throw new Error(`teamGPR payload did not parse as JSON: ${e.message}`); }
  if (!Array.isArray(teams) || !teams.length)
    throw new Error(`teamGPR payload is empty in ${url}.`);
  return teams;
}

/* ---- the canonical spelling of each team ---------------------------------- */
async function fetchTeams() {
  const url = new URL(API + '/getTeams');
  url.searchParams.set('hl', 'en-GB');
  const res = await get(url, { headers: { 'x-api-key': API_KEY } });
  if (!res.ok) throw new Error(`/getTeams -> HTTP ${res.status}`);
  const data = await res.json();
  const byId = new Map();
  for (const t of data?.data?.teams || []) if (t.id) byId.set(String(t.id), t);
  return byId;
}

/* ---- rendering the constant ----------------------------------------------- */

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/* Matches the format the constant has always carried ("16 Aug 2026") and, more
   to the point, one Date.parse understands — check.mjs rejects anything else. */
const asOfLabel = iso => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/* JS string literal with single quotes, which is what the file already uses;
   only the quote and the backslash need escaping in a one-line literal. */
const q = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function renderBlock(rows, asOf) {
  const wt = Math.max(...rows.map(r => q(r.t).length + 1));
  const wr = Math.max(...rows.map(r => q(r.r).length + 1));
  const ww = Math.max(...rows.map(r => q(r.wl).length + 1));
  const lines = rows.map(r =>
    `  {t:${(q(r.t) + ',').padEnd(wt)} r:${(q(r.r) + ',').padEnd(wr)} ` +
    `pts:${r.pts}, wl:${(q(r.wl) + ',').padEnd(ww)} move:${r.move}}`
  );
  return [
    '/* GPR:generated */',
    "/* Mirror of lolesports.com's official Global Power Rankings, scraped by",
    '   tools/gpr.mjs and refreshed daily by .github/workflows/gpr.yml. The ▲/▼',
    `   column is the rank change over the last ${MOVE_DAYS} days. Do not edit by hand —`,
    '   the whole block is rewritten. */',
    `const POWER_RANKINGS_ASOF = ${q(asOf)};`,
    'const POWER_RANKINGS = [',
    lines.join(',\n'),
    '];',
    '/* GPR:end */',
  ].join('\n');
}

/* ---- main ------------------------------------------------------------------ */

async function main() {
  const thisYear = new Date().getUTCFullYear();
  const years = YEAR_ARG ? [Number(YEAR_ARG)] : [thisYear, thisYear - 1];

  let teams = null, year = null;
  for (const [i, y] of years.entries()) {
    teams = await fetchBoard(y);
    if (teams) { year = y; break; }
    const next = years[i + 1];
    console.log(next ? `  no GPR board published for ${y} yet; trying ${next}`
                     : `  no GPR board published for ${y}`);
  }
  if (!teams) throw new Error(`No GPR board found for ${years.join(' or ')}.`);

  const ranked = teams
    .filter(t => t?.currentTeamGPR && typeof t.currentTeamGPR.rank === 'number')
    .sort((a, b) => a.currentTeamGPR.rank - b.currentTeamGPR.rank);
  if (ranked.length < TOP)
    throw new Error(`GPR ${year} lists only ${ranked.length} ranked teams; need ${TOP}.`);

  const asOfISO = ranked[0].currentTeamGPR.dateCalculated;
  console.log(`  GPR ${year}: ${ranked.length} teams, calculated ${asOfISO}`);

  /* A name the schedule feed does not use is a name the page cannot match a
     fixture to, so the team list is worth the extra request — but it is not
     worth failing over, since the GPR payload carries a usable name of its own. */
  let byId = new Map();
  try { byId = await fetchTeams(); }
  catch (e) { console.log(`  /getTeams unavailable (${e.message}); using the GPR spellings`); }

  const rows = ranked.slice(0, TOP).map(t => {
    const known = byId.get(String(t.team?.id));
    const name = known?.name || t.team?.name;
    if (!name) throw new Error(`Ranked team #${t.currentTeamGPR.rank} has no name.`);

    const region = known?.homeLeague?.name || t.team?.homeLeague?.name || '';

    const rec = t.teamMatchRecord;
    if (typeof rec?.wins !== 'number' || typeof rec?.losses !== 'number')
      throw new Error(`${name} has no match record in the GPR payload.`);

    /* Movement over MOVE_DAYS: the most recent published board at least that
       old. History runs newest-first and includes today, hence the date test
       rather than an index. A team new to the board has nothing to compare
       against and is flat rather than invented. */
    const now = Date.parse(t.currentTeamGPR.dateCalculated);
    const then = (t.teamGPRHistory || [])
      .find(h => now - Date.parse(h.dateCalculated) >= MOVE_DAYS * 864e5);

    return {
      t: name,
      r: region,
      pts: t.currentTeamGPR.gprScore,
      wl: `${rec.wins}-${rec.losses}`,
      move: then ? then.rank - t.currentTeamGPR.rank : 0,
    };
  });

  for (const r of rows)
    if (typeof r.pts !== 'number') throw new Error(`${r.t} has no gprScore.`);

  const html = readFileSync(INDEX, 'utf8');
  const startMark = html.indexOf('/* GPR:generated */');
  const endMark = html.indexOf('/* GPR:end */');
  if (startMark === -1 || endMark === -1 || endMark < startMark)
    throw new Error('The GPR:generated / GPR:end markers are missing from index.html.');

  const before = html.slice(startMark, endMark + '/* GPR:end */'.length);
  const after = renderBlock(rows, asOfLabel(asOfISO));

  rows.forEach((r, i) => {
    const mv = r.move > 0 ? `+${r.move}` : String(r.move);
    console.log(`  ${String(i + 1).padStart(2)}. ${r.t.padEnd(22)} ${String(r.r).padEnd(5)} ${r.pts}  ${r.wl.padEnd(7)} ${mv}`);
  });

  if (before === after) { console.log('\nBoard unchanged; nothing to write.'); return; }
  if (DRY) { console.log('\n--dry-run: would rewrite the GPR block.'); return; }

  writeFileSync(INDEX, html.slice(0, startMark) + after + html.slice(endMark + '/* GPR:end */'.length));
  console.log('\nRewrote the GPR block in index.html.');
}

main().catch(e => { console.error(`gpr.mjs: ${e.message}`); process.exitCode = 1; });
