#!/usr/bin/env node
/*
 * Staleness canary for the baked-in data in index.html.
 *
 * Why this exists: the repo already knows whether the page *parses*
 * (check.mjs), whether the API *answers* (api-canary.mjs) and whether the page
 * *renders* (smoke.mjs). Nothing had an opinion about whether the data baked
 * into it is still *true*. REGIONS, POWER_RANKINGS, HONOURS and the playoff
 * cuts are hand-maintained constants describing a season that moves every week,
 * and every one of them goes stale silently — a split rolls over, the page
 * carries on rendering last split's label against this split's games, and the
 * only way anyone finds out is by looking.
 *
 * So this compares what the file claims against what the live API and gol.gg
 * actually say, and raises one issue when they have drifted apart.
 *
 *   node tools/stale.mjs                 # human-readable, exit 1 if stale
 *   node tools/stale.mjs --report out.md # also write a markdown report
 *   node tools/stale.mjs --max-age 21    # days before POWER_RANKINGS is stale
 *
 * Two severities, because they want different reactions:
 *
 *   STALE — the file is provably out of date. Fails the run, opens the issue.
 *   NOTE  — worth a look, but a judgement call, and too fuzzy to wake anyone
 *           up for. Rides along in the report; never fails the run on its own.
 *
 * Every check is one-sided wherever a mid-split reading could look like a
 * mismatch: a team having played *fewer* games than the format says is just
 * Tuesday, so only an overshoot is reported. False alarms train you to ignore
 * the thing, which would defeat the point.
 *
 * No dependencies, no build step. Plain node 18+ for global fetch.
 */

import { writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { readDataConstants, extractConstants, extractFunctions } from './constants.mjs';
import { discoverTournament } from './golgg.mjs';
import { LEAGUES } from './drafts.mjs';

const API = 'https://esports-api.lolesports.com/persisted/gw';
const API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const HL = 'en-GB';
const UA = 'LeagueEsportsTracker-stale/1.0 (+https://github.com/Jikkles/League-eSports-Tracker)';

const TIMEOUT_MS = 20000;
const RETRIES = 3;

const arg = name => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const reportPath = arg('--report');
const MAX_AGE_DAYS = Number(arg('--max-age') || 21);

/* Same normalisation the page uses to match group names (see cutsFor in
   index.html) — this check is only meaningful if it agrees with the renderer. */
const nk = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const findings = [];
/* `evidence` is the lines a finding can quote from a feed — the games behind
   it, in the words the API used. A check that says what is wrong sends you
   researching; one that also says what the feed already knows turns the patch
   into a lookup. Optional, because most checks have nothing to quote. */
const stale = (area, what, fix, evidence) => findings.push({ level: 'STALE', area, what, fix, evidence });
const note  = (area, what, fix, evidence) => findings.push({ level: 'NOTE',  area, what, fix, evidence });
const fine  = (area, what)                => findings.push({ level: 'ok',    area, what });

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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < RETRIES - 1) await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

const C = readDataConstants();
if (C.missing.length) {
  console.error(`Could not read ${C.missing.join(', ')} from index.html — run node tools/check.mjs first.`);
  process.exit(1);
}
const { REGIONS, EVENT, HONOURS, POWER_RANKINGS, POWER_RANKINGS_ASOF } = C;
const NOW = Date.now();
const YEAR = new Date(NOW).getUTCFullYear();

/* ---- POWER_RANKINGS freshness -------------------------------------------
   The board is rebuilt nightly by tools/gpr.mjs, so this is no longer a nudge
   to go and mirror it by hand — it is the backstop for that job having quietly
   stopped. gpr.yml raises its own issue when a run *fails*; what it cannot see
   is a run that succeeds against a board Riot has stopped publishing, which is
   what this catches. */

const asOf = Date.parse(POWER_RANKINGS_ASOF);
if (Number.isNaN(asOf)) {
  stale('POWER_RANKINGS', `POWER_RANKINGS_ASOF ("${POWER_RANKINGS_ASOF}") does not parse as a date.`,
        'tools/gpr.mjs writes this from the dateCalculated on the board itself; a value it cannot have written means the block was edited by hand.');
} else {
  const age = Math.floor((NOW - asOf) / 86400e3);
  if (age > MAX_AGE_DAYS)
    stale('POWER_RANKINGS', `The rankings mirror is ${age} days old (as of ${POWER_RANKINGS_ASOF}).`,
          'Run `node tools/gpr.mjs --dry-run`. If it reports the same date, lolesports.com has stopped publishing a current board and the home tab should say so; if it reports a newer one, the nightly gpr.yml run is not landing.');
  else fine('POWER_RANKINGS', `mirror is ${age} day${age === 1 ? '' : 's'} old`);
}

/* ---- EVENT: the tab pointed at the next international event -------------- */

