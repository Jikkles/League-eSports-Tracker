#!/usr/bin/env node
/*
 * Is the automation still running at all?
 *
 * Every other check in this repo asks a question about the *data*: does the
 * script parse, does the API answer, does the page render, is the baked-in data
 * still true. Nothing asked whether the jobs that answer those questions are
 * still firing. That is a real gap in two directions, and both of them are
 * silent by construction:
 *
 *   - GitHub deprioritises scheduled runs on free-tier repos and simply drops
 *     the ones it cannot fit. This is not theoretical here. qual.yml asks for
 *     every two hours; over one measured 29-hour window it ran 8 times where 14
 *     were due, with a 6h18m hole in the middle. drafts.yml is scheduled for
 *     06:00 UTC and has been firing between 10:42 and 13:22. A board that is
 *     six hours behind on the day a final settles a seed looks exactly like a
 *     board that is up to date.
 *
 *   - GitHub disables scheduled workflows after ~60 days without repository
 *     activity, and says so in the workflow's `state` as `disabled_inactivity`.
 *     The activity here is almost entirely the generators' own commits, and
 *     they only commit when something changed — so a long off-season, with no
 *     new games for drafts and a frozen power-ranking board for gpr, is
 *     precisely the stretch in which this repo can go quiet enough to have its
 *     automation switched off. Everything would stay green. Nothing would run.
 *
 * So: ask the Actions API when each workflow last completed successfully, and
 * hold that against the cadence it claims to run at. A workflow past its grace
 * window is STALE; one approaching it is a NOTE; one GitHub has disabled is
 * STALE whatever its last run says.
 *
 * The repo is public, so the Actions API answers unauthenticated and this needs
 * no setup to run locally. It will use GITHUB_TOKEN or GH_TOKEN when one is in
 * the environment, which is what lifts the rate limit inside CI.
 *
 *   node tools/heartbeat.mjs             # report and exit 1 if anything is overdue
 *   node tools/heartbeat.mjs --json      # machine-readable
 *
 * Also imported by stale.mjs, so the daily staleness issue carries this too
 * rather than opening a second one.
 *
 * No dependencies. Plain node 18+ for global fetch.
 */

const REPO = process.env.GITHUB_REPOSITORY || 'Jikkles/League-eSports-Tracker';
const GH = 'https://api.github.com';
const TIMEOUT_MS = 20000;

/*
 * What each workflow claims, and how late is too late.
 *
 * `every` is the cadence in hours as the cron reads. `grace` is the multiplier
 * that turns it into a deadline, and the numbers are deliberately loose: this
 * check exists to catch automation that has *stopped*, not to complain about
 * the ordinary drift above, which nothing in this repo can fix and which does
 * no harm at half a day. A 2-hourly job gets 6 hours because that is the
 * largest hole actually observed; a daily job gets 40 to survive one skipped
 * night; the weekly link check gets 10 days.
 *
 * Workflows that only run on push are deliberately absent — health.yml and
 * smoke.yml have no cadence to be late against.
 */
export const WATCHED = [
  { file: 'qual.yml',       name: 'Refresh the qualification board', every: 2,      grace: 3 },
  { file: 'drafts.yml',     name: 'Refresh drafts',                  every: 24,     grace: 1.7 },
  { file: 'gpr.yml',        name: 'Refresh power rankings',          every: 24,     grace: 1.7 },
  { file: 'api-canary.yml', name: 'API canary',                      every: 24,     grace: 1.7 },
  { file: 'stale.yml',      name: 'Staleness canary',                every: 24,     grace: 1.7 },
  { file: 'deployed.yml',   name: 'Deploy check',                    every: 24,     grace: 1.7 },
  { file: 'links.yml',      name: 'Link rot',                        every: 24 * 7, grace: 1.5 },
];

const hours = ms => ms / 36e5;
const ago = ms => {
  const h = hours(ms);
  if (h < 48) return `${h.toFixed(1)}h ago`;
  return `${(h / 24).toFixed(1)} days ago`;
};

async function gh(path) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'LeagueEsportsTracker-heartbeat/1.0 (+https://github.com/Jikkles/League-eSports-Tracker)',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${GH}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Findings in stale.mjs's shape: { level, area, what, fix, evidence }.
 *
 * A workflow the API does not know about is reported rather than skipped — a
 * renamed or deleted file is the most complete way for a check to stop running,
 * and the one this would otherwise be blindest to.
 */
