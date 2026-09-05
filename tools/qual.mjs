#!/usr/bin/env node
/*
 * Keeps the Worlds qualification board current without anybody watching games.
 *
 * The board in EVENT.qual has two halves. `routes` is the seed table — which
 * places a region sends and what settles each one — and that is rulebook
 * knowledge, researched by hand. `thru` is who has already qualified, and that
 * is not: it follows from results, and results are published.
 *
 * The gap this closes is the one that let Gen.G sit at "#1–3" for a day after
 * the bracket had already made third impossible for them, and G2 sit off the
 * board entirely after a win that put a floor of third under them. Neither is
 * something stale.mjs can see: its arithmetic is per region and counts places
 * against teams, so a region that is already full stays green while a seed goes
 * stale inside it, and its range check only fires once every place in a team's
 * range is settled.
 *
 * HOW IT KNOWS
 *
 * Riot publishes the whole bracket before it is played. Every match slot in
 * /getStandingsV3 carries an `origin` naming where its occupant comes from:
 * another match (slot 1 the winner, slot 2 the loser), a seeding position, or a
 * decisionPoint for a pairing chosen later. That is a graph, and a graph is
 * enough to answer "how far can this team still fall?" without knowing who else
 * is in it:
 *
 *   - A match whose loser feeds no other match ELIMINATES its loser. Order those
 *     by depth and the places fall out: the shallowest elimination is last
 *     place, the deepest is the final, whose loser is second and whose winner is
 *     first. Two eliminations at equal depth share a band (5th–6th), which is
 *     the honest answer rather than a coin toss.
 *   - Walk forward from where a team stands now, losing at every step, and the
 *     deepest elimination reachable is the WORST place they can still finish.
 *   - If that worst place is inside the region's qualifying places, they are
 *     through — whatever happens next, and whoever they play.
 *
 * That last point is why no simulation of opponents is needed, and why a
 * decisionPoint nobody has resolved yet does not stop the analysis: it changes
 * who a team meets, never how deep the bracket runs.
 *
 * WHAT IT WILL NOT DO
 *
 * Only places whose route carries an `at` are decided here. A route without one
 * is not a bracket placement at all — the LPL's championship points is a season
 * standing — and it is reported rather than guessed. It never removes an entry,
 * never invents a route name, and only ever narrows a seed range, never widens
 * one. Where its answer contradicts something written by hand it says so and
 * changes nothing, because that is a question about the rules rather than about
 * the results.
 *
 *   node tools/qual.mjs --dry-run   # print what it would write, change nothing
 *   node tools/qual.mjs             # patch index.html between the QUAL markers
 *   node tools/qual.mjs --check     # exit 1 if a patch is pending (CI)
 *
 * No dependencies. Plain node 18+.
 */

import { writeFileSync } from 'node:fs';
import { INDEX, readIndex, extractConstants } from './constants.mjs';

const API = 'https://esports-api.lolesports.com/persisted/gw';
const API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const UA = 'league-esports-tracker qual.mjs (+https://github.com/Jikkles/League-eSports-Tracker)';

const DRY = process.argv.includes('--dry-run');
const CHECK = process.argv.includes('--check');

const START = '/* QUAL:generated */';
const END = '/* QUAL:end */';
const NL = String.fromCharCode(10);

const notes = [];
const note = (what, why) => notes.push({ what, why });

/* The page matches teams by name, so this has to spell them the way the page
   does — same normalisation, same source: /getTeams. */
const nk = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const iso = t => new Date(t).toISOString().slice(0, 10);
const band = seed => seed.length > 1 ? `${seed[0]}–${seed[seed.length - 1]}` : String(seed[0]);

async function api(path, params) {
  const url = new URL(API + path);
  url.searchParams.set('hl', 'en-GB');
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'x-api-key': API_KEY, 'User-Agent': UA } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).data;
    } catch (e) {
      if (attempt === 2) throw new Error(`${path}: ${e.message}`);
      await new Promise(res => setTimeout(res, 800 * (attempt + 1)));
    }
  }
}

/* ---------------------------------------------------------------- the graph */

/* Every match in one stage, flattened out of the sections/columns/cells nest
   the standings endpoint returns, keeping only what the graph needs. */
function stageMatches(stage) {
  const out = [];
  for (const sec of stage.sections || [])
    for (const col of sec.columns || [])
      for (const cell of col.cells || [])
        for (const m of cell.matches || [])
          out.push({
            id: m.structuralId,
            round: cell.name || col.name || '',
            state: m.state,
            slots: (m.teams || []).map(t => ({
              name: t.name && t.name !== 'TBD' ? t.name : null,
              won: t.result?.outcome === 'win',
              origin: t.origin || null,
            })),
          });
  return out;
}