/* Nothing on that page is fetched, so nothing about it can go wrong loudly:
   once the event it names has been played, the tab sits there advertising a
   finished tournament with TBD in every row, and every other check in this repo
   stays green. This is the only thing that will ever say so. */
if (EVENT) {
  const ends = Date.parse(EVENT.end);
  const starts = Date.parse(EVENT.start);
  if (Number.isNaN(ends)) {
    stale('EVENT', `EVENT.end ("${EVENT.end}") does not parse as a date.`,
          'It is what tells this check whether the tab still points at something upcoming.');
  } else if (NOW > ends) {
    const days = Math.floor((NOW - ends) / 86400e3);
    stale('EVENT', `${EVENT.name} finished ${days} day${days === 1 ? '' : 's'} ago (${EVENT.end}).`,
          'Roll the EVENT constant on to the next international event — and with it the nav button\'s data-tab and the section id, which check.mjs holds to the slug.');
  } else if (!Number.isNaN(starts) && NOW > starts) {
    /* Naming the stage makes the note actionable rather than a standing
       complaint: "Swiss, and the page still says TBD" points at the window a
       reader can check, where "under way" only repeats what EVENT.when says.
       check.mjs has already held these dates to the event around them, so the
       stage named here is the one the strip is drawing. */
    const on = (EVENT.stages || []).find(st => st.from && st.to
      && NOW >= Date.parse(st.from) && NOW <= Date.parse(st.to) + 86400e3);
    note('EVENT', `${EVENT.name} is under way (${EVENT.when})${on ? ` — ${on.name} stage, ${on.when}` : ''} and its page is still the TBD placeholder.`,
         'Wire the page to the feed, or say on it that the results live on the league tabs.');
  } else {
    const days = Math.ceil((starts - NOW) / 86400e3);
    const next = (EVENT.stages || []).find(st => st.from);
    fine('EVENT', `${EVENT.name} is ${days} day${days === 1 ? '' : 's'} away${next ? ` (${next.name} ${next.when})` : ''}`);
  }
}

/* Every league the API knows, not just the four with a season on the page:
   the qualification board below reaches into the LCP and the CBLOL, which have
   no REGIONS entry and so were being dropped here. Callers below index it by a
   REGIONS slug, and extra keys cost them nothing. */
let leagueIds = {};
try {
  const leagues = (await apiJSON('/getLeagues'))?.data?.leagues || [];
  for (const lg of leagues) leagueIds[String(lg.slug || '').toLowerCase()] = lg.id;
} catch (e) {
  console.error(`getLeagues failed (${e.message}) — the API canary is the place to look, not this.`);
  process.exit(1);
}

/* ---- EVENT.qual: the qualification board --------------------------------- */

/* The board is the one part of that tab with facts on it, and it rots on a
   schedule it carries itself: every place names the date it is settled. Once
   that date has passed and the place is still empty, the page is showing an
   open route to a game that has been played — which nothing else here would
   notice, because no feed is behind it. The dates come from Leaguepedia's
   participants table; the fix is always to patch EVENT.qual against it. */
