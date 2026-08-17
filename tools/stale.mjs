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
import { readDataConstants } from './constants.mjs';
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
const stale = (area, what, fix) => findings.push({ level: 'STALE', area, what, fix });
const note  = (area, what, fix) => findings.push({ level: 'NOTE',  area, what, fix });
const fine  = (area, what)      => findings.push({ level: 'ok',    area, what });

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
const { REGIONS, HONOURS, POWER_RANKINGS, POWER_RANKINGS_ASOF } = C;
const NOW = Date.now();
const YEAR = new Date(NOW).getUTCFullYear();

/* ---- POWER_RANKINGS freshness ------------------------------------------- */

const asOf = Date.parse(POWER_RANKINGS_ASOF);
if (Number.isNaN(asOf)) {
  stale('POWER_RANKINGS', `POWER_RANKINGS_ASOF ("${POWER_RANKINGS_ASOF}") does not parse as a date.`,
        'Set it to the date printed on lolesports.com/gpr.');
} else {
  const age = Math.floor((NOW - asOf) / 86400e3);
  if (age > MAX_AGE_DAYS)
    stale('POWER_RANKINGS', `The rankings mirror is ${age} days old (as of ${POWER_RANKINGS_ASOF}).`,
          'Re-mirror the Global Power Rankings from lolesports.com/gpr and update POWER_RANKINGS_ASOF.');
  else fine('POWER_RANKINGS', `mirror is ${age} day${age === 1 ? '' : 's'} old`);
}

/* ---- per-league checks --------------------------------------------------- */

let leagueIds = {};
try {
  const leagues = (await apiJSON('/getLeagues'))?.data?.leagues || [];
  for (const lg of leagues) {
    const slug = String(lg.slug || '').toLowerCase();
    if (REGIONS[slug]) leagueIds[slug] = lg.id;
  }
} catch (e) {
  console.error(`getLeagues failed (${e.message}) — the API canary is the place to look, not this.`);
  process.exit(1);
}

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

  // games per team: only an overshoot means anything mid-split
  const played = allTeams
    .map(t => (t.record ? (t.record.wins || 0) + (t.record.losses || 0) : 0));
  const most = Math.max(0, ...played);
  if (most > R.defaultGames)
    stale(R.name, `A team has played ${most} regular-season series but defaultGames is ${R.defaultGames}.`,
          `The split length changed — update REGIONS.${slug}.defaultGames (and defFormat if the playoff size moved with it).`);
  else fine(R.name, `defaultGames ${R.defaultGames} holds (most played: ${most})`);

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
  for (const [label, cuts, total] of cutSets) {
    if (!total) continue;
    for (const c of cuts)
      if (c.after >= total)
        stale(R.name, `${label} draws a line after rank ${c.after}, but that table holds ${total} teams.`,
              `A cut at or past the last row never renders. Update REGIONS.${slug}.${label}.`);
  }
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
  if (f.level === 'ok') console.log(`  ok    ${f.area} — ${f.what}`);
  else console.log(`  ${f.level === 'STALE' ? 'STALE' : 'note '} ${f.area} — ${f.what}\n        ${f.fix}`);
}
console.log(stales.length
  ? `\n${stales.length} thing${stales.length > 1 ? 's are' : ' is'} out of date${notes.length ? `, plus ${notes.length} worth a look` : ''}.`
  : `\nNothing is provably stale${notes.length ? `, but ${notes.length} thing${notes.length > 1 ? 's are' : ' is'} worth a look` : ''}.`);

if (reportPath) {
  const rows = list => list.map(f => `| \`${f.area}\` | ${f.what} | ${f.fix} |`);
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
