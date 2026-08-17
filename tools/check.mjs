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
 *   - the DRAFTS:generated / DRAFTS:end markers are intact and the block
 *     between them is still valid JSON (tools/drafts.mjs rewrites it wholesale
 *     and a malformed write would take the whole script down)
 *   - no duplicate element IDs, which silently break getElementById wiring
 *   - index.html is still the only file the browser loads
 *   - the file has not blown past its size budget (a warning, not a failure)
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

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const INDEX = join(ROOT, 'index.html');

const STRICT = process.argv.includes('--strict');
const SIZE_BUDGET = 400 * 1024;   // DRAFTS grows all split; shout before it gets silly

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
if (bytes > SIZE_BUDGET) {
  warn(`index.html is ${kb} KB, past the ${(SIZE_BUDGET / 1024).toFixed(0)} KB budget.`,
       'Most of the growth is DRAFTS; it resets at the split boundary.');
} else {
  console.log(`  size:   ${kb} KB of a ${(SIZE_BUDGET / 1024).toFixed(0)} KB budget`);
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