if (EVENT && EVENT.qual && Array.isArray(EVENT.qual.regions)) {
  const SOON_DAYS = 7;
  const day = iso => new Date(iso).toLocaleDateString('en-GB', {day:'numeric', month:'short', timeZone:'UTC'});
  let filled = 0, places = 0, soon = [];

  /* The board cannot be fetched — Riot publishes no qualification feed, which
     is the whole reason it is hand-patched. The *results* that settle it can
     be: they are in the same schedule endpoint the page already reads, and it
     serves all six of these leagues rather than only the four with a season
     here. So a place this check calls stale can also name the game that
     settled it and who won, which is the difference between "go and find out"
     and "copy this in". It cannot say which route a result fills — that is the
     rulebook's business, not the feed's — so it quotes and does not conclude. */
  const DECIDES_RX = /final|playoff|knockout|qualifier|regional|grand/i;
  const EVIDENCE_MAX = 5, WINDOW_DAYS = 45;

  const resultLine = e => {
    const [x, y] = e.match?.teams || [];
    if (!x || !y) return null;
    const wx = x.result?.gameWins ?? 0, wy = y.result?.gameWins ?? 0;
    const [w, l, ws, ls] = wx >= wy ? [x, y, wx, wy] : [y, x, wy, wx];
    return `${day(e.startTime)} \u00B7 ${e.blockName || 'match'} \u00B7 ${w.name} ${ws}\u2013${ls} ${l.name}`;
  };

  /* Completed knockout games in that league since the earliest date at issue,
     newest first. A region whose slug the API does not know, or a fetch that
     fails, simply reports without evidence — this is a courtesy, never a
     check of its own, and it must not turn a real finding into a crash. */
  const decided = async (slug, since) => {
    const id = leagueIds[String(slug || '').toLowerCase()];
    if (!id) return [];
    const from = Math.max(since, NOW - WINDOW_DAYS * 86400e3);
    let events = [];
    try { events = await scheduleSince(id, from); } catch { return []; }
    return events
      .filter(e => e.state === 'completed' && DECIDES_RX.test(e.blockName || '')
                && Date.parse(e.startTime) >= from)
      .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))
      .map(resultLine).filter(Boolean).slice(0, EVIDENCE_MAX);
  };

  for (const r of EVENT.qual.regions) {
    const routes = r.routes || [], thru = r.thru || [];
    places += routes.length; filled += thru.length;

    /* Dates rather than routes: which place a team ends up holding is often
       drawn later than the place is won, so the honest question is how many
       of this region's places should be settled by now. */
    const due = routes.filter(x => Date.parse(x.on) < NOW);
    if (due.length > thru.length) {
      const last = due.map(x => x.on).sort().pop();
      stale('EVENT.qual', `${r.rg}: ${due.length} of its ${routes.length} places were settled by ${day(last)}, but only ${thru.length} team${thru.length === 1 ? ' is' : 's are'} on the board.`,
            `Patch EVENT.qual.regions[].thru for ${r.rg} from the participants table on ${EVENT.wiki}. The ${r.lg} results since then:`,
            await decided(r.slug, Math.min(...due.map(x => Date.parse(x.on)))));
    }

    /* A team can be through before its seed is drawn, and the board says so —
       it prints the range rather than a number. What decides that range is the
       places inside it, so once every one of those has passed its date the
       draw has happened and a range still sitting there is one nobody wrote
       down. The count check above cannot see it: the region is full and its
       arithmetic is perfectly happy. */
    const seedsOf = t => {
      if (Number.isInteger(t.seed)) return [t.seed];
      if (Array.isArray(t.seed) && t.seed.length) return [...t.seed].sort((a, b) => a - b);
      const k = routes.findIndex(x => x.via === t.via);
      return k >= 0 ? [k + 1] : routes.map((_, i) => i + 1);
    };
    const undrawn = thru.filter(t => {
      const seats = seedsOf(t);
      return seats.length > 1 && seats.every(n => routes[n - 1] && Date.parse(routes[n - 1].on) < NOW);
    });
    if (undrawn.length) {
      const dates = undrawn.flatMap(t => seedsOf(t).map(n => Date.parse(routes[n - 1].on)));
      const last = undrawn.flatMap(t => seedsOf(t).map(n => routes[n - 1].on)).sort().pop();
      stale('EVENT.qual', `${r.rg}: every place open to ${undrawn.map(t => t.team).join(' and ')} was settled by ${day(last)}, but the board ${undrawn.length === 1 ? 'still draws it' : 'still draws them'} across a range of seeds.`,
            `Write the seed each of them took into EVENT.qual.regions[].thru, from the participants table on ${EVENT.wiki}. The ${r.lg} results that decided it:`,
            await decided(r.slug, Math.min(...dates)));
    }

    for (const x of routes) {
      const d = Math.ceil((Date.parse(x.on) - NOW) / 86400e3);
      if (d >= 0 && d <= SOON_DAYS) soon.push(`${x.via} (${day(x.on)})`);
    }
  }

  if (filled === places)
    note('EVENT.qual', `All ${places} places are filled.`,
         'The board has said everything it can say — the tab now wants the draw and the fixtures rather than the qualification panel.');
  else
    fine('EVENT.qual', `${filled} of ${places} places filled`);

  if (soon.length)
    note('EVENT.qual', `Settled within ${SOON_DAYS} days: ${soon.join(', ')}.`,
         'Worth a patch once they are played — this check will start calling them stale the day after.');
}

/* ---- per-league checks --------------------------------------------------- */

const apiTeamNames = new Set();
const toursBySlug = {};

