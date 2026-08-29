#!/usr/bin/env node
/*
 * Repo health check for index.html.
 *
 * Why this exists: the page is one hand-edited file with no build step, so
 * nothing stands between a typo and the live site. The only syntax check in
 * the repo used to live inside .github/workflows/drafts.yml, which means it
 * only ever guarded the bot's own commits — a hand-edit that broke the inline
 * script shipped to GitHub Pages unverified.
 *
 * This runs on every push and pull request. It checks the things that are
 * cheap to verify and expensive to notice by eye:
 *
 *   - the inline <script> exists, is the only one, and parses
 *   - the localStorage prefix is still nexusdesk_ (renaming it silently wipes
 *     every user's saved brackets, caches and settings)
 *   - localStorage is only ever reached through the lsRead/lsWrite helpers,
 *     which is what keeps a blocked or corrupt store from throwing before
 *     the page has rendered anything
 *   - the DRAFTS:generated / DRAFTS:end markers are intact and the block
 *     between them is still valid JSON (tools/drafts.mjs rewrites it wholesale
 *     and a malformed write would take the whole script down)
 *   - no duplicate element IDs, which silently break getElementById wiring
 *   - index.html is still the only file the browser loads
 *   - the file has not blown past its size budget (a warning, not a failure)
 *   - the baked-in data constants are structurally sound: every REGIONS entry
 *     points at a real FORMATS wiring, every bracket reference resolves to a
 *     match that exists, every seed is used exactly once, and HONOURS /
 *     POWER_RANKINGS / STORYLINES carry the fields the render code reads
 *
 * That last group matters because those constants are patched by hand (and,
 * increasingly, by bots) against a page with no runtime type checking. A
 * bracket wired to a match id that does not exist parses perfectly and then
 * renders a blank playoff tab.
 *
 * This checks *shape*, never *truth* — whether the data is still current is
 * tools/stale.mjs's question, because answering it needs the network.
 *
 *   node tools/check.mjs           # exit 1 on any failure
 *   node tools/check.mjs --strict  # also exit 1 on warnings
 *
 * No dependencies, no build step. Plain node 18+.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Script } from 'node:vm';
import { extractConstants, DATA_CONSTANTS } from './constants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const INDEX = join(ROOT, 'index.html');

const STRICT = process.argv.includes('--strict');
/* the metric names raceMetric() in index.html actually answers to */
const RANK_METRICS = ['wins', 'gamePct', 'h2h', 'h2hGamePct', 'sov', 'sovGames'];
const SIZE_BUDGET = 400 * 1024;   // DRAFTS grows all split; shout before it gets silly
/* The budget above only warns, and it is a warning nobody sees unless they read
   the log — health.yml does not pass --strict, so nothing has ever stopped the
   file growing quietly past it forever. This is the line that actually stops
   it: far enough above the budget that a full split of DRAFTS growth is a nudge
   rather than a wall, close enough that a single-file page never turns into a
   megabyte download on someone's phone. Prune DRAFTS, or raise it on purpose. */
const SIZE_CEILING = 480 * 1024;

const fails = [];
const warns = [];
const fail = (what, detail) => fails.push(detail ? `${what}\n    ${detail}` : what);
const warn = (what, detail) => warns.push(detail ? `${what}\n    ${detail}` : what);

let html;
try {
  html = readFileSync(INDEX, 'utf8');
} catch {
  console.error('index.html not found — GitHub Pages serves that filename specifically.');
  process.exit(1);
}

/* ---- the inline script ------------------------------------------------- */

const opens = (html.match(/<script[\s>]/g) || []).length;
if (opens === 0) {
  fail('No <script> block found in index.html.');
} else if (opens > 1) {
  fail(`Found ${opens} <script> tags; the page is meant to carry exactly one.`,
       'If a second one is deliberate, teach this check about it.');
}

const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) {
  fail('Could not extract the inline <script> body.');
} else {
  try {
    new Script(m[1], { filename: 'index.html' });
  } catch (e) {
    // vm reports the line within the script body; offset it back to the file
    const before = html.slice(0, m.index).split('\n').length;
    const line = Number(String(e.stack || '').match(/index\.html:(\d+)/)?.[1] || 0);
    fail('The inline script does not parse.',
         `${e.message}${line ? `  (index.html line ~${before + line - 1})` : ''}`);
  }
}

const src = m ? m[1] : '';

/* ---- the localStorage prefix ------------------------------------------- */