/* Longest path from the start of the bracket, which is what orders the
   eliminations. A slot fed by a decisionPoint contributes no edge — the pairing
   it decides is not published yet — and that can only ever understate a depth by
   leaving one route in unmeasured. It cannot reorder the bands, because every
   match is still deeper than every match feeding it. */
function depths(matches) {
  const byId = new Map(matches.map(m => [m.id, m]));
  const seen = new Map();
  const walk = (m, guard) => {
    if (seen.has(m.id)) return seen.get(m.id);
    if (guard.has(m.id)) return 0;            // cannot happen in a bracket; never hang on it
    guard.add(m.id);
    let d = 0;
    for (const s of m.slots) {
      const o = s.origin;
      if (o?.type === 'match' && byId.has(o.structuralId))
        d = Math.max(d, walk(byId.get(o.structuralId), guard) + 1);
    }
    guard.delete(m.id);
    seen.set(m.id, d);
    return d;
  };
  for (const m of matches) walk(m, new Set());
  return seen;
}

/* Which matches end their loser's tournament, and what place that hands out.
   A loser slot nobody consumes is the end of the road; sort those by depth and
   the places follow from how many teams are still alive behind each one. Equal
   depth is a shared band, and the band is reported rather than broken — two
   teams out in the same round genuinely are 5th–6th. */
function placesByMatch(matches) {
  const d = depths(matches);
  const consumed = new Set();
  for (const m of matches)
    for (const s of m.slots)
      if (s.origin?.type === 'match') consumed.add(`${s.origin.structuralId}:${s.origin.slot}`);

  const elim = matches.filter(m => !consumed.has(`${m.id}:2`));
  const seeded = new Set();
  for (const m of matches)
    for (const s of m.slots)
      if (s.origin?.type === 'seeding') seeded.add(String(s.origin.slot));
  /* A bracket with byes seeds some teams in through a decisionPoint, so the
     seeding slots alone undercount the field. One elimination per elimination
     match, plus the one team nobody eliminates, is the count that always holds. */
  const total = Math.max(seeded.size, elim.length + 1);

  const bands = new Map();
  for (const m of elim) {
    const k = d.get(m.id) ?? 0;
    if (!bands.has(k)) bands.set(k, []);
    bands.get(k).push(m);
  }
  const order = [...bands.keys()].sort((a, b) => a - b);
  const place = new Map();
  let left = total;
  for (const k of order) {
    const group = bands.get(k);
    const hi = left, lo = left - group.length + 1;
    for (const m of group) place.set(m.id, [lo, hi]);
    left -= group.length;
  }
  const finalId = order.length ? bands.get(order[order.length - 1])[0].id : null;

  /* A loser slot nobody consumes usually means elimination, but not always: a
     bracket that routes its upper-bracket losers through a decisionPoint (the
     LCK picks which lower-bracket match takes which) hides that edge, and the
     match then looks like the end of a road it is not. Every hidden edge like
     that lands at or above the deepest decisionPoint, so a place is only quoted
     for eliminations deeper than that one — below it the tool says nothing
     rather than something it cannot prove. It costs a handful of answers the
     bracket would have supported; it cannot invent one. */
  let dpMax = -1;
  for (const m of matches)
    if (m.slots.some(x => x.origin?.type === 'decisionPoint'))
      dpMax = Math.max(dpMax, d.get(m.id) ?? 0);
  const sure = new Map();
  for (const [id, p] of place) if ((d.get(id) ?? 0) > dpMax) sure.set(id, p);

  return { place: sure, finalId, total };
}

/* Where a team can still finish, from where the bracket has them now. Losing at
   every step is the worst case; the best case is winning out. Both are read off
   the graph, never off who they might play — which is the whole trick, because
   it means an unresolved pairing further down cannot make the answer wrong. */
function outlook(matches, team) {
  const byId = new Map(matches.map(m => [m.id, m]));
  const { place, finalId } = placesByMatch(matches);
  const d = depths(matches);
  const loserGoes = new Map();
  for (const m of matches)
    for (const s of m.slots) {
      const o = s.origin;
      if (o?.type === 'match' && o.slot === 2) loserGoes.set(o.structuralId, m.id);
    }

  const mine = matches.filter(m => m.slots.some(s => s.name === team));
  if (!mine.length) return null;
  const deepest = list => list.sort((a, b) => (d.get(b.id) ?? 0) - (d.get(a.id) ?? 0))[0];
  const live = deepest(mine.filter(m => m.state !== 'completed'));
  const played = deepest(mine.filter(m => m.state === 'completed'));

  if (!live) {
    /* Nothing left on the board for them: either they won the final, or their
       last defeat was the end of it. A win with no next match filed is the feed
       lagging the result, and says nothing yet. */
    if (!played) return null;
    const won = played.slots.find(s => s.name === team)?.won;
    if (played.id === finalId && won) return { lo: 1, hi: 1 };
    if (won) return null;
    const p = place.get(played.id);
    return p ? { lo: p[0], hi: p[1] } : null;
  }

  /* From the deepest match they are still in, lose every time. Wherever that
     ends is the floor under them. */
  let cur = live, worst = null;
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    const drop = loserGoes.get(cur.id);
    if (!drop || !byId.has(drop)) { worst = place.get(cur.id) || null; break; }
    cur = byId.get(drop);
  }
  return worst ? { lo: 1, hi: worst[1] } : null;
}

