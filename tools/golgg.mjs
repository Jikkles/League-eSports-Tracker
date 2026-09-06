#!/usr/bin/env node
/*
 * Finds out what gol.gg is currently calling each league's split.
 *
 * Why this exists: tools/drafts.mjs addresses gol.gg by tournament name —
 * "LEC 2026 Summer Season", "LCK 2026 Rounds 3-4" — because that string is the
 * URL. Those names change at every split boundary, and when they do the scrape
 * quietly matches nothing. The old behaviour was to fail with "name probably
 * changed" and leave a human to go and find the new one off a game page title.
 *
 * gol.gg's own tournament picker is backed by a JSON endpoint, which means the
 * new name is discoverable in a single request:
 *
 *   POST /tournament/ajax.trlist.php   {season: 'S16', league: ''}
 *   -> [{ trname, region, nbgames, firstgame, lastgame }, ...]
 *
 * So drafts.mjs discovers the name instead of hardcoding it, and stale.mjs uses
 * the same call to report a boundary the moment it happens.
 *
 *   node tools/golgg.mjs          # print what each tracked league resolves to
 *   node tools/golgg.mjs --all    # dump every tournament in the season
 *
 * One request per run, so it costs gol.gg almost nothing — but it still goes
 * through the same polite User-Agent as the scraper.
 */

import { fileURLToPath } from 'node:url';

const GOLGG = 'https://gol.gg';
const UA = 'LeagueEsportsTracker/1.0 (+https://github.com/Jikkles/League-eSports-Tracker)';

/* gol.gg counts seasons from S1 = 2011, so S16 = 2026. */
export const seasonFor = year => `S${year - 2010}`;

/* The region tag gol.gg files each league under. Guards against "LCK 2026 …"
   also matching a Korean tournament that merely starts with the same word. */
export const REGION_OF = { LEC: 'EUW', LCK: 'KR', LPL: 'CN', LCS: 'NA' };

let cache = new Map();

/* A stalled request is not a failed one. Without a deadline a half-open socket
   — gol.gg going dark mid-handshake, a runner behind a filter that accepts and
   then says nothing — leaves this pending for as long as the OS allows, and
   the caller's only backstop is the workflow's 45-minute timeout. Every other
   tool in this repo already takes an AbortSignal; this was the one that did
   not. Retry the transport errors while we are here, on the same 800ms ladder
   drafts.mjs uses, and stay inside POLITE_MS's spirit by not hammering. */
const TIMEOUT_MS = 20000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function listTournaments(season) {
  if (cache.has(season)) return cache.get(season);
  let res = null, last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`${GOLGG}/tournament/ajax.trlist.php`, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Referer': `${GOLGG}/tournament/list/`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ season, league: '' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      /* 429 and 5xx are worth another go; a 404 is a definite answer. On the
         last attempt we keep the response and let the !res.ok check below
         report it, rather than dressing a real HTTP status as a thrown error. */
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        last = new Error(`HTTP ${res.status}`);
        await sleep(800 * (attempt + 1));
        continue;
      }
      last = null;   // we have a response to speak for itself
      break;
    } catch (e) {
      last = e;
      if (attempt === 2) break;
      await sleep(800 * (attempt + 1));
    }
  }
  /* `last` survives only when every attempt threw — no response to inspect. */
  if (last) throw new Error(`gol.gg tournament list -> ${last.message}`);
  if (!res.ok) throw new Error(`gol.gg tournament list -> HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('gol.gg tournament list did not return an array');
  cache.set(season, rows);
  return rows;
}

/**
 * The tournament gol.gg is currently publishing for this league and year.
 *
 * Matching is deliberately strict at the front — the name must begin with
 * exactly "<LEAGUE> <YEAR>" — because loose matching pulls in the academy
 * leagues: "LCK CL 2026 Rounds 3-4" is a different tournament from "LCK 2026
 * Rounds 3-4" and scraping the wrong one would poison DRAFTS with the wrong
 * games. Among the survivors the live split is simply the one played most
 * recently.
 *
 * Returns { name, row, candidates } or null when nothing matches.
 */
export async function discoverTournament(league, year, { season = seasonFor(year) } = {}) {
  const rows = await listTournaments(season);
  const head = new RegExp(`^${league}\\s+${year}\\b`, 'i');
  const region = REGION_OF[league];

  const candidates = rows
    .filter(r => head.test(String(r.trname || '')))
    .filter(r => !region || !r.region || r.region === region)
    .filter(r => Number(r.nbgames) > 0)
    .sort((a, b) => String(b.lastgame).localeCompare(String(a.lastgame)));

  if (!candidates.length) return null;
  return { name: candidates[0].trname, row: candidates[0], candidates };
}

/* Run directly: show what the tracked leagues resolve to right now. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const year = new Date().getUTCFullYear();
  if (process.argv.includes('--all')) {
    for (const r of await listTournaments(seasonFor(year)))
      console.log(`  ${String(r.trname).padEnd(34)} ${String(r.region).padEnd(4)} ${r.nbgames} games  ${r.firstgame} → ${r.lastgame}`);
  } else {
    console.log(`season ${seasonFor(year)} (${year})\n`);
    for (const league of Object.keys(REGION_OF)) {
      const hit = await discoverTournament(league, year);
      console.log(hit
        ? `  ${league.padEnd(4)} ${hit.name}  (last game ${hit.row.lastgame}, ${hit.row.nbgames} games)`
        : `  ${league.padEnd(4)} nothing found`);
    }
  }
}