for (const [slug, R] of Object.entries(REGIONS)) {
  const id = leagueIds[slug] || LEAGUES[slug]?.id;
  if (!id) { note(R.name, 'The API returned no league with this slug.', 'Check api-canary output.'); continue; }

  /* -- which tournament is actually running -------------------------------- */
  let cur = null;
  try {
    const tours = (await apiJSON('/getTournamentsForLeague', { leagueId: id }))?.data?.leagues?.[0]?.tournaments || [];
    toursBySlug[slug] = tours;
    cur = tours.find(t => Date.parse(t.startDate) <= NOW && NOW <= Date.parse(t.endDate) + 86400e3);
    if (!cur) {
      // between splits is a normal state, not a fault — but the label should
      // not be advertising a split that has finished either
      const last = tours.filter(t => Date.parse(t.startDate) <= NOW)
                        .sort((a, b) => Date.parse(b.endDate) - Date.parse(a.endDate))[0];
      if (last) note(R.name, `No tournament is running; the most recent was \`${last.slug}\`, which ended ${String(last.endDate).slice(0, 10)}.`,
                     `splitLabel still reads "${R.splitLabel}" — check it is still the split you want shown.`);
      continue;
    }
  } catch (e) {
    note(R.name, `Tournament lookup failed (${e.message}).`, 'Transient, or a job for the API canary.');
    continue;
  }

  /* -- splitLabel vs that tournament --------------------------------------- */
  const tourSlug = String(cur.slug || '');
  const labelYear = (String(R.splitLabel).match(/\b(20\d{2})\b/) || [])[1];
  const tourYear = (tourSlug.match(/\b(20\d{2})\b/) || [])[1]
    || String(new Date(Date.parse(cur.startDate)).getUTCFullYear());

  if (labelYear && tourYear && labelYear !== tourYear) {
    stale(R.name, `splitLabel says "${R.splitLabel}" but the running tournament is \`${tourSlug}\` (${tourYear}).`,
          `Update REGIONS.${slug}.splitLabel, and the wiki/liqui links with it.`);
  } else {
    /* Riot slugs every split as `<league>_split_<n>_<year>` regardless of what
       the split is actually called, so comparing words against a human label
       ("Summer 2026", "Rounds 3–4 2026") flags three leagues out of four every
       single run. A permanent false alarm is worse than no alarm, so the only
       thing compared is the split ordinal, and only when the label states one. */
    const labelSplit = (String(R.splitLabel).match(/\bsplit\s*(\d+)/i) || [])[1];
    const tourSplit = (tourSlug.match(/split[_-]?(\d+)/i) || [])[1];
    if (labelSplit && tourSplit && labelSplit !== tourSplit)
      stale(R.name, `splitLabel says split ${labelSplit} but the running tournament is \`${tourSlug}\` (split ${tourSplit}).`,
            `Update REGIONS.${slug}.splitLabel.`);
    else fine(R.name, `splitLabel "${R.splitLabel}" consistent with \`${tourSlug}\``);
  }

  /* A split that has just begun is the moment every other baked-in constant for
     this league — the label, the game count, the playoff format, the wiki links
     — is most likely to be wrong, and the one moment nothing else would say so. */
  const daysIn = Math.floor((NOW - Date.parse(cur.startDate)) / 86400e3);
  if (daysIn >= 0 && daysIn <= 10)
    note(R.name, `A new split (\`${tourSlug}\`) started ${daysIn === 0 ? 'today' : `${daysIn} day${daysIn === 1 ? '' : 's'} ago`}.`,
         `Re-check REGIONS.${slug}: splitLabel, defaultGames, defFormat, the cuts and the wiki/liqui links. A --prune run will clear the previous split out of DRAFTS.`);

  /* -- the wiki/liqui links should point at this season -------------------- */
  for (const field of ['wiki', 'liqui']) {
    const url = R[field];
    const inUrl = (String(url).match(/\b(20\d{2})\b/) || [])[1];
    if (inUrl && tourYear && inUrl !== tourYear)
      note(R.name, `\`${field}\` still links to the ${inUrl} season page.`,
           `Point REGIONS.${slug}.${field} at ${tourYear}.`);
  }

  /* -- standings: team count, group names, games per team ------------------ */
  let standings = null;
  try {
    standings = (await apiJSON('/getStandingsV3', { tournamentId: cur.id }))?.data?.standings;
  } catch {
    try { standings = (await apiJSON('/getStandings', { tournamentId: cur.id }))?.data?.standings; } catch {}
  }
  if (!Array.isArray(standings) || !standings.length) {
    note(R.name, 'Standings came back empty, so the format checks were skipped.', 'The API canary covers this endpoint.');
    continue;
  }

  // the regular season is the stage carrying the most teams; playoff stages are
  // smaller, and counting them would make every format look wrong come playoffs
  let stage = null, stageTeams = 0;
  for (const s of standings)
    for (const st of s.stages || []) {
      const n = new Set((st.sections || []).flatMap(sec =>
        (sec.rankings || []).flatMap(rk => (rk.teams || []).map(t => t.id || t.name)))).size;
      if (n > stageTeams) { stageTeams = n; stage = st; }
    }
  if (!stage) { note(R.name, 'No stage carried any teams.', 'The API canary covers this endpoint.'); continue; }

  const sections = (stage.sections || []).map(s => s.name).filter(Boolean);
  const allTeams = (stage.sections || []).flatMap(sec =>
    (sec.rankings || []).flatMap(rk => rk.teams || []));
  for (const t of allTeams) if (t.name) apiTeamNames.add(t.name);

  /* Games per team: only an overshoot means anything mid-split.
     Two wrinkles, both of them REGIONS fields the page reads:
       - groupGames, where a league's groups are different sizes and so play
         different seasons (LPL Ascend 14, Nirvana 6). Comparing every group
         against one number reports the small group as an overshoot or lets a
         real one through, so each group is measured against its own.
       - tableSpans, where the league's regular season is filed as more than
         one tournament (the LCK's four rounds). This payload only holds the
         latest one, so the games already played in the earlier tournaments
         have to be added back before the count means anything. */
  const spanned = [];
  if ((R.tableSpans || 1) > 1) {
    let earlier = cur;
    const allTours = toursBySlug[slug] || [];
    for (let back = 1; back < R.tableSpans; back++) {
      const prev = allTours.filter(t => Date.parse(t.startDate) < Date.parse(earlier.startDate))
                        .sort((a, b) => Date.parse(b.startDate) - Date.parse(a.startDate))[0];
      if (!prev) break;
      let ps = null;
      try { ps = (await apiJSON('/getStandingsV3', { tournamentId: prev.id }))?.data?.standings; }
      catch { try { ps = (await apiJSON('/getStandings', { tournamentId: prev.id }))?.data?.standings; } catch {} }
      if (!ps) break;
      let pst = null, pn = 0;
      for (const x of ps) for (const st of x.stages || []) {
        const n = new Set((st.sections || []).flatMap(sec =>
          (sec.rankings || []).flatMap(rk => (rk.teams || []).map(t => t.id || t.name)))).size;
        if (n > pn) { pn = n; pst = st; }
      }
      if (!pst) break;
      const by = {};
      for (const sec of pst.sections || []) for (const rk of sec.rankings || [])
        for (const t of rk.teams || [])
          by[nk(t.name)] = (t.record ? (t.record.wins || 0) + (t.record.losses || 0) : 0);
      spanned.push(by);
      earlier = prev;
    }
    if (spanned.length < R.tableSpans - 1)
      note(R.name, `tableSpans is ${R.tableSpans} but only ${spanned.length + 1} tournament table(s) could be read.`,
           `The page falls back to ranking on the games it can see. Check REGIONS.${slug}.tableSpans still matches how the league files its season.`);
  }
  const carried = name => spanned.reduce((sum, by) => sum + (by[nk(name)] || 0), 0);

  const gamesFor = gname => {
    if (R.groupGames) {
      const k = nk(gname || '');
      if (k) for (const [key, n] of Object.entries(R.groupGames)) if (k.includes(key)) return n;
    }
    return R.defaultGames;
  };
  let worst = null;
  for (const sec of stage.sections || []) {
    const want = gamesFor(sec.name || '');
    for (const rk of sec.rankings || []) for (const t of rk.teams || []) {
      const n = (t.record ? (t.record.wins || 0) + (t.record.losses || 0) : 0) + carried(t.name);
      if (n > want && (!worst || n - want > worst.n - worst.want))
        worst = { n, want, sec: sec.name || 'the table', team: t.name };
    }
  }
  if (worst)
    stale(R.name, `${worst.team} has played ${worst.n} regular-season series but ${worst.sec} is set to ${worst.want}.`,
          `The split length changed — update REGIONS.${slug}.${R.groupGames ? 'groupGames' : 'defaultGames'} (and defFormat if the playoff size moved with it).`);
  else {
    const shown = R.groupGames
      ? Object.entries(R.groupGames).map(([g, n]) => `${g} ${n}`).join(', ')
      : String(R.defaultGames);
    fine(R.name, `games per team (${shown}) holds${spanned.length ? ` across ${spanned.length + 1} tournaments` : ''}`);
  }

  // group names, matched exactly the way the renderer matches them
  if (R.groupCuts) {
    for (const key of Object.keys(R.groupCuts)) {
      const hit = sections.some(name => nk(name).includes(key));
      if (!hit)
        stale(R.name, `No standings group matches groupCuts key "${key}" — the API is reporting ${sections.length ? sections.map(s => `"${s}"`).join(', ') : 'no named groups'}.`,
              `The page draws no qualification line for an unrecognised group. Rename the key in REGIONS.${slug}.groupCuts to match.`);
    }
  }

  // a cut line below the table is a line nobody sees
  const cutSets = [
    ...(R.cuts ? [['cuts', R.cuts, stageTeams]] : []),
    ...Object.entries(R.groupCuts || {}).map(([g, c]) => {
      const sec = (stage.sections || []).find(s => nk(s.name).includes(g));
      const n = sec ? new Set((sec.rankings || []).flatMap(rk => (rk.teams || []).map(t => t.id || t.name))).size : 0;
      return [`groupCuts.${g}`, c, n];
    }),
  ];
  /* A cut PAST the last row is a line nobody sees and a rank nobody holds.
     A cut ON the last row is different and deliberate: it draws no line, but
     it tells the race panel that the places below the one being raced for
     still qualify for something, so a team that misses the cut is not
     eliminated (LCK Legend sends its fifth and last to a play-in). */
  for (const [label, cuts, total] of cutSets) {
    if (!total) continue;
    for (const c of cuts)
      if (c.after > total)
        stale(R.name, `${label} draws a line after rank ${c.after}, but that table holds ${total} teams.`,
              `A cut past the last row never renders and no team can reach it. Update REGIONS.${slug}.${label}.`);
  }
}

