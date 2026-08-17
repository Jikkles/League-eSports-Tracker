#!/usr/bin/env node
/*
 * Canary for the unofficial LoL Esports API the page depends on.
 *
 * Why this exists: every live thing on the page — schedules, live games,
 * standings, team logos, match detail — comes from esports-api.lolesports.com,
 * an unofficial endpoint reached with a public key lifted from Riot's own web
 * client. Nobody promises us that key keeps working or that the payload shapes
 * hold. When either changes the page does not throw a visible error; it just
 * quietly renders empty tables, and the first you hear of it is noticing a
 * blank standings tab days later.
 *
 * So this walks the same call sequence the page walks, in the same order, with
 * the same fallbacks, and asserts the shapes the render code actually reads.
 * It runs daily and opens a GitHub issue when something has moved.
 *
 *   node tools/api-canary.mjs                 # human-readable, exit 1 on failure
 *   node tools/api-canary.mjs --report out.md # also write a markdown report
 *
 * Deliberately NOT failures, because they are normal:
 *   - getLive returning zero events (nothing is on air right now)
 *   - a league between splits having no current tournament (falls back to the
 *     most recent one, exactly as the page does)
 *
 * No dependencies, no build step. Plain node 18+ for global fetch.
 */

import { writeFileSync } from 'node:fs';

const API = 'https://esports-api.lolesports.com/persisted/gw';
const API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const HL = 'en-GB';
const UA = 'LeagueEsportsTracker-canary/1.0 (+https://github.com/Jikkles/League-eSports-Tracker)';

const SLUGS = ['lec', 'lck', 'lpl', 'lcs'];
const TIMEOUT_MS = 20000;
const RETRIES = 3;              // transient flakiness shouldn't wake anyone up

const reportPath = process.argv.includes('--report')
  ? process.argv[process.argv.indexOf('--report') + 1] : null;

