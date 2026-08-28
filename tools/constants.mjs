#!/usr/bin/env node
/*
 * Reads the baked-in data constants out of index.html.
 *
 * Why this exists: REGIONS, HONOURS, POWER_RANKINGS, STORYLINES and FORMATS are
 * hand-maintained literals living inside the one inline <script>. Two tools now
 * need to look at them — check.mjs to validate their shape, stale.mjs to compare
 * them against the live API — and neither can just import the file, because the
 * script is a browser program that touches the DOM on the way through.
 *
 * So: locate each `const NAME =` declaration, scan forward to the semicolon that
 * closes it (tracking bracket depth, skipping over strings and comments), and
 * evaluate that one literal in an empty vm context. The constants are pure data
 * — no calls, no regex literals, no references to anything else — which is what
 * makes this safe. If that ever stops being true the evaluation throws, loudly,
 * rather than returning something half-right.
 *
 * Not a standalone tool; imported by check.mjs and stale.mjs. Run it directly to
 * dump what it can see, which is the fastest way to debug a parse complaint:
 *
 *   node tools/constants.mjs
 *
 * No dependencies. Plain node 18+.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const INDEX = join(ROOT, 'index.html');

/** The whole file, and just the inline script's body. */
export function readIndex() {
  const html = readFileSync(INDEX, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  return { html, src: m ? m[1] : '' };
}

/* Walk from the `=` to the semicolon that ends the declaration. Depth counting
   alone is not enough: a brace inside a string ("3–0 in Hong Kong { ... }") or a
   comment would throw the count off, so both are skipped explicitly. */
function readLiteral(src, from) {
  let i = from, depth = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) break; i += 2; continue; }

    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }

    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ';' && depth === 0) return src.slice(from, i);

    i++;
  }
  return null;
}

/**
 * Pull named constants out of the script body.
 * Returns { values, missing } — missing names are reported rather than thrown,
 * so a caller can decide whether an absent constant is fatal.
 */
export function extractConstants(src, names) {
  const values = {};
  const missing = [];

  for (const name of names) {
    const decl = new RegExp(`(?:^|\\n)\\s*const\\s+${name}\\s*=`).exec(src);
    if (!decl) { missing.push(name); continue; }

    const literal = readLiteral(src, decl.index + decl[0].length);
    if (literal === null) {
      throw new Error(`${name}: could not find the semicolon closing its declaration`);
    }
    try {
      values[name] = runInNewContext(`(${literal})`);
    } catch (e) {
      throw new Error(`${name}: the literal did not evaluate — ${e.message}`);
    }
  }
  return { values, missing };
}

/**
 * Pull named top-level function declarations out of the script body.
 *
 * Why: one tool now wants to *run* part of the page rather than read its data.
 * stale.mjs checks that the ranking rule baked into REGIONS still reproduces
 * the tables the leagues publish, and that check is only worth anything if it
 * exercises the code the browser runs — a second copy of the algorithm in the
 * tool would agree with itself forever while the page drifted.
 *
 * Same discipline as readLiteral: skip strings and comments, count braces.
 * Anything it mangles fails loudly when the caller evaluates it.
 */
export function extractFunctions(src, names) {
  const nl = src.indexOf(String.fromCharCode(13, 10)) >= 0
    ? String.fromCharCode(13, 10) : String.fromCharCode(10);
  const out = [];
  const missing = [];
  for (const name of names) {
    /* top-level declarations only: the marker is a `function` at column 0 */
    const at = src.indexOf(nl + 'function ' + name + '(');
    if (at < 0) { missing.push(name); continue; }
    const from = at + nl.length;
    let i = from, depth = 0, open = false, end = -1;
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) break; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') {
        const q = c; i++;
        while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) break; i++; }
        i++; continue;
      }
      if (c === '{') { depth++; open = true; }
      else if (c === '}') { depth--; if (open && !depth) { end = i + 1; break; } }
      i++;
    }
    if (end < 0) throw new Error(`${name}: could not find the brace closing its body`);
    out.push(src.slice(from, end));
  }
  return { sources: out, missing };
}

/** The five data constants both callers care about, in one call. */
export const DATA_CONSTANTS =
  ['REGIONS', 'HONOURS', 'STORYLINES', 'POWER_RANKINGS', 'POWER_RANKINGS_ASOF', 'FORMATS'];

export function readDataConstants() {
  const { html, src } = readIndex();
  const { values, missing } = extractConstants(src, DATA_CONSTANTS);
  return { html, src, ...values, missing };
}

/* Run directly: dump a summary of what parsed. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { missing, ...c } = readDataConstants();
  for (const name of DATA_CONSTANTS) {
    if (missing.includes(name)) { console.log(`  MISSING  ${name}`); continue; }
    const v = c[name];
    const size = Array.isArray(v) ? `${v.length} entries`
      : typeof v === 'object' ? `${Object.keys(v).length} keys: ${Object.keys(v).join(', ')}`
      : JSON.stringify(v);
    console.log(`  ok  ${name.padEnd(20)} ${size}`);
  }
}
