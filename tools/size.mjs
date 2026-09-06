#!/usr/bin/env node
/*
 * What this page costs a visitor, and what a change did to that number.
 *
 * check.mjs owns the budget and will fail the build past the ceiling, which is
 * the right behaviour for a cliff and the wrong behaviour for a slope. The
 * number only ever moves one way — 145 KB gzipped of a 165 KB budget as this
 * was written, 88% of it spent — and it gets there a couple of KB at a time,
 * each one individually reasonable. By the time the budget fails, the feature
 * that pushed it over is finished and the choice is between reverting it and
 * raising the number, which is not a choice anybody makes carefully.
 *
 * So: print the delta on every pull request, while the change is still a
 * proposal. Not a gate — a fact, next to the diff that caused it.
 *
 *   node tools/size.mjs                          # what it costs today
 *   node tools/size.mjs --baseline old.html      # ... and what changed
 *   node tools/size.mjs --baseline old.html --markdown out.md
 *
 * Gzipped is the number that matters, for the reason CLAUDE.md gives: Pages
 * serves this compressed, and ~30 KB of the raw file is comment-only lines that
 * gzip collapses to almost nothing. The raw number is printed too, because it
 * is the one the block breakdown is measured in.
 *
 * No dependencies. Plain node 18+.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, '..', 'index.html');

const arg = name => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};

/* Kept in step with check.mjs deliberately rather than imported: check.mjs is a
   long script with side effects and this is a two-line report. If the numbers
   there move, move them here — check.mjs stays the authority that can fail. */
const GZIP_BUDGET = 165 * 1024;
const GZIP_CEILING = 200 * 1024;

const kb = n => `${(n / 1024).toFixed(1)} KB`;

/* Line endings are normalised to LF before anything is measured, for the reason
   deployed.mjs gives at more length: a Windows working copy has CRLF while git
   stores — and Pages therefore serves — LF. Left alone, a local baseline
   comparison reports a phantom +7 KB, one byte per line, on a branch that has
   not touched index.html at all. What is being counted here is what a visitor
   downloads, which is the LF version either way. */
const norm = buf => Buffer.from(Buffer.from(buf).toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
const sizes = buf => { const b = norm(buf); return { raw: b.length, gz: gzipSync(b).length }; };

/* The three generated regions, so a growth report can say whether the page grew
   or merely recorded more games. */
const BLOCKS = [
  ['DRAFTS', '/* DRAFTS:generated */', '/* DRAFTS:end */'],
  ['QUAL', '/* QUAL:generated */', '/* QUAL:end */'],
  ['GPR', '/* GPR:generated */', '/* GPR:end */'],
];

function breakdown(text) {
  const out = {};
  let generated = 0;
  for (const [name, a, b] of BLOCKS) {
    const i = text.indexOf(a), j = text.indexOf(b);
    if (i < 0 || j < 0) { out[name] = null; continue; }
    const slice = text.slice(i, j + b.length);
    out[name] = gzipSync(norm(Buffer.from(slice))).length;
    generated += out[name];
  }
  out._generated = generated;
  return out;
}

const now = readFileSync(INDEX);
const nowText = norm(now).toString('utf8');
const cur = sizes(now);
const curBlocks = breakdown(nowText);

const baselinePath = arg('--baseline');
let base = null, baseBlocks = null;
if (baselinePath) {
  try {
    const buf = readFileSync(baselinePath);
    base = sizes(buf);
    baseBlocks = breakdown(norm(buf).toString('utf8'));
  } catch (e) {
    console.error(`could not read the baseline (${e.message}); reporting the current size only`);
  }
}

const pct = (cur.gz / GZIP_BUDGET) * 100;
const state = cur.gz > GZIP_CEILING ? 'over the ceiling'
  : cur.gz > GZIP_BUDGET ? 'over budget'
  : 'within budget';

const sign = n => (n > 0 ? '+' : n < 0 ? '−' : '±');
const delta = n => `${sign(n)}${(Math.abs(n) / 1024).toFixed(1)} KB`;

console.log(`index.html  ${kb(cur.gz)} gzipped  (${kb(cur.raw)} raw)`);
console.log(`budget      ${kb(GZIP_BUDGET)}, ceiling ${kb(GZIP_CEILING)} — ${pct.toFixed(0)}% used, ${state}`);
console.log(`generated   ${kb(curBlocks._generated)} gzipped of that (DRAFTS ${curBlocks.DRAFTS === null ? '?' : kb(curBlocks.DRAFTS)})`);

if (base) {
  const d = cur.gz - base.gz;
  const dGen = curBlocks._generated - baseBlocks._generated;
  console.log(`change      ${delta(d)} gzipped (${delta(cur.raw - base.raw)} raw)`);
  /* The distinction worth drawing on a PR: a page that got bigger is a design
     decision, a DRAFTS block that got bigger is yesterday's games. */
  if (dGen) console.log(`            of which ${delta(dGen)} is generated data, ${delta(d - dGen)} is the page`);
}

const mdPath = arg('--markdown');
if (mdPath) {
  const rows = [
    `| | gzipped | raw |`,
    `|---|---|---|`,
    `| this build | **${kb(cur.gz)}** | ${kb(cur.raw)} |`,
  ];
  if (base) {
    rows.push(`| base | ${kb(base.gz)} | ${kb(base.raw)} |`);
    rows.push(`| change | **${delta(cur.gz - base.gz)}** | ${delta(cur.raw - base.raw)} |`);
  }

  const bar = Math.round(Math.min(pct, 100) / 5);
  const lines = [
    `**Page weight** — ${kb(cur.gz)} of the ${kb(GZIP_BUDGET)} budget (${pct.toFixed(0)}%, ${state}).`,
    ``,
    '`' + '█'.repeat(bar) + '░'.repeat(20 - bar) + '`',
    ``,
    ...rows,
    ``,
  ];
  if (base) {
    const dGen = curBlocks._generated - baseBlocks._generated;
    const dPage = (cur.gz - base.gz) - dGen;
    if (dGen) {
      lines.push(`Of that change, ${delta(dGen)} is generated data (DRAFTS / QUAL / GPR) and ${delta(dPage)} is the page itself.`, ``);
    }
  }
  lines.push(
    `Gzipped is what a visitor pays — Pages serves this compressed, and much of the raw file is comments. \`check.mjs\` fails past ${kb(GZIP_CEILING)}; this comment is a trend, not a gate.`,
    ``,
    `<sub>Posted by [health.yml](../blob/main/.github/workflows/health.yml) via \`tools/size.mjs\`. Updated in place as the branch moves.</sub>`,
  );
  writeFileSync(mdPath, lines.join('\n'));
}