const results = [];
const ok = (name, note) => results.push({ name, ok: true, note });
const bad = (name, why) => results.push({ name, ok: false, why });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiJSON(path, params = {}) {
  const url = new URL(API + path);
  url.searchParams.set('hl', HL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let lastErr;
  for (let i = 0; i < RETRIES; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'x-api-key': API_KEY, 'User-Agent': UA },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // an auth rejection is a definite answer, not flakiness — don't retry it
      if (res.status === 403 || res.status === 401)
        return Promise.reject(Object.assign(
          new Error(`HTTP ${res.status} — the public API key has probably been rotated`),
          { fatal: true }));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      if (i < RETRIES - 1) await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

/* Every check is wrapped so one endpoint moving doesn't hide the state of the
   others — we want the whole picture in a single issue, not the first failure. */
async function check(name, fn) {
  try {
    ok(name, await fn());
  } catch (e) {
    bad(name, e.message);
  }
}

/* ---- getLeagues: the page's entry point, resolves every league id ------- */

let leagueIds = {};

await check('getLeagues', async () => {
  const data = await apiJSON('/getLeagues');
  const leagues = data?.data?.leagues;
  if (!Array.isArray(leagues) || !leagues.length) throw new Error('data.leagues is not a non-empty array');

  for (const lg of leagues) {
    const slug = String(lg.slug || '').toLowerCase();
    if (SLUGS.includes(slug)) leagueIds[slug] = lg.id;
  }
  const missing = SLUGS.filter(s => !leagueIds[s]);
  if (missing.length) throw new Error(`no league returned for slug${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);

  const noImage = leagues.filter(l => SLUGS.includes(String(l.slug).toLowerCase()) && !l.image)
                         .map(l => l.slug);
  if (noImage.length) throw new Error(`league logo missing for: ${noImage.join(', ')}`);

  return `${leagues.length} leagues, all four tracked slugs resolved`;
});

/* Without ids there is nothing else to test — say so once and stop. */
if (Object.keys(leagueIds).length !== SLUGS.length) {
  bad('everything downstream', 'skipped — league ids could not be resolved');
} else {

  /* ---- getSchedule: one call per league ---------------------------------- */

  for (const slug of SLUGS) {
    await check(`getSchedule (${slug})`, async () => {
      const data = await apiJSON('/getSchedule', { leagueId: leagueIds[slug] });
      const events = data?.data?.schedule?.events;
      if (!Array.isArray(events)) throw new Error('data.schedule.events is not an array');
      if (!events.length) throw new Error('zero events returned');

      const withMatch = events.filter(e => e.match);
      if (!withMatch.length) throw new Error('no event carries a .match');

      // structural shape, checked on the latest match whatever its state
      const last = withMatch[withMatch.length - 1];
      if (!last.startTime || !last.state) throw new Error('event is missing startTime/state');
      if (!Array.isArray(last.match.teams) || last.match.teams.length !== 2)
        throw new Error(`match.teams has ${last.match.teams?.length ?? 'no'} entries, expected 2`);

      // Scores and records only exist once a match has a real fixture — unplayed
      // playoff and qualifier slots are TBD placeholders with result/record null,
      // which the page renders as empty rows on purpose. Assert the fields the
      // scoreboard reads against a match that has actually been played.
      const done = withMatch.filter(e => e.state === 'completed');
      if (!done.length) return `${events.length} events, none completed yet (shape only)`;

      for (const t of done[done.length - 1].match.teams) {
        if (!t.name || !t.code) throw new Error('a team is missing name/code');
        if (!t.result || typeof t.result.gameWins !== 'number')
          throw new Error('team.result.gameWins is missing or not a number on a completed match');
        if (!t.record || typeof t.record.wins !== 'number')
          throw new Error('team.record.wins is missing or not a number on a completed match');
      }
      // the page pages backwards through history with this token
      if (!('older' in (data.data.schedule.pages || {})))
        throw new Error('schedule.pages.older is gone — history paging would break');

      return `${events.length} events, ${done.length} completed`;
    });
  }

  /* ---- getTournamentsForLeague + getStandingsV3 -------------------------- */

  for (const slug of SLUGS) {
    await check(`getStandings (${slug})`, async () => {
      const tData = await apiJSON('/getTournamentsForLeague', { leagueId: leagueIds[slug] });
      const tours = tData?.data?.leagues?.[0]?.tournaments;
      if (!Array.isArray(tours) || !tours.length) throw new Error('no tournaments returned');

      // resolve the current tournament exactly the way the page does
      const now = Date.now();
      let cur = tours.find(t => Date.parse(t.startDate) <= now && now <= Date.parse(t.endDate) + 86400e3);
      let live = true;
      if (!cur) {
        live = false;
        cur = tours.filter(t => Date.parse(t.startDate) <= now)
                   .sort((a, b) => Date.parse(b.startDate) - Date.parse(a.startDate))[0];
      }
      if (!cur) throw new Error('could not resolve a current or most-recent tournament');

      // the page tries V3 and falls back to the older endpoint
      let sData, used = 'getStandingsV3';
      try {
        sData = await apiJSON('/getStandingsV3', { tournamentId: cur.id });
      } catch (e) {
        used = 'getStandings (V3 fallback)';
        sData = await apiJSON('/getStandings', { tournamentId: cur.id });
      }

      const standings = sData?.data?.standings;
      if (!Array.isArray(standings) || !standings.length) throw new Error('data.standings is empty');

      // count unique teams across the fattest stage, as the render code does
      let best = 0;
      for (const s of standings)
        for (const stage of s.stages || []) {
          const seen = new Set();
          for (const sec of stage.sections || [])
            for (const rk of sec.rankings || [])
              for (const t of rk.teams || []) {
                seen.add(t.id || t.name);
                if (!t.record || typeof t.record.wins !== 'number' || typeof t.record.losses !== 'number')
                  throw new Error(`${t.name || 'a team'} has no usable record {wins,losses}`);
              }
          best = Math.max(best, seen.size);
        }
      if (best < 4) throw new Error(`only ${best} teams found across every stage — the table would render near-empty`);

      return `${cur.slug} · ${best} teams · ${used}${live ? '' : ' · between splits, using most recent'}`;
    });
  }

  /* ---- getLive ----------------------------------------------------------- */

  await check('getLive', async () => {
    const data = await apiJSON('/getLive');
    const events = data?.data?.schedule?.events;
    if (!Array.isArray(events)) throw new Error('data.schedule.events is not an array');
    // an empty list is normal — it just means nothing is on air
    for (const e of events) {
      if (!e.id && !e.match?.id) throw new Error('a live event carries no id to match against the schedule');
    }
    return events.length ? `${events.length} game(s) on air` : 'nothing on air (normal)';
  });

  /* ---- getEventDetails: the game-by-game boards -------------------------- */

  await check('getEventDetails', async () => {
    const data = await apiJSON('/getSchedule', { leagueId: leagueIds.lec });
    const done = (data?.data?.schedule?.events || []).filter(e => e.state === 'completed' && e.match);
    if (!done.length) return 'skipped — no completed LEC match in the current schedule page';

    const id = done[done.length - 1].match.id;
    const ev = (await apiJSON('/getEventDetails', { id }))?.data?.event;
    if (!ev) throw new Error('data.event is missing');
    const games = ev.match?.games;
    if (!Array.isArray(games) || !games.length) throw new Error('match.games is empty');
    for (const g of games) {
      if (!g.id || !g.state || typeof g.number !== 'number')
        throw new Error('a game is missing id/state/number');
    }
    if (!ev.league || !ev.tournament) throw new Error('event is missing league/tournament');

    return `match ${id} · ${games.length} games`;
  });
}

/* ---- report ------------------------------------------------------------- */

const failed = results.filter(r => !r.ok);
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

for (const r of results) {
  console.log(r.ok ? `  ok   ${r.name}${r.note ? ` — ${r.note}` : ''}`
                   : `  FAIL ${r.name} — ${r.why}`);
}
console.log(failed.length
  ? `\n${failed.length} of ${results.length} checks failed.`
  : `\nAll ${results.length} checks passed.`);

if (reportPath) {
  const lines = [
    `The daily canary found the LoL Esports API no longer behaving the way [index.html](../blob/main/index.html) expects.`,
    ``,
    `Everything live on the page comes from this API, and when it moves the page renders empty rather than erroring — so this needs a look.`,
    ``,
    `**Checked ${stamp}**`,
    ``,
    `| | check | detail |`,
    `|---|---|---|`,
    ...results.map(r => `| ${r.ok ? '✅' : '❌'} | \`${r.name}\` | ${r.ok ? (r.note || '') : r.why} |`),
    ``,
    `Reproduce locally with \`node tools/api-canary.mjs\`.`,
    ``,
    `<sub>Posted by [api-canary.yml](../blob/main/.github/workflows/api-canary.yml). This issue is updated in place on each run and closed automatically once the API comes back.</sub>`,
  ];
  writeFileSync(reportPath, lines.join('\n'));
}

// Set the code rather than calling process.exit(): exiting while a rejected
// fetch's socket is still closing trips a libuv assertion on Windows.
process.exitCode = failed.length ? 1 : 0;