/* ---- the ranking rule, against the last table each league published ------ */

/*
 * REGIONS[].rank says how a league orders its table: match wins, then game win
 * percentage across the whole split, then the head-to-head tiebreakers. That
 * is a claim about somebody else's rulebook, it is the one constant here whose
 * being wrong is completely invisible — the page renders a confident, wrong
 * table and nothing throws — and, unlike most claims of that kind, it is
 * checkable. Rebuild a finished split from the schedule, rank it with the
 * page's own code, and compare against the ordinals the league published.
 *
 * It lifts the ranking functions out of index.html rather than keeping a copy,
 * so this catches a rule change and a bad edit to the engine with one test.
 * The rules only reach for game scores, so only a split whose games this can
 * rebuild exactly is worth testing: where the reconstruction disagrees with
 * the API's own win-loss records the split is skipped rather than guessed at.
 */
const RANK_FNS = ['raceScoreWeights', 'raceEnding', 'raceEndingLink', 'raceGameRec',
                  'raceH2HM', 'raceH2HG', 'raceMetric', 'raceSplitRuns', 'raceCluster', 'raceRank'];
let engine = null;
try {
  const { sources, missing } = extractFunctions(C.src, RANK_FNS);
  if (missing.length) throw new Error(`index.html has no ${missing.join(', ')}`);
  const shapes = extractConstants(C.src, ['RACE_SHAPES_MAX', 'RACE_RANK_DEFAULT']);
  if (shapes.missing.length) throw new Error(`index.html has no ${shapes.missing.join(', ')}`);
  engine = { RACE_RANK_DEFAULT: shapes.values.RACE_RANK_DEFAULT };
  runInNewContext(
    `const RACE_SHAPES_MAX = ${shapes.values.RACE_SHAPES_MAX};\n` + sources.join('\n'), engine);
} catch (e) {
  note('ranking rule', `Could not read the ranking code out of index.html (${e.message}).`,
       'The rank check was skipped. check.mjs is the place to look if the script no longer parses.');
}

