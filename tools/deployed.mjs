#!/usr/bin/env node
/*
 * Checks that GitHub Pages is actually serving the commit that was just pushed.
 *
 * Why this exists: every other check in this repo runs against the working copy.
 * Nothing looked at the deployed site. Pages rebuilds on push to main, and when
 * that rebuild does not happen — a Pages outage, a settings change, a build
 * queued behind another, someone flipping the source branch — the repo stays
 * green and the live page silently keeps serving the previous version. There is
 * no signal at all, because from CI's point of view nothing failed.
 *
 * The check is a content comparison: hash the local index.html, fetch the live
 * URL, hash that, and require them to match. Pages serves static files verbatim,
 * so anything other than a match means the deploy has not landed.
 *
 * Line endings are normalised to LF on both sides first. On a Windows checkout
 * the working copy has CRLF while git stores — and Pages therefore serves — LF,
 * so a raw byte comparison reports every local run as a failed deploy, off by
 * exactly one byte per line. What is being asked here is whether the live page
 * is the same page, not whether it survived a checkout unchanged.
 *
 *   node tools/deployed.mjs                    # is the live site my working copy?
 *   node tools/deployed.mjs --timeout 420      # keep retrying for 7 minutes
 *   node tools/deployed.mjs --url https://...  # somewhere other than the default
 *
 * Run straight after a push it polls, because a rebuild takes about a minute.
 * Run at any other time it answers immediately on the first attempt.
 *
 * A build that has been superseded counts as landed. Two pushes a few seconds
 * apart make Pages cancel the first build and deploy only the second, so the
 * run checking the first commit would wait for bytes that will never be
 * served and fail — which is exactly what happened on 2026-10-05, the one red
 * deploy check in weeks, with the live site perfectly current. So on a
 * mismatch it also asks git what main's tip is now, and a live page matching
 * that tip is the healthy answer: the question was always "is the live site
 * current?", and "is it this particular commit?" was only the usual way of
 * asking it.
 *
 * No dependencies, no build step. Plain node 18+ for global fetch.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, '..', 'index.html');

const arg = name => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};

/* Derived from the repo so a fork checks its own Pages site, not this one. */
function defaultUrl() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !repo.includes('/')) return 'https://jikkles.github.io/League-eSports-Tracker/';
  const [owner, name] = repo.split('/');
  return `https://${owner.toLowerCase()}.github.io/${name}/`;
}

const URL_ = arg('--url') || defaultUrl();
const TIMEOUT_MS = Number(arg('--timeout') || 300) * 1000;
const EVERY_MS = 15000;

/* Normalise CRLF -> LF before hashing; see the note at the top of the file. */
const norm = buf => Buffer.from(buf).toString('utf8').replace(/\r\n/g, '\n');
const sha = s => createHash('sha256').update(norm(s)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const local = readFileSync(INDEX);
const want = sha(local);

/* main's index.html as of right now, when main has moved past this checkout —
   the build Pages should be serving if this one was superseded. Null when it
   has not moved, or when git is not there to ask (the check then behaves
   exactly as it always did). Plain `git fetch`, never `--depth`: on a full
   local clone a depth would quietly make the repository shallow. */
const ROOT = join(HERE, '..');
function newerTip() {
  try {
    const git = (...a) => execFileSync('git', a, { cwd: ROOT, timeout: 30000, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
    git('fetch', '-q', 'origin', 'main');
    const head = git('rev-parse', 'HEAD').toString().trim();
    const tip = git('rev-parse', 'FETCH_HEAD').toString().trim();
    if (head === tip) return null;
    return { tip, sha: sha(git('show', 'FETCH_HEAD:index.html')) };
  } catch { return null; }
}

/* The "as of" line is the most human-readable version marker the page carries,
   so a mismatch can say *which* build is live rather than just "not yours". */
const asOf = src => (String(src).match(/POWER_RANKINGS_ASOF\s*=\s*['"]([^'"]+)['"]/) || [])[1] || 'unknown';

console.log(`local  index.html  ${(Buffer.byteLength(norm(local)) / 1024).toFixed(0)} KB  sha ${want.slice(0, 12)}  (rankings as of ${asOf(local)})`);
console.log(`live   ${URL_}\n`);

const started = Date.now();
let attempt = 0;
let lastWhy = 'no attempt completed';

while (Date.now() - started < TIMEOUT_MS || attempt === 0) {
  attempt++;
  try {
    // cache-bust: Pages sits behind a CDN that would happily hand back the
    // build we are trying to prove is gone
    const res = await fetch(`${URL_}?_=${Date.now()}`, {
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      lastWhy = `HTTP ${res.status}`;
    } else {
      const body = Buffer.from(await res.arrayBuffer());
      const got = sha(body);
      if (got === want) {
        console.log(`  ok   attempt ${attempt}: the live site is serving this build.`);
        process.exitCode = 0;
        break;
      }
      const newer = newerTip();
      if (newer && got === newer.sha) {
        console.log(`  ok   attempt ${attempt}: this commit was superseded, and the live site is serving main's tip (${newer.tip.slice(0, 7)}).`);
        process.exitCode = 0;
        break;
      }
      lastWhy = `serving a different build — ${(Buffer.byteLength(norm(body)) / 1024).toFixed(0)} KB, sha ${got.slice(0, 12)}, rankings as of ${asOf(body)}`;
    }
  } catch (e) {
    lastWhy = e.name === 'TimeoutError' ? 'request timed out' : e.message;
  }

  const left = TIMEOUT_MS - (Date.now() - started);
  console.log(`  ...  attempt ${attempt}: ${lastWhy}`);
  if (left <= EVERY_MS) {
    console.log(`\nGave up after ${attempt} attempt${attempt > 1 ? 's' : ''} over ${Math.round((Date.now() - started) / 1000)}s: ${lastWhy}`);
    console.log(`\nThe repo is green and the live page is stale, which is the combination nothing else in this repo would tell you about.`);
    console.log(`Check the Pages build under Settings → Pages, and https://www.githubstatus.com for an incident.`);
    process.exitCode = 1;
    break;
  }
  await sleep(EVERY_MS);
}