if (!/const\s+LS\s*=\s*k\s*=>\s*['"]nexusdesk_['"]/.test(src)) {
  fail('The LS() localStorage prefix is no longer nexusdesk_.',
       'Renaming it wipes every existing user\'s saved brackets, caches and settings.');
}

/* ---- localStorage only through the helpers ----------------------------- */

/* Touching localStorage directly is how the page used to die above the fold: a
 * browser set to block site data throws on the very first access, and an entry
 * truncated by a quota kill throws on parse — both before the first render,
 * where an exception leaves a black page that reloading cannot fix. lsRead /
 * lsWrite / lsJSON absorb that and fall back to a first-visit state, but only
 * for as long as everything actually goes through them. One hand-edit reaching
 * for localStorage.getItem puts the black page back for whoever's store is
 * broken, and nobody else ever sees it. */

for (const fn of ['lsRead', 'lsWrite', 'lsJSON']) {
  if (!src.includes('function ' + fn + '(')) {
    fail(`The ${fn}() localStorage helper is gone.`,
         'Reads and writes go through it so a blocked or corrupt store cannot throw before the first render.');
  }
}

const NL = String.fromCharCode(10);
// comments talk about localStorage constantly; blank them out but keep the
// line count intact so anything found still points at the right line
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '));
const scriptLine0 = m ? html.slice(0, m.index).split(NL).length : 0;
const rawStorage = codeOnly.split(NL)
  .map((text, i) => ({ line: scriptLine0 + i, text: text.trim() }))
  .filter(({ text }) => text.includes('localStorage')
                     && !text.startsWith('//')
                     // the two helper bodies are the one place it belongs
                     && !text.startsWith('function lsRead(')
                     && !text.startsWith('function lsWrite('));

if (rawStorage.length) {
  fail(`localStorage is reached directly in ${rawStorage.length} place${rawStorage.length > 1 ? 's' : ''}, outside lsRead()/lsWrite().`,
       rawStorage.map(({ line, text }) => `index.html:${line}  ${text.slice(0, 76)}`).join(NL + '    '));
}

/* ---- the generated DRAFTS block ---------------------------------------- */

const startMark = src.indexOf('/* DRAFTS:generated */');
const endMark = src.indexOf('/* DRAFTS:end */');

if (startMark === -1 || endMark === -1) {
  fail('The DRAFTS:generated / DRAFTS:end markers are missing.',
       'tools/drafts.mjs rewrites the block between them and cannot find it without both.');
} else if (endMark < startMark) {
  fail('The DRAFTS markers are in the wrong order.');
} else {
  const block = src.slice(startMark, endMark);
  const open = block.indexOf('{', block.indexOf('const DRAFTS'));
  const close = block.lastIndexOf('}');
  if (open === -1 || close === -1 || close < open) {
    fail('Could not find the DRAFTS object literal between its markers.');
  } else {
    try {
      const drafts = JSON.parse(block.slice(open, close + 1));
      const n = Object.keys(drafts).length;
      if (n === 0) warn('The DRAFTS block is empty — no games recorded for this split yet.');
      else console.log(`  DRAFTS: ${n} games recorded`);
    } catch (e) {
      fail('The DRAFTS block is not valid JSON.', e.message);
    }
  }
}

/* ---- duplicate element IDs --------------------------------------------- */

const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map(x => x[1]);
const seen = new Set();
const dupes = new Set();
for (const id of ids) (seen.has(id) ? dupes : seen).add(id);
if (dupes.size) {
  fail(`Duplicate element ID${dupes.size > 1 ? 's' : ''}: ${[...dupes].join(', ')}`,
       'getElementById silently returns only the first, so the rest of the wiring goes dead.');
}

/* ---- one file, and only one -------------------------------------------- */

const stray = readdirSync(ROOT)
  .filter(f => /\.(html?|css|m?js)$/i.test(f))
  .filter(f => f !== 'index.html');
if (stray.length) {
  fail(`Loose browser file${stray.length > 1 ? 's' : ''} at the repo root: ${stray.join(', ')}`,
       'Everything the browser loads belongs inside index.html; tooling belongs in tools/.');
}

/* ---- size budget ------------------------------------------------------- */

const bytes = Buffer.byteLength(html, 'utf8');
const kb = (bytes / 1024).toFixed(0);
if (bytes > SIZE_CEILING) {
  fail(`index.html is ${kb} KB, past the ${(SIZE_CEILING / 1024).toFixed(0)} KB hard ceiling.`,
       'Run `node tools/drafts.mjs --prune` to drop previous splits, or raise SIZE_CEILING deliberately.');
} else if (bytes > SIZE_BUDGET) {
  warn(`index.html is ${kb} KB, past the ${(SIZE_BUDGET / 1024).toFixed(0)} KB budget (ceiling ${(SIZE_CEILING / 1024).toFixed(0)} KB).`,
       'Most of the growth is DRAFTS; it resets at the split boundary.');
} else {
  console.log(`  size:   ${kb} KB of a ${(SIZE_BUDGET / 1024).toFixed(0)} KB budget`);
}

/* ---- the baked-in data constants --------------------------------------- */

/* Only worth attempting if the script parsed at all — otherwise every constant
   "fails" and buries the one real error above. */
if (m && !fails.length) {
  let C = null;
  try {
    const { values, missing } = extractConstants(src, DATA_CONSTANTS);
    if (missing.length) {
      fail(`Baked-in constant${missing.length > 1 ? 's' : ''} not found: ${missing.join(', ')}`,
           'The render code reads these by name; a rename takes the matching tab down.');
    }
    C = values;
  } catch (e) {
    fail('A baked-in data constant could not be read.', e.message);
  }

  if (C) {
    const { REGIONS, EVENT, HONOURS, STORYLINES, POWER_RANKINGS, POWER_RANKINGS_ASOF, FORMATS } = C;

    /* -- FORMATS: the playoff bracket wirings ------------------------------ */
    if (FORMATS) {
      for (const [key, f] of Object.entries(FORMATS)) {
        const at = `FORMATS.${key}`;
        if (!Array.isArray(f.matches) || !f.matches.length) { fail(`${at} has no matches array.`); continue; }
        if (!Number.isInteger(f.seeds) || f.seeds < 2) fail(`${at}.seeds is ${f.seeds}; expected an integer of 2 or more.`);
        if (!Number.isInteger(f.cols) || f.cols < 1) fail(`${at}.cols is ${f.cols}; expected a positive integer.`);

        const ids = f.matches.map(x => x.id);
        const dupeIds = ids.filter((x, i) => ids.indexOf(x) !== i);
        if (dupeIds.length) fail(`${at} reuses match id${dupeIds.length > 1 ? 's' : ''}: ${[...new Set(dupeIds)].join(', ')}`,
                                 'The sim resolves matches by id, so a duplicate silently drops one.');

        const known = new Set(ids);
        const seedsUsed = [];
        const winnerRefs = new Map();

        for (const mt of f.matches) {
          const where = `${at} ${mt.id || '(no id)'}`;
          if (!mt.id) fail(`${where} has no id.`);
          if (!mt.g) fail(`${where} has no round label (g).`);
          if (!Number.isInteger(mt.col) || mt.col < 1 || mt.col > f.cols)
            fail(`${where} sits at col ${mt.col}, outside 1..${f.cols}.`);
          if (!Number.isInteger(mt.row) || mt.row < 0)
            fail(`${where} has row ${mt.row}; expected 0 or more.`);
          if (!Array.isArray(mt.s) || mt.s.length !== 2) {
            fail(`${where} has ${mt.s?.length ?? 'no'} sources; every match needs exactly 2.`);
            continue;
          }
          for (const s of mt.s) {
            const [kind, ref] = String(s).split(':');
            if (kind === 'seed') {
              const n = Number(ref);
              if (!Number.isInteger(n) || n < 1 || n > f.seeds)
                fail(`${where} references ${s}, outside the 1..${f.seeds} seed range.`);
              else seedsUsed.push(n);
            } else if (kind === 'w' || kind === 'l') {
              if (!known.has(ref)) fail(`${where} references ${s}, but no match ${ref} exists.`,
                                        'An unresolvable reference renders the bracket blank from that node on.');
              else if (ref === mt.id) fail(`${where} references itself (${s}).`);
              else if (kind === 'w') winnerRefs.set(ref, (winnerRefs.get(ref) || 0) + 1);
            } else {
              fail(`${where} has source "${s}"; expected seed:/w:/l:.`);
            }
          }
        }

        // every seed enters the bracket exactly once
        const missingSeeds = [];
        for (let n = 1; n <= f.seeds; n++) {
          const used = seedsUsed.filter(x => x === n).length;
          if (used !== 1) missingSeeds.push(`${n} (used ${used}×)`);
        }
        if (missingSeeds.length)
          fail(`${at} does not place every seed exactly once: ${missingSeeds.join(', ')}`,
               `The format claims ${f.seeds} seeds, so each of 1..${f.seeds} must appear in exactly one match.`);

        // every match feeds its winner onward, except the single final
        const terminal = ids.filter(id => !winnerRefs.has(id));
        if (terminal.length > 1)
          fail(`${at} has ${terminal.length} matches whose winner goes nowhere: ${terminal.join(', ')}`,
               'Only the final should be terminal; the rest are orphaned branches.');
        for (const [id, n] of winnerRefs)
          if (n > 1) fail(`${at} sends the winner of ${id} to ${n} different matches.`);
      }
    }

    /* -- REGIONS ----------------------------------------------------------- */
    if (REGIONS) {
      const formatKeys = new Set(Object.keys(FORMATS || {}));
      for (const [slug, r] of Object.entries(REGIONS)) {
        const at = `REGIONS.${slug}`;
        for (const field of ['name', 'full', 'slug', 'splitLabel', 'wiki', 'liqui'])
          if (!r[field]) fail(`${at}.${field} is missing.`);
        if (r.slug && r.slug !== slug) fail(`${at}.slug is "${r.slug}" but the key is "${slug}".`);
        if (!Number.isInteger(r.defaultGames) || r.defaultGames < 1)
          fail(`${at}.defaultGames is ${r.defaultGames}; expected a positive integer.`);
        if (!r.defFormat) fail(`${at}.defFormat is missing.`);
        else if (formatKeys.size && !formatKeys.has(r.defFormat))
          fail(`${at}.defFormat is "${r.defFormat}", which is not a key of FORMATS.`,
               `Known formats: ${[...formatKeys].join(', ')}. The playoff tab renders empty without a match.`);

        /* the ranking chain: a metric name the engine does not know is
           skipped in silence, and the table quietly orders itself on whatever
           is left — which is exactly the bug this constant exists to fix */
        if (r.rank !== undefined) {
          if (!Array.isArray(r.rank) || !r.rank.length) fail(`${at}.rank is not a non-empty array.`);
          else {
            const unknown = r.rank.filter(k => !RANK_METRICS.includes(k));
            if (unknown.length)
              fail(`${at}.rank names ${unknown.map(u => `"${u}"`).join(', ')}, which the ranking code does not implement.`,
                   `Known metrics: ${RANK_METRICS.join(', ')}. An unknown one is ignored, so the table silently ranks on the rest.`);
            if (r.rank[0] !== 'wins')
              fail(`${at}.rank starts with "${r.rank[0]}"; match wins come first in every one of these leagues.`);
          }
        }

        /* The regular season filed as more than one tournament (LCK rounds
           1-4). The page adds the earlier tables in; a value below 2 means
           nothing and a non-integer would silently disable the whole thing. */
        if (r.tableSpans !== undefined && (!Number.isInteger(r.tableSpans) || r.tableSpans < 2))
          fail(`${at}.tableSpans is ${r.tableSpans}; expected an integer of 2 or more, or the field left out.`,
               'It counts tournaments the regular-season table spans, so 1 is the default and anything less is meaningless.');

        /* Per-group season lengths, for a league whose groups are different
           sizes (LPL Ascend 14, Nirvana 6). Every key has to match a groupCuts
           key, because both are matched against the API's group name the same
           way and a key that matches nothing is skipped in silence. */
        if (r.groupGames !== undefined) {
          const gg = r.groupGames;
          if (!gg || typeof gg !== 'object' || !Object.keys(gg).length)
            fail(`${at}.groupGames is not a non-empty object.`);
          else {
            for (const [g, n] of Object.entries(gg)) {
              if (!Number.isInteger(n) || n < 1)
                fail(`${at}.groupGames.${g} is ${n}; expected a positive integer.`);
              if (r.groupCuts && !Object.keys(r.groupCuts).includes(g))
                fail(`${at}.groupGames names group "${g}", which is not a groupCuts key.`,
                     `Both are matched against the API's group name, so a key nothing matches falls back to defaultGames without saying so. groupCuts has: ${Object.keys(r.groupCuts).join(', ')}.`);
            }
          }
        }

        const cutSets = [
          ...(r.cuts ? [['cuts', r.cuts]] : []),
          ...Object.entries(r.groupCuts || {}).map(([g, c]) => [`groupCuts.${g}`, c]),
        ];
        if (!cutSets.length) fail(`${at} declares neither cuts nor groupCuts.`);
        for (const [label, cuts] of cutSets) {
          if (!Array.isArray(cuts) || !cuts.length) { fail(`${at}.${label} is not a non-empty array.`); continue; }
          for (const c of cuts) {
            if (!Number.isInteger(c.after) || c.after < 1)
              fail(`${at}.${label} has after=${c.after}; expected a positive integer.`);
            if (!['po', 'pi'].includes(c.kind))
              fail(`${at}.${label} has kind="${c.kind}"; expected "po" or "pi".`);
          }
        }
      }
    }

    /* -- EVENT: the international-event tab -------------------------------- */
    /* The event's slug is written down three times — in EVENT, in the nav
       button's data-tab and in the page section's id — because switchTab()
       resolves a tab to a section by name and neither half of the markup can
       see the constant. Rolling the tab to the next event means editing all
       three, and getting two of them right renders a tab that opens a blank
       page and throws nothing. So they are held against each other here. */
    if (EVENT) {
      for (const field of ['slug', 'name', 'full', 'when', 'host', 'logo', 'wiki', 'liqui'])
        if (!EVENT[field]) fail(`EVENT.${field} is missing.`);

      if (EVENT.slug) {
        if (REGIONS && REGIONS[EVENT.slug])
          fail(`EVENT.slug is "${EVENT.slug}", which is also a REGIONS key.`,
               `The event tab and the region page would fight over #page-${EVENT.slug}.`);
        if (!new RegExp(`data-tab=["']${EVENT.slug}["']`).test(html))
          fail(`No nav tab carries data-tab="${EVENT.slug}".`,
               'switchTab() matches the button to the section by that name; without it the tab does not exist.');
        if (!new RegExp(`id=["']page-${EVENT.slug}["']`).test(html))
          fail(`No section carries id="page-${EVENT.slug}".`,
               'buildEventPage() writes into it, and returns silently when it is not there.');
      }

      for (const field of ['start', 'end'])
        if (EVENT[field] !== undefined && Number.isNaN(Date.parse(EVENT[field])))
          fail(`EVENT.${field} is "${EVENT[field]}", which does not parse as a date.`);
      if (EVENT.start && EVENT.end && Date.parse(EVENT.start) > Date.parse(EVENT.end))
        fail(`EVENT.start (${EVENT.start}) is after EVENT.end (${EVENT.end}).`);

      /* Inlined as a data: URI so the tab's mark cannot 404 — it used to, for
         the CI runner but not for a desktop, which is the worst version of a
         broken image. A remote one is still allowed, but only over https: the
         page is served over https and http would be blocked as mixed content,
         leaving the tab silently showing its text fallback. */
      if (EVENT.logo && !/^(https:\/\/|data:image\/[a-z+]+;base64,)/.test(EVENT.logo))
        fail(`EVENT.logo is neither an https URL nor an inline data:image URI: ${EVENT.logo.slice(0, 60)}…`);

      if (EVENT.stages !== undefined) {
        if (!Array.isArray(EVENT.stages) || !EVENT.stages.length) fail('EVENT.stages is not a non-empty array.');
        else EVENT.stages.forEach((st, i) => {
          if (!st.name) fail(`EVENT.stages[${i}] has no name.`);
          if (!st.sub) fail(`EVENT.stages[${i}] (${st.name}) has no sub.`);
        });
      }
    }

    /* -- POWER_RANKINGS ---------------------------------------------------- */
    if (POWER_RANKINGS) {
      const regionCodes = new Set(Object.values(REGIONS || {}).map(r => r.name));
      if (!Array.isArray(POWER_RANKINGS) || !POWER_RANKINGS.length) {
        fail('POWER_RANKINGS is empty.');
      } else {
        let prev = Infinity;
        POWER_RANKINGS.forEach((p, i) => {
          const at = `POWER_RANKINGS[${i}]`;
          if (!p.t) fail(`${at} has no team name.`);
          if (typeof p.pts !== 'number') fail(`${at} (${p.t}) has non-numeric pts.`);
          else { if (p.pts > prev) fail(`${at} (${p.t}) has ${p.pts} pts, above the entry before it.`,
                                        'The board renders in array order, so it must already be sorted.'); prev = p.pts; }
          if (typeof p.move !== 'number') fail(`${at} (${p.t}) has non-numeric move.`);
          if (!/^\d+-\d+$/.test(String(p.wl || ''))) fail(`${at} (${p.t}) has wl="${p.wl}"; expected "W-L".`);
          // a region outside the tracked four is fine on a *global* board, but a
          // typo in one of the four is not, so only flag near-misses
          if (p.r && regionCodes.size && !regionCodes.has(p.r) &&
              [...regionCodes].some(c => c.toLowerCase() === String(p.r).toLowerCase()))
            fail(`${at} (${p.t}) has r="${p.r}"; expected "${[...regionCodes].find(c => c.toLowerCase() === String(p.r).toLowerCase())}".`);
        });
      }
    }

    if (POWER_RANKINGS_ASOF !== undefined && Number.isNaN(Date.parse(POWER_RANKINGS_ASOF)))
      fail(`POWER_RANKINGS_ASOF is "${POWER_RANKINGS_ASOF}", which does not parse as a date.`);

    /* -- HONOURS ----------------------------------------------------------- */
    if (Array.isArray(HONOURS)) {
      HONOURS.forEach((h, i) => {
        const at = `HONOURS[${i}]${h.ev ? ` (${h.ev})` : ''}`;
        for (const field of ['date', 'ev'])
          if (!h[field]) fail(`${at}.${field} is missing.`);
        if (h.done && !h.champ) fail(`${at} is marked done but has no champion.`);
        if (!h.d) return;
        if (h.d.podium !== undefined) {
          if (!Array.isArray(h.d.podium)) fail(`${at}.d.podium is not an array.`);
          else for (const row of h.d.podium)
            if (!Array.isArray(row) || row.length !== 2)
              fail(`${at}.d.podium has a row with ${row?.length ?? 'no'} cells; expected [team, note].`);
        }
        for (const [bi, b] of (h.d.brackets || []).entries()) {
          if (!Array.isArray(b.matches)) { fail(`${at}.d.brackets[${bi}] has no matches array.`); continue; }
          for (const mt of b.matches) {
            const where = `${at}.d.brackets[${bi}] "${mt.g || '?'}"`;
            if (!Number.isInteger(mt.col) || !Number.isInteger(mt.row))
              fail(`${where} is missing an integer col/row.`);
            if (mt.a === undefined || mt.b === undefined) fail(`${where} is missing a team.`);
            // A null score is deliberate: some series never had one published, and
            // the winner rides on w: instead. What must not happen is a row with
            // neither, which renders as a match nobody won.
            const scored = s => s === undefined || s === null || typeof s === 'number';
            if (!scored(mt.sa)) fail(`${where} has a non-numeric score for ${mt.a}.`);
            if (!scored(mt.sb)) fail(`${where} has a non-numeric score for ${mt.b}.`);
            if (typeof mt.sa !== 'number' && typeof mt.sb !== 'number' && mt.w !== 0 && mt.w !== 1)
              fail(`${where} has no scores and no w:0/w:1 to say who won.`);
          }
        }
      });
    }

    /* -- STORYLINES -------------------------------------------------------- */
    if (Array.isArray(STORYLINES)) {
      STORYLINES.forEach((s, i) => {
        for (const field of ['icon', 'title', 'sub'])
          if (!s[field]) fail(`STORYLINES[${i}]${s.title ? ` (${s.title})` : ''}.${field} is missing.`);
      });
    }

    if (!fails.length) {
      const counts = [
        REGIONS && `${Object.keys(REGIONS).length} regions`,
        FORMATS && `${Object.keys(FORMATS).length} bracket formats`,
        HONOURS && `${HONOURS.length} honours`,
        POWER_RANKINGS && `${POWER_RANKINGS.length} ranked teams`,
      ].filter(Boolean);
      console.log(`  data:   ${counts.join(', ')} — all wiring resolves`);
    }
  }
}

/* ---- report ------------------------------------------------------------ */

for (const w of warns) console.log(`\n  warn: ${w}`);
for (const f of fails) console.log(`\n  FAIL: ${f}`);

if (fails.length) {
  console.log(`\n${fails.length} check${fails.length > 1 ? 's' : ''} failed.`);
  process.exit(1);
}
if (warns.length && STRICT) {
  console.log(`\n${warns.length} warning${warns.length > 1 ? 's' : ''}, and --strict was set.`);
  process.exit(1);
}
console.log(`\nAll checks passed${warns.length ? ` (${warns.length} warning${warns.length > 1 ? 's' : ''})` : ''}.`);