/* the league's whole schedule, back far enough to cover one tournament */
async function scheduleSince(id, since) {
  const first = await apiJSON('/getSchedule', { leagueId: id });
  let events = first?.data?.schedule?.events || [];
  let token = first?.data?.schedule?.pages?.older;
  for (let page = 0; page < 10 && token; page++) {
    const oldest = events.reduce((m, e) => Math.min(m, Date.parse(e.startTime) || Infinity), Infinity);
    if (oldest <= since) break;
    const prev = await apiJSON('/getSchedule', { leagueId: id, pageToken: token });
    events = (prev?.data?.schedule?.events || []).concat(events);
    token = prev?.data?.schedule?.pages?.older;
  }
  return events;
}

if (engine) for (const [slug, R] of Object.entries(REGIONS)) {
  const tours = toursBySlug[slug] || [];
  const finished = tours
    .filter(t => Date.parse(t.endDate) < NOW && new Date(Date.parse(t.endDate)).getUTCFullYear() === YEAR)
    .sort((a, b) => Date.parse(b.endDate) - Date.parse(a.endDate));
  if (!finished.length) continue;
  const tour = finished[0];

  let standings = null;
  try { standings = (await apiJSON('/getStandingsV3', { tournamentId: tour.id }))?.data?.standings; }
  catch { try { standings = (await apiJSON('/getStandings', { tournamentId: tour.id }))?.data?.standings; } catch {} }
  if (!Array.isArray(standings) || !standings.length) continue;

  let stage = null, most = 0;
  for (const s of standings) for (const st of s.stages || []) {
    const n = new Set((st.sections || []).flatMap(sec =>
      (sec.rankings || []).flatMap(rk => (rk.teams || []).map(t => t.id || t.name)))).size;
    if (n > most) { most = n; stage = st; }
  }
  if (!stage) continue;

  let events;
  try { events = await scheduleSince(leagueIds[slug] || LEAGUES[slug]?.id, Date.parse(tour.startDate)); }
  catch (e) { note(R.name, `Could not read the schedule for \`${tour.slug}\` (${e.message}).`,
                   'The rank check needs it; nothing on the page is broken by this.'); continue; }
  const window = events
    .filter(e => { const t = Date.parse(e.startTime);
                   return t >= Date.parse(tour.startDate) - 864e5 && t <= Date.parse(tour.endDate) + 864e5; })
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));

  const chain = (R.rank || engine.RACE_RANK_DEFAULT).filter(k => k !== 'wins');
  let checked = 0, wrong = null;
  for (const sec of stage.sections || []) {
    const rows = [];
    for (const rk of sec.rankings || []) for (const t of rk.teams || [])
      rows.push({ name: t.name, k: nk(t.name), ord: rk.ordinal,
                  w: t.record?.wins | 0, l: t.record?.losses | 0 });
    if (rows.length < 3) continue;
    const idx = {};
    rows.forEach((t, i) => { t.i = i; idx[t.k] = i; });
    const n = rows.length;

    /* the regular season, by the same quota trick the page uses: each team gets
       exactly the games its published record accounts for, in date order */
    const left = rows.map(t => t.w + t.l);
    const h2h = new Int8Array(n * n), gw = new Int16Array(n * n);
    const gwT = new Int16Array(n), glT = new Int16Array(n), mw = new Int16Array(n);
    for (const ev of window) {
      if (ev.state !== 'completed' || (ev.match?.teams || []).length !== 2) continue;
      const a = ev.match.teams[0], b = ev.match.teams[1];
      const ia = idx[nk(a.name || '')], ib = idx[nk(b.name || '')];
      if (ia == null || ib == null || ia === ib) continue;
      if (!(left[ia] > 0 && left[ib] > 0)) continue;
      left[ia]--; left[ib]--;
      const ag = a.result?.gameWins | 0, bg = b.result?.gameWins | 0;
      if (a.result?.outcome === 'win') { h2h[ia * n + ib]++; mw[ia]++; }
      else if (b.result?.outcome === 'win') { h2h[ib * n + ia]++; mw[ib]++; }
      gw[ia * n + ib] += ag; gw[ib * n + ia] += bg;
      gwT[ia] += ag; glT[ia] += bg; gwT[ib] += bg; glT[ib] += ag;
    }
    /* a split this cannot rebuild exactly proves nothing either way */
    if (rows.some(t => mw[t.i] !== t.w)) continue;

    const Cx = { teams: rows, n, idx, h2h, gw, gwT, glT, chain };
    const wins = new Int16Array(n);
    rows.forEach(t => { wins[t.i] = t.w; });
    const band = engine.raceRank(Cx, { members: rows.map(t => t.i), cut: 0 },
                                 wins, engine.raceEnding(Cx, []));
    const got = rows.slice().sort((x, y) => band[x.i].lo - band[y.i].lo || x.name.localeCompare(y.name));
    const want = rows.slice().sort((x, y) => x.ord - y.ord);
    checked++;
    // the feed shares an ordinal between teams it never split; only compare where it committed
    if (!got.every((t, i) => t.ord === want[i].ord))
      wrong = { sec: sec.name || 'the table',
                got: got.map(t => `${t.name} ${t.w}-${t.l}`).join(' > '),
                want: want.map(t => `${t.name} ${t.w}-${t.l}`).join(' > ') };
  }

  if (wrong)
    stale(R.name, `The ranking rule does not reproduce the published \`${tour.slug}\` table (${wrong.sec}).`
          + `\n        page:      ${wrong.got}\n        published: ${wrong.want}`,
          `Either the league changed its rules or the ordering code drifted. REGIONS.${slug}.rank lists the metrics in order (wins, gamePct, h2h, h2hGamePct, sov, sovGames); the LEC's are in its rulebook under Standings and Tiebreakers.`);
  else if (checked)
    fine(R.name, `ranking rule reproduces the published \`${tour.slug}\` table`);
}

