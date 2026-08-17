#!/usr/bin/env node
/*
 * Rebuilds the DRAFTS constant inside index.html.
 *
 * Why this exists: the LoL Esports API publishes no pick/ban order, and about
 * one completed game in a hundred is missing from its live-stats feed entirely
 * (204, no content, at any timestamp). gol.gg has both, but sends no CORS
 * headers, so the page can never fetch it — the data has to be baked in ahead
 * of time. That is this script's whole job.
 *
 * It is incremental: games already recorded are skipped, so a daily run costs a
 * handful of requests rather than several hundred. Scope is the current split
 * only, matching how the rest of the tracker thinks and keeping index.html to a
 * sane size.
 *
 *   node tools/drafts.mjs            # update index.html in place
 *   node tools/drafts.mjs --dry-run  # report what would change, write nothing
 *
 * No dependencies, no build step. Plain node 18+ for global fetch.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, '..', 'index.html');

const API = 'https://esports-api.lolesports.com/persisted/gw';
const API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const FEED = 'https://feed.lolesports.com/livestats/v1';
const GOLGG = 'https://gol.gg';
const UA = 'LeagueEsportsTracker/1.0 (+https://github.com/Jikkles/League-eSports-Tracker)';

const DRY = process.argv.includes('--dry-run');
const POLITE_MS = 1100;          // gol.gg is a small Patreon-funded site; don't hammer it
const MAX_NEW_GAMES = 400;       // a runaway run shouldn't scrape the whole site

/* gol.gg names its tournaments its own way. If one of these stops matching, the
   run fails loudly rather than quietly writing nothing. */