/* -------------------------------------------------------------- the regions */

const groupBy = (list, key) => {
  const m = new Map();
  for (const x of list) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
};

/* The season in progress: the tournament whose window we are inside, else the
   most recent to have ended. Taking "the newest" outright would open next
   year's empty shell the day Riot files it. */
async function tournamentFor(leagueSlug, leagues) {
  const lg = leagues.find(l => (l.slug || '').toLowerCase() === leagueSlug);
  if (!lg) return null;
  const data = await api('/getTournamentsForLeague', { leagueId: lg.id });
  const ts = data.leagues?.[0]?.tournaments || [];
  const today = iso(Date.now());
  const pick = ts.filter(t => t.startDate <= today && t.endDate >= today)
                 .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0]
    || ts.filter(t => t.endDate < today).sort((a, b) => (a.endDate < b.endDate ? 1 : -1))[0];
  return pick ? { league: lg, tournament: pick } : null;
}

/* The standings feed carries no kick-off times, so a clinching game is dated
   from the league's schedule instead. Missing that, today — which can be a day
   out on the date, and is never wrong about the qualification itself. */
const SCHED = new Map();
const schedKey = names => names.filter(Boolean).sort().join(' vs ');

async function analyse(region, leagues, teamLogos) {
  const routes = region.routes.map((r, i) => ({ ...r, place: i + 1 })).filter(r => r.at?.stage);
  if (!region.feed?.league || !routes.length) return [];

  const found = await tournamentFor(region.feed.league, leagues);
  if (!found) { note(region.rg, `no tournament for league "${region.feed.league}"`); return []; }

  const data = await api('/getStandingsV3', { tournamentId: found.tournament.id });
  const stages = data.standings?.[0]?.stages || [];
  const out = new Map();

  for (const [slug, group] of groupBy(routes, r => r.at.stage)) {
    const stage = stages.find(s => s.slug === slug);
    if (!stage) { note(region.rg, `stage "${slug}" is not in ${found.tournament.slug} yet`); continue; }
    const matches = stageMatches(stage);
    if (!matches.length) { note(region.rg, `stage "${slug}" carries no matches yet`); continue; }

    /* The places this stage hands out, as named by the routes pointing at it. A
       team is through once every place still open to them is one of these. */
    const qualifying = new Set(group.map(r => r.at.place));
    const cut = Math.max(...qualifying);
    const names = new Set();
    for (const m of matches) for (const s of m.slots) if (s.name) names.add(s.name);

    for (const team of names) {
      const o = outlook(matches, team);
      if (!o || o.hi > cut) continue;
      const seed = [];
      for (let p = o.lo; p <= o.hi; p++) if (qualifying.has(p)) seed.push(p);
      if (!seed.length) continue;
      const played = matches.filter(m => m.state === 'completed' && m.slots.some(s => s.name === team));
      const last = played[played.length - 1];
      const on = (last && SCHED.get(schedKey(last.slots.map(s => s.name)))) || iso(Date.now());
      const route = seed.length === 1 ? group.find(r => r.at.place === seed[0]) : null;
      out.set(team, { team, seed, on, logo: teamLogos.get(nk(team)) || null, via: route?.via || null });
    }
  }
  return [...out.values()];
}

/* --------------------------------------------------------------- the block */

const BS = String.fromCharCode(92);
const q = s => "'" + String(s).split("'").join(BS + "'") + "'";