/* ---- gol.gg tournament names (what drafts.mjs scrapes) ------------------- */

for (const [slug, cfg] of Object.entries(LEAGUES)) {
  try {
    const found = await discoverTournament(cfg.name, YEAR);
    if (!found) {
      note('gol.gg', `No ${cfg.name} tournament listed for ${YEAR}.`,
           'drafts.mjs will fall back to its baked-in name; if the season just rolled over this resolves itself.');
    } else if (found.name !== cfg.golgg) {
      note('gol.gg', `${cfg.name} is now published as "${found.name}" (LEAGUES still records "${cfg.golgg}").`,
           `drafts.mjs discovers this automatically, so nothing is broken — update LEAGUES.${slug}.golgg to keep the record straight, and consider a --prune run to drop the previous split.`);
    } else {
      fine('gol.gg', `${cfg.name}: "${found.name}"`);
    }
  } catch (e) {
    note('gol.gg', `Tournament list unreachable (${e.message}).`, 'gol.gg may be down; drafts.mjs falls back to its baked-in names.');
  }
}

/* ---- POWER_RANKINGS names against real teams ----------------------------- */

if (apiTeamNames.size) {
  const known = [...apiTeamNames].map(n => nk(n));
  const unknown = POWER_RANKINGS
    .filter(p => !known.some(k => k === nk(p.t) || k.includes(nk(p.t)) || nk(p.t).includes(k)))
    .map(p => `${p.t} (${p.r})`);
  // teams outside the tracked four leagues legitimately appear on a global board
  const trackedRegions = new Set(Object.values(REGIONS).map(r => r.name));
  const suspicious = unknown.filter(u => trackedRegions.has(u.match(/\(([^)]+)\)$/)?.[1]));
  if (suspicious.length)
    note('POWER_RANKINGS', `No team in the live standings matches: ${suspicious.join(', ')}.`,
         'Either a rename/rebrand, a typo, or the team dropped out of the split.');
  else fine('POWER_RANKINGS', 'every ranked team resolves to a live roster');
}