const LEAGUES = {
  lec: { id: '98767991302996019', golgg: 'LEC 2026 Summer Season' },
  lck: { id: '98767991310872058', golgg: 'LCK 2026 Rounds 3-4' },
  lpl: { id: '98767991314006698', golgg: 'LPL 2026 Split 3' },
  lcs: { id: '98767991299243165', golgg: 'LCS 2026 Summer' },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const nk = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const day = d => new Date(d).toISOString().slice(0, 10);

async function get(url, opts = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
      return res;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
}
async function apiJSON(path, params = {}) {
  const url = new URL(API + path);
  url.searchParams.set('hl', 'en-GB');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await get(url, { headers: { 'x-api-key': API_KEY } });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

/* ---- team-name matching between the two sources ---------------------------
   They disagree about city prefixes ("Xi'an Team WE" / "Team WE"), sponsor
   suffixes ("Cloud9 Kia" / "Cloud9") and, in one case, the whole name. */
const ALIAS = { beijingjdgesports: 'jdgaming', jdgaming: 'beijingjdgesports' };
const core = s => nk(s)
  .replace(/^(xian|beijing|shenzhen|suzhou|shanghai|hangzhou|wuhan|chengdu|ninjasin)/, '')
  .replace(/(esports|gaming|alienware|kia|team)$/, '');
function sameTeam(a, b) {
  const A = nk(a), B = nk(b);
  if (!A || !B) return false;
  if (A === B) return true;
  if (ALIAS[A] === B || ALIAS[B] === A) return true;
  if (A.length >= 3 && B.length >= 3 && (A.includes(B) || B.includes(A))) return true;
  const ca = core(a), cb = core(b);
  return ca.length >= 3 && cb.length >= 3 && (ca === cb || ca.includes(cb) || cb.includes(ca));
}

/* ---- gol.gg scraping ------------------------------------------------------ */
async function golggMatchlist(tournament) {
  const res = await get(`${GOLGG}/tournament/tournament-matchlist/${encodeURIComponent(tournament)}/`);
  const html = await res.text();
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => strip(c[1]));
    const id = (m[1].match(/href='\.\.\/game\/stats\/(\d+)\//) || [])[1];
    return id ? { id, winner: cells[1], score: cells[2], loser: cells[3], date: cells[6] } : null;
  }).filter(x => x && x.score && x.score !== '-');
}

/* the summary page's nav lists every game in the series, in order */
async function golggGameIds(seriesId) {
  const res = await get(`${GOLGG}/game/stats/${seriesId}/page-summary/`);
  const html = await res.text();
  const ids = [...html.matchAll(/game\/stats\/(\d+)\/page-game\/'\s+title='[^']*'>Game (\d+)</g)]
    .map(m => ({ id: m[1], number: +m[2] }))
    .sort((a, b) => a.number - b.number);
  return ids;
}

/* bans come out as Data Dragon keys (the icon filenames), which is exactly what
   the page needs to draw them. Row one belongs to blue side, row two to red —
   cross-checked against the live-stats feed's own blue team on every game that
   has one, so a silent flip would show up as a mismatch. */
async function golggGame(gameId) {
  const res = await get(`${GOLGG}/game/stats/${gameId}/page-game/`);
  if (!res.ok) return null;
  const html = await res.text();
  const banRows = [...html.matchAll(/<div class="col-2">Bans<\/div>\s*<div class="col-10">([\s\S]*?)<\/div>/g)]
    .map(m => [...m[1].matchAll(/champions_icon\/([^.'"]+)\.png/g)].map(x => x[1]));
  if (banRows.length < 2) return null;
  const blueTeam = (html.match(/blueGoldData[\s\S]{0,400}?label:\s*'([^']+)'/) || [])[1] || '';
  // the last ten icons on the page are the picks in role order: blue TOP..SUP,
  // then red TOP..SUP, which lines up with the full-stats player columns
  const icons = [...html.matchAll(/champions_icon\/([^.'"]+)\.png/g)].map(m => m[1]);
  const picks = icons.slice(-10);
  return { bans: [banRows[0], banRows[1]], blueTeam, picks: picks.length === 10 ? picks : null };
}

async function golggFullStats(gameId) {
  const res = await get(`${GOLGG}/game/stats/${gameId}/page-fullstats/`);
  if (!res.ok) return null;
  const html = await res.text();
  const rows = {};
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => strip(c[1]));
    if (cells.length >= 11 && cells[0]) rows[cells[0].toLowerCase()] = cells.slice(1, 11);
  }
  if (!rows['player']) return null;
  const num = (k, i) => { const v = (rows[k] || [])[i]; const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
  return Array.from({ length: 10 }, (_, i) => ({
    name: rows['player'][i] || '',
    role: (rows['role'] || [])[i] || '',
    level: num('level', i), k: num('kills', i), d: num('deaths', i), a: num('assists', i),
    cs: num('cs', i), gold: num('golds', i),
  }));
}

/* ---- does Riot's own feed carry this game? -------------------------------- */
async function feedHasGame(gameId, startIso) {
  const t = Math.min(Date.parse(startIso) + 12 * 3600e3, Date.now() - 180e3);
  const stamp = new Date(Math.floor(t / 10000) * 10000).toISOString().replace(/\.\d+Z$/, 'Z');
  try {
    const res = await get(`${FEED}/window/${gameId}?startingTime=${stamp}`);
    if (res.status !== 200) return { ok: false, blue: null };
    const j = await res.json();
    return { ok: true, blue: j?.gameMetadata?.blueTeamMetadata?.esportsTeamId || null };
  } catch { return { ok: false, blue: null }; }
}

/* ---- the DRAFTS constant in index.html ------------------------------------ */
const START = '/* DRAFTS:generated */';
const END = '/* DRAFTS:end */';

function readExisting(html) {
  const i = html.indexOf(START), j = html.indexOf(END);
  if (i < 0 || j < 0) return {};
  const body = html.slice(i + START.length, j);
  const m = body.match(/const DRAFTS = (\{[\s\S]*\});/);
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch { return {}; }
}

function render(drafts) {
  const keys = Object.keys(drafts).sort();
  const lines = keys.map(k => JSON.stringify(k) + ':' + JSON.stringify(drafts[k]));
  return `${START}
/* Picks/bans and, for the handful of games missing from Riot's live-stats feed,
   full scoreboards — scraped from gol.gg by tools/drafts.mjs and refreshed by
   .github/workflows/drafts.yml. Current split only. Do not edit by hand. */
const DRAFTS = {
${lines.join(',\n')}
};
${END}`;
}

/* ---- main ----------------------------------------------------------------- */
(async () => {
  const html = readFileSync(INDEX, 'utf8');
  if (!html.includes(START)) {
    console.error(`index.html has no ${START} marker — add it before running this.`);
    process.exit(1);
  }
  const drafts = readExisting(html);
  const before = Object.keys(drafts).length;
  console.log(`existing entries: ${before}`);

  let added = 0, fullAdded = 0, budget = MAX_NEW_GAMES;
  const problems = [];

  for (const [slug, cfg] of Object.entries(LEAGUES)) {
    // the split we care about is whatever tournament is running now
    let since = Date.now() - 60 * 86400e3;
    try {
      const tours = (await apiJSON('/getTournamentsForLeague', { leagueId: cfg.id })).data?.leagues?.[0]?.tournaments || [];
      const now = Date.now();
      const cur = tours.find(t => Date.parse(t.startDate) <= now && now <= Date.parse(t.endDate) + 86400e3);
      if (cur?.startDate) since = Date.parse(cur.startDate);
    } catch (e) { problems.push(`${slug}: tournament lookup failed (${e.message})`); }

    const sched = await apiJSON('/getSchedule', { leagueId: cfg.id });
    const events = (sched.data.schedule.events || []).filter(e =>
      e.state === 'completed' && Date.parse(e.startTime) >= since &&
      (e.match?.teams || []).some(t => t.result?.outcome === 'win'));

    const list = await golggMatchlist(cfg.golgg);
    await sleep(POLITE_MS);
    if (!list.length) { problems.push(`${slug}: gol.gg tournament "${cfg.golgg}" returned no played matches — name probably changed`); continue; }

    let matched = 0, missed = 0;
    for (const ev of events) {
      if (budget <= 0) break;
      const [t1, t2] = ev.match.teams.map(t => t.name);
      const cands = list
        .filter(c => Math.abs(Date.parse(c.date) - Date.parse(day(ev.startTime))) <= 36 * 3600e3)
        .filter(c => (sameTeam(c.winner, t1) && sameTeam(c.loser, t2)) || (sameTeam(c.winner, t2) && sameTeam(c.loser, t1)));
      if (cands.length !== 1) { missed++; continue; }
      matched++;

      const detail = await apiJSON('/getEventDetails', { id: ev.match.id });
      const riotGames = (detail.data?.event?.match?.games || []).filter(g => g.state === 'completed');
      if (!riotGames.length) continue;
      // nothing to do if every game of this series is already recorded
      if (riotGames.every(g => drafts[g.id])) continue;

      const ggGames = await golggGameIds(cands[0].id);
      await sleep(POLITE_MS);
      if (ggGames.length < riotGames.length) { problems.push(`${slug} ${day(ev.startTime)} ${t1} v ${t2}: gol.gg lists ${ggGames.length} games, Riot ${riotGames.length}`); continue; }

      const teams = detail.data?.event?.match?.teams || [];
      for (const rg of riotGames) {
        if (drafts[rg.id] || budget <= 0) continue;
        const gg = ggGames.find(g => g.number === rg.number);
        if (!gg) continue;

        const page = await golggGame(gg.id);
        await sleep(POLITE_MS);
        budget--;
        if (!page) { problems.push(`${slug} game ${rg.id}: gol.gg page unparseable`); continue; }

        const entry = { b: page.bans[0].join(',') + '|' + page.bans[1].join(',') };

        // cross-check the blue/red assumption against Riot's own metadata
        const feed = await feedHasGame(rg.id, ev.startTime);
        if (feed.ok && feed.blue) {
          const riotBlue = teams.find(t => t.id === feed.blue);
          if (riotBlue && page.blueTeam && !sameTeam(riotBlue.name, page.blueTeam))
            problems.push(`${slug} game ${rg.id}: side mismatch — feed says blue=${riotBlue.name}, gol.gg says ${page.blueTeam}`);
        }

        // only the games Riot lost need the whole scoreboard carried here
        if (!feed.ok) {
          const stats = await golggFullStats(gg.id);
          await sleep(POLITE_MS);
          if (stats && page.picks) {
            const side = (off) => {
              const p = stats.slice(off, off + 5).map((s, i) => [s.name, page.picks[off + i], s.role, s.k, s.d, s.a, s.level, s.cs, s.gold]);
              return { k: p.reduce((n, r) => n + r[3], 0), g: p.reduce((n, r) => n + r[8], 0), p };
            };
            const blueName = page.blueTeam;
            const redName = (teams.find(t => !sameTeam(t.name, blueName)) || {}).name || '';
            entry.x = { bt: blueName, rt: redName, b: side(0), r: side(5) };
            fullAdded++;
          } else {
            problems.push(`${slug} game ${rg.id}: missing from Riot's feed and gol.gg full stats unparseable`);
          }
        }
        drafts[rg.id] = entry;
        added++;
      }
    }
    console.log(`${slug}: ${events.length} series, matched ${matched}, unmatched ${missed}`);
  }

  console.log(`\nnew games: ${added} (${fullAdded} with full scoreboards)  total: ${Object.keys(drafts).length}`);
  if (problems.length) {
    console.log('\nproblems:');
    problems.forEach(p => console.log('  ' + p));
  }
  if (DRY) { console.log('\n--dry-run: index.html untouched'); return; }
  if (!added) { console.log('nothing new; index.html untouched'); return; }

  const i = html.indexOf(START), j = html.indexOf(END) + END.length;
  writeFileSync(INDEX, html.slice(0, i) + render(drafts) + html.slice(j));
  console.log('index.html updated');
})().catch(e => { console.error(e); process.exit(1); });
