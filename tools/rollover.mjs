#!/usr/bin/env node
/*
 * Turning the page over to a new season.
 *
 * This is the scariest edit in the repo and the least practised — it happens
 * once a year, by which time nobody remembers what it touches. CLAUDE.md says
 * "Moving it is a whole-season pass: HONOURS, STORYLINES and TICKER_NOTES all
 * go with it", which is true and is also the whole of the guidance. check.mjs
 * holds SEASON and the <title> to each other so the change cannot be half done
 * in *that* one place, and nothing at all watches the rest.
 *
 * So this tool does the mechanical half and prints the rest as a checklist with
 * the current values in it, which is the part a person actually needs: not
 * "remember to do HONOURS" but "here are the fourteen trophies currently on the
 * board and the date each was won".
 *
 * What it changes:
 *   - SEASON, and the year inside the <title> that has to match it
 *
 * What it deliberately does not change, because every one of them is a claim
 * about the real world that has to be researched rather than derived — the same
 * rule as everything else in this repo:
 *   - HONOURS, STORYLINES, TICKER_NOTES, EVENT, REGIONS
 *
 *   node tools/rollover.mjs --year 2027            # do it
 *   node tools/rollover.mjs --year 2027 --dry-run  # just the checklist
 *   node tools/rollover.mjs                        # checklist for SEASON + 1
 *
 * Run `node tools/check.mjs` after — this does, and says so.
 *
 * No dependencies. Plain node 18+.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { INDEX, readDataConstants } from './constants.mjs';

const arg = name => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const DRY = process.argv.includes('--dry-run');

const C = readDataConstants();
const { SEASON, HONOURS, STORYLINES, TICKER_NOTES, EVENT, REGIONS } = C;

if (!Number.isInteger(SEASON)) {
  console.error('Could not read SEASON out of index.html — run node tools/check.mjs first.');
  process.exit(1);
}

const YEAR = Number(arg('--year') || SEASON + 1);
if (!Number.isInteger(YEAR) || YEAR < 2000 || YEAR > 2100) {
  console.error(`--year ${arg('--year')} is not a plausible season.`);
  process.exit(1);
}

console.log(`Season rollover: ${SEASON} -> ${YEAR}\n`);

if (YEAR === SEASON) {
  console.log(`index.html already says ${YEAR}. Nothing mechanical to do.\n`);
} else {
  /* ---- the mechanical half --------------------------------------------- */

  let html = readFileSync(INDEX, 'utf8');
  const before = html;
  const changes = [];

  const seasonDecl = new RegExp(`(^const SEASON = )${SEASON}(;)`, 'm');
  if (seasonDecl.test(html)) {
    html = html.replace(seasonDecl, `$1${YEAR}$2`);
    changes.push(`SEASON = ${YEAR}`);
  } else {
    console.error(`Could not find \`const SEASON = ${SEASON};\` to replace. Nothing written.`);
    process.exit(1);
  }

  /* The <title> is real markup on purpose — it has to be readable by anything
     that does not run the script — so it carries its own literal and has to be
     moved separately. check.mjs is what stops the two drifting. */
  const title = html.match(/<title>([^<]*)<\/title>/);
  if (!title) {
    console.error('index.html has no <title>. Nothing written.');
    process.exit(1);
  }
  if (!title[1].includes(String(SEASON))) {
    console.error(`The <title> does not mention ${SEASON}, so this cannot safely rewrite it:\n  ${title[1]}\nNothing written.`);
    process.exit(1);
  }
  html = html.replace(title[0], title[0].split(String(SEASON)).join(String(YEAR)));
  changes.push(`<title> ... ${title[1].split(String(SEASON)).join(String(YEAR))}`);

  if (DRY) {
    console.log('Would change:');
    for (const c of changes) console.log(`  ${c}`);
    console.log('\n--dry-run: index.html untouched\n');
  } else if (html === before) {
    console.log('Nothing changed.\n');
  } else {
    writeFileSync(INDEX, html);
    console.log('Changed:');
    for (const c of changes) console.log(`  ${c}`);
    console.log('');
  }
}