/* ---- HONOURS coverage ---------------------------------------------------- */

/* Matching a tournament slug to an honour by name does not work: Riot calls it
   `lec_split_3_2026`, the board calls it "LEC Summer", and any word-overlap test
   loose enough to connect the two matches everything. Counting is honest where
   naming is not — if a league has finished more tournaments this year than the
   board records trophies for, one of them is missing, whatever it is called. */
for (const [slug, R] of Object.entries(REGIONS)) {
  const tours = toursBySlug[slug];
  if (!tours) continue;

  const finished = tours.filter(t => {
    const end = Date.parse(t.endDate);
    return end < NOW && new Date(end).getUTCFullYear() === YEAR;
  });
  if (!finished.length) continue;

  const recorded = HONOURS.filter(h => h.done && nk(`${h.ev} ${h.detail || ''}`).includes(nk(R.name))).length;
  if (finished.length > recorded) {
    const latest = finished.sort((a, b) => Date.parse(b.endDate) - Date.parse(a.endDate))[0];
    note('HONOURS', `${R.name} has finished ${finished.length} tournament${finished.length > 1 ? 's' : ''} in ${YEAR} but the board records ${recorded}. Most recent: \`${latest.slug}\`, ended ${String(latest.endDate).slice(0, 10)}.`,
         'Add the missing trophy to HONOURS. Riot counts some stages as their own tournament, so this overcounts occasionally — check before adding.');
  } else {
    fine('HONOURS', `${R.name}: ${recorded} recorded against ${finished.length} finished`);
  }
}

/* ---- report -------------------------------------------------------------- */

const stales = findings.filter(f => f.level === 'STALE');
const notes = findings.filter(f => f.level === 'NOTE');
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

for (const f of findings) {
  if (f.level === 'ok') { console.log(`  ok    ${f.area} — ${f.what}`); continue; }
  console.log(`  ${f.level === 'STALE' ? 'STALE' : 'note '} ${f.area} — ${f.what}\n        ${f.fix}`);
  for (const e of f.evidence || []) console.log(`          ${e}`);
}
console.log(stales.length
  ? `\n${stales.length} thing${stales.length > 1 ? 's are' : ' is'} out of date${notes.length ? `, plus ${notes.length} worth a look` : ''}.`
  : `\nNothing is provably stale${notes.length ? `, but ${notes.length} thing${notes.length > 1 ? 's are' : ' is'} worth a look` : ''}.`);

if (reportPath) {
  /* <br> rather than newlines: a finding's fix is one cell of a table, and a
     newline inside one ends the row. */
  const rows = list => list.map(f => `| \`${f.area}\` | ${f.what} | ${
    [f.fix, ...(f.evidence || []).map(e => `\`${e}\``)].join('<br>')} |`);
  const lines = [
    `The baked-in data in [index.html](../blob/main/index.html) has drifted from what the live sources say.`,
    ``,
    `These constants describe a season that moves every week, and nothing about the page breaks visibly when they go out of date — it keeps rendering the old answer. **Checked ${stamp}.**`,
    ``,
  ];
  if (stales.length) {
    lines.push(`## Out of date`, ``, `| where | what | fix |`, `|---|---|---|`, ...rows(stales), ``);
  }
  if (notes.length) {
    lines.push(`## Worth a look`, ``,
      `Judgement calls — these do not fail the run on their own.`, ``,
      `| where | what | fix |`, `|---|---|---|`, ...rows(notes), ``);
  }
  lines.push(
    `Reproduce locally with \`node tools/stale.mjs\`.`, ``,
    `<sub>Posted by [stale.yml](../blob/main/.github/workflows/stale.yml). Updated in place on each run, and closed automatically once the data is current again.</sub>`,
  );
  writeFileSync(reportPath, lines.join('\n'));
}

// Set the code rather than calling process.exit(): exiting while a rejected
// fetch's socket is still closing trips a libuv assertion on Windows.
process.exitCode = stales.length ? 1 : 0;