export async function heartbeatFindings(now = Date.now()) {
  const out = [];
  const area = 'automation';

  let workflows;
  try {
    workflows = (await gh(`/repos/${REPO}/actions/workflows`)).workflows || [];
  } catch (e) {
    /* Not knowing is not the same as being broken, and this check must never
       be the reason the daily staleness issue opens. */
    out.push({ level: 'NOTE', area, what: `could not reach the Actions API (${e.message}), so nothing here was verified.`,
               fix: 'Usually a rate limit or a brief GitHub incident; it clears on its own.' });
    return out;
  }

  const byFile = new Map(workflows.map(w => [String(w.path).split('/').pop(), w]));

  for (const w of WATCHED) {
    const meta = byFile.get(w.file);
    if (!meta) {
      out.push({ level: 'STALE', area, what: `\`${w.file}\` is not in the repo's workflow list.`,
                 fix: 'It has been renamed or deleted. Nothing it used to check is running.' });
      continue;
    }

    /* `disabled_inactivity` is GitHub having switched the schedule off after a
       quiet stretch, which is the off-season failure this check was written
       for. `disabled_manually` is somebody's decision and is reported as a
       note, not a fault. */
    if (meta.state === 'disabled_inactivity') {
      out.push({ level: 'STALE', area, what: `\`${w.file}\` has been disabled by GitHub for repository inactivity.`,
                 fix: 'Re-enable it under Actions → the workflow → Enable workflow. Every schedule it owns is currently dead.' });
      continue;
    }
    if (meta.state && meta.state !== 'active') {
      out.push({ level: 'NOTE', area, what: `\`${w.file}\` is ${meta.state}.`,
                 fix: 'Deliberate, if that was the intention — but it is not running.' });
      continue;
    }

    let runs;
    try {
      runs = (await gh(`/repos/${REPO}/actions/workflows/${meta.id}/runs?status=success&per_page=1`)).workflow_runs || [];
    } catch (e) {
      out.push({ level: 'NOTE', area, what: `could not read \`${w.file}\`'s run history (${e.message}).`,
                 fix: 'Usually a rate limit; it clears on its own.' });
      continue;
    }

    if (!runs.length) {
      out.push({ level: 'NOTE', area, what: `\`${w.file}\` has no successful run on record.`,
                 fix: 'Expected for a workflow added today; a finding for one that has been there a while.' });
      continue;
    }

    const last = Date.parse(runs[0].updated_at || runs[0].created_at);
    const late = hours(now - last);
    const deadline = w.every * w.grace;

    if (late > deadline) {
      out.push({
        level: 'STALE', area,
        what: `${w.name} last succeeded ${ago(now - last)} — it runs every ${w.every < 24 ? `${w.every}h` : `${Math.round(w.every / 24)}d`}, and ${deadline.toFixed(0)}h is already generous.`,
        fix: 'Check the Actions tab. GitHub drops free-tier scheduled runs under load, but a gap this size usually means the schedule has stopped rather than slipped.',
        evidence: [`last success: ${runs[0].html_url}`],
      });
    } else if (late > deadline * 0.75) {
      out.push({
        level: 'NOTE', area,
        what: `${w.name} last succeeded ${ago(now - last)}, which is inside its ${deadline.toFixed(0)}h window but drifting.`,
        fix: 'Normal free-tier scheduling drift. Worth a look only if it keeps growing.',
      });
    } else {
      out.push({ level: 'ok', area, what: `${w.name} — last success ${ago(now - last)}` });
    }
  }

  return out;
}

/* Run directly. */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const findings = await heartbeatFindings();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    for (const f of findings) {
      if (f.level === 'ok') { console.log(`  ok    ${f.what}`); continue; }
      console.log(`  ${f.level === 'STALE' ? 'STALE' : 'note '} ${f.what}\n        ${f.fix}`);
      for (const e of f.evidence || []) console.log(`          ${e}`);
    }
    const bad = findings.filter(f => f.level === 'STALE').length;
    const verified = findings.filter(f => f.level === 'ok').length;
    /* "Every watched workflow is running" was printed even when the API had
       refused to answer and nothing had been looked at — a clean bill of health
       from a check that did not run is worse than no check. */
    console.log(bad ? `\n${bad} workflow${bad > 1 ? 's are' : ' is'} not running as scheduled.`
      : verified ? `\n${verified} of ${WATCHED.length} watched workflows confirmed running.`
      : `\nNothing was verified — see the note above.`);
  }
  process.exitCode = findings.some(f => f.level === 'STALE') ? 1 : 0;
}