function renderBlock(byRegion, asOf) {
  const L = [START];
  L.push('/* Who the bracket has already put through, and how narrowly they can still be');
  L.push('   seeded. Worked out by tools/qual.mjs from Riot\u2019s own published wiring, after');
  L.push('   every result. NEVER HAND-EDIT: the whole block is rewritten, so an edit here');
  L.push('   is overwritten rather than kept. Anything this cannot derive — a route taken');
  L.push('   outside a region\u2019s own places, a crest the feed does not carry — belongs in');
  L.push('   EVENT.qual\u2019s `thru`, which wins on every field except the seed range.');
  L.push(`   As of ${asOf}. */`);
  L.push('const QUAL_AUTO = {');
  for (const [slug, teams] of [...byRegion.entries()].sort()) {
    if (!teams.length) continue;
    L.push(`  ${/^[a-z][a-z0-9]*$/.test(slug) ? slug : q(slug)}: [`);
    for (const t of [...teams].sort((a, b) => a.team.localeCompare(b.team))) {
      const bits = [`team:${q(t.team)}`, `seed:[${t.seed.join(',')}]`, `on:${q(t.on)}`];
      if (t.via) bits.push(`via:${q(t.via)}`);
      L.push(`    {${bits.join(', ')},`);
      L.push(`     logo:${q(t.logo || '')}},`);
    }
    L.push('  ],');
  }
  L.push('};');
  L.push(END);
  return L.join(NL);
}

/* -------------------------------------------------------------------- main */

async function main() {
  const { html, src } = readIndex();
  const { values, missing } = extractConstants(src, ['EVENT']);
  if (missing.includes('EVENT')) throw new Error('EVENT did not parse out of index.html.');
  const regions = values.EVENT.qual?.regions || [];

  const leagues = (await api('/getLeagues')).leagues || [];
  const teams = (await api('/getTeams')).teams || [];
  const teamLogos = new Map();
  for (const t of teams)
    if (t.name && t.image) teamLogos.set(nk(t.name), t.image.replace(/^http:/, 'https:'));

  /* One schedule per league up front, so a clinching game is dated by the day
     it was played rather than the day this happened to run. */
  for (const r of regions) {
    if (!r.feed?.league) continue;
    const lg = leagues.find(l => (l.slug || '').toLowerCase() === r.feed.league);
    if (!lg) continue;
    try {
      const s = await api('/getSchedule', { leagueId: lg.id });
      for (const ev of s.schedule?.events || []) {
        const key = schedKey((ev.match?.teams || []).map(t => t.name));
        if (key && ev.startTime) SCHED.set(key, iso(ev.startTime));
      }
    } catch (e) { note(r.rg, `schedule fetch failed (${e.message}); dates fall back to today`); }
  }

  const byRegion = new Map();
  for (const r of regions) {
    const found = await analyse(r, leagues, teamLogos);
    const keep = [];
    for (const a of found) {
      const hand = (r.thru || []).find(t => nk(t.team) === nk(a.team));
      const handSeed = !hand ? null
        : Array.isArray(hand.seed) ? hand.seed
        : Number.isInteger(hand.seed) ? [hand.seed] : null;
      /* Narrowing a hand-written range is the point. Contradicting one is a
         question about the rules, not about the results, so it is reported and
         nothing is written. */
      if (handSeed && !a.seed.every(s => handSeed.includes(s))) {
        note(r.rg, `${a.team}: bracket says #${a.seed.join('/')}, EVENT.qual says #${handSeed.join('/')} — left alone`);
        continue;
      }
      keep.push(a);
    }
    if (keep.length) byRegion.set(r.slug, keep);
    const blind = (r.routes || []).filter(x => !x.at?.stage).length;
    if (blind && r.feed?.league)
      note(r.rg, `${blind} of ${r.routes.length} places carry no \`at\` and are not decided here`);
  }

  const block = renderBlock(byRegion, iso(Date.now()));
  const i = html.indexOf(START), j = html.indexOf(END);
  if (i < 0 || j < 0) throw new Error(`the ${START} … ${END} markers are not in index.html`);
  const changed = html.slice(i, j + END.length) !== block;

  const total = [...byRegion.values()].reduce((n, a) => n + a.length, 0);
  console.log(`  ${total} team${total === 1 ? '' : 's'} through, across ${byRegion.size} region${byRegion.size === 1 ? '' : 's'}`);
  for (const [slug, list] of byRegion)
    for (const t of list)
      console.log(`    ${slug.padEnd(13)} ${t.team.padEnd(26)} #${band(t.seed)}  ${t.on}${t.logo ? '' : '   (no crest in /getTeams)'}`);
  for (const n of notes) console.log(`  note  ${n.what} — ${n.why}`);

  if (!changed) { console.log(NL + 'The board is already current.'); return 0; }
  if (DRY || CHECK) {
    console.log(NL + block);
    console.log(NL + (CHECK ? 'A patch is pending.' : 'Nothing written (--dry-run).'));
    return CHECK ? 1 : 0;
  }
  writeFileSync(INDEX, html.slice(0, i) + block + html.slice(j + END.length));
  console.log(NL + 'index.html patched.');
  return 0;
}

main().then(code => process.exit(code)).catch(e => {
  console.error(`qual.mjs failed: ${e.message}`);
  process.exit(2);
});