/* ---- the half that needs a person -------------------------------------- */

/* Printed with the current contents rather than as a list of constant names.
   "Clear HONOURS" is a reminder; fourteen trophies with the dates they were won
   is the thing you actually have to work through, and seeing it is what stops
   last season's board quietly surviving into the new one. */

const line = s => console.log(s);
const rule = () => line('─'.repeat(72));

rule();
line('Still to do by hand. Every one of these is a claim about the real world,');
line('so none of it is derived — research it, the way CLAUDE.md requires.');
rule();

line(`\n1. HONOURS — ${HONOURS.length} entr${HONOURS.length === 1 ? 'y' : 'ies'} from ${SEASON}, all of which describe last season:`);
for (const h of HONOURS) {
  const who = h.done ? (h.champ || '?') : 'not yet played';
  line(`     ${String(h.date || '').padEnd(12)} ${String(h.ev || '?').padEnd(34)} ${who}`);
}
line(`   The board is the season's memory, so this is a rewrite rather than an edit.`);
line(`   Anything still \`done:false\` at rollover never happened and should go.`);

line(`\n2. STORYLINES — ${STORYLINES.length} bullet${STORYLINES.length === 1 ? '' : 's'} about ${SEASON}:`);
for (const s of STORYLINES) line(`     ${s.title}`);
line(`   Same tone: specific, factual, one stat each.`);

line(`\n3. TICKER_NOTES — ${TICKER_NOTES.length} headline${TICKER_NOTES.length === 1 ? '' : 's'}, each with the date it expires:`);
for (const t of TICKER_NOTES) line(`     until ${String(t.until || '?').slice(0, 10)}  [${t.tag}] ${t.text}`);
line(`   renderTicker() drops one once \`until\` has passed, so a missed patch`);
line(`   shortens the ticker rather than falsifying it — but they all belong to`);
line(`   ${SEASON} and should be replaced, not left to expire.`);

line(`\n4. EVENT — currently ${EVENT.name} (${String(EVENT.start).slice(0, 10)} to ${String(EVENT.end).slice(0, 10)}), slug \`${EVENT.slug}\`.`);
line(`   Rolling it on to the next tournament means editing the slug in THREE`);
line(`   places — EVENT.slug, the nav button's data-tab, and the page section's`);
line(`   id — plus stages, qual.routes, field, wiki links and the wordmark.`);
line(`   check.mjs holds the three slugs to each other, so getting two of them`);
line(`   right fails the build rather than rendering a blank tab.`);

line(`\n5. REGIONS — the four leagues' per-split settings:`);
for (const [slug, R] of Object.entries(REGIONS)) {
  line(`     ${slug.padEnd(5)} splitLabel "${R.splitLabel}"  defFormat \`${R.defFormat}\`  ` +
       (R.groupGames ? `groupGames ${JSON.stringify(R.groupGames)}` : `defaultGames ${R.defaultGames}`));
}
line(`   \`node tools/stale.mjs\` reports each of these against the live feed once`);
line(`   the new season's tournaments exist, so the honest order is: roll the`);
line(`   year over now, and let stale.mjs tell you when each split is real.`);

line(`\n6. DRAFTS — run \`node tools/drafts.mjs --prune\` once the new split starts.`);
line(`   It drops everything Riot no longer places in the current split. Since`);
line(`   the sweep that added rollover detection, drafts.mjs does this by itself`);
line(`   when gol.gg renames a split, so this is usually already handled.`);

line(`\n7. The generated blocks need nothing. GPR and QUAL rewrite themselves.\n`);

rule();

/* ---- and prove the mechanical half did not break anything -------------- */

if (!DRY && YEAR !== SEASON) {
  line('\nRunning check.mjs:\n');
  const r = spawnSync(process.execPath, ['tools/check.mjs'], { stdio: 'inherit' });
  if (r.status !== 0) {
    line('\ncheck.mjs is unhappy — fix that before going any further.');
    process.exitCode = 1;
  }
} else {
  line('\nRun `node tools/check.mjs` when you have made the changes above.');
}
