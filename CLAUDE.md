# League Esports Tracker

A single-file, offline-capable dashboard tracking LoL esports (LEC, LCK, LPL, LCS) —
schedules, live games, standings, power rankings, honours, playoff race odds, playoff
bracket predictor.
Deployed via GitHub Pages straight from this repo.

## Ground rules

- **Single file.** Everything the browser loads — markup, CSS, JS, data — lives in
  `index.html`. No build step, no bundler, no package.json. Edit it directly. The one
  thing outside it is `tools/drafts.mjs` (see below), which is tooling, not part of the
  page: it *writes into* `index.html` rather than shipping a second file to the browser.
- **File must stay named `index.html`** — GitHub Pages serves that filename specifically;
  renaming it breaks the deployed site.
- **Never rename the `nexusdesk_` localStorage prefix** (see `LS()` helper near the top
  of the `<script>` block) or any existing element IDs. The app was rebranded from
  NexusDesk to League Esports Tracker, but saved state (sim brackets, caches, settings)
  in users' browsers still depends on the old key prefix — renaming it silently wipes
  everyone's saved state.
- **Verify every edit** with `node tools/check.mjs`. It parses the inline `<script>`
  and checks the invariants that break the page silently: the `nexusdesk_` prefix, the
  DRAFTS markers and their JSON, duplicate element IDs, stray browser files at the root,
  the file-size budget (400 KB warns, 480 KB fails — `SIZE_BUDGET` / `SIZE_CEILING`),
  and the structure of the baked-in data constants — every
  `defFormat` resolving to a real `FORMATS` key, every `w:`/`l:` bracket reference
  resolving to a match that exists, every seed placed exactly once, and the fields
  `HONOURS` / `POWER_RANKINGS` / `STORYLINES` are read by. It checks *shape*, never
  *currency*; whether the data is still true is `tools/stale.mjs`'s question.
  `.github/workflows/health.yml` runs it on every push and PR, so a broken edit fails
  CI rather than reaching Pages.
- **For anything that touches rendering**, also run `node tools/smoke.mjs` — it opens the
  real page in a browser and is the only check that catches a parse-clean edit which
  throws on first render. It also re-runs the nav at a 390px phone viewport looking for
  anything that drags the page sideways, sweeps the home board and a league tab with
  axe, and blocks the API outright to check the offline path — the empty-state messages,
  the cached-data fallback, and that a first visit during an outage says it has no data
  rather than claiming to show a cache it does not have. It needs playwright and axe-core, installed *without* a package.json — **both in
  one command**, because with no package.json npm treats `node_modules` as the entire
  dependency tree and a second `--no-save` install silently removes the first:
  ```
  npm install --no-save playwright axe-core && npx playwright install chromium
  ```
  `--headed` watches it happen, `--shot out.png` saves a full-page screenshot.
  `node_modules/` is gitignored; the repo still has no package.json and must not grow one.
- **Palette is lolesports.com's**, not the old hextech gold theme: pure-black canvas
  (`--bg:#000000`), near-black panels, white type, cyan (`--cyan:#0BC6E3`) as the sole
  accent for live state / league identity, red for live/loss, green for win. Region
  colours: LEC teal, LCK silver, LPL red, LCS blue (see `:root` CSS vars). Keep new UI
  consistent with this — don't reintroduce gold.
- Fonts: Barlow Condensed (display), IBM Plex Mono (mono/labels), Inter (body).

## Data model

- **Live data** (schedules, live games, standings, team logos) comes from the unofficial
  lolesports public API (`API` / `API_KEY` constants near the top of the script) at
  runtime. This needs no manual maintenance.
- **Baked-in constants** go stale and need periodic research + patching:
  - `REGIONS` — per-region split label, regular-season game count, default playoff
    format, channel/wiki links
  - `HONOURS` — season honours board (tournament winners, runners-up, dates)
  - `STORYLINES` — home-tab narrative bullets
  - `POWER_RANKINGS` + `POWER_RANKINGS_ASOF` — mirror of lolesports.com Global Power
    Rankings
  - `FORMATS` — playoff bracket wirings (double/single elim graphs)
- When patching baked-in data: research via web search / Leaguepedia (`lol.fandom.com`)
  / Liquipedia (`liquipedia.net`), never invent scores/points/formats — if a value can't
  be verified, leave it and say so. Make targeted string replacements, not rewrites.
- **`node tools/stale.mjs` says what needs patching.** It compares the constants above
  against the live API and gol.gg and reports drift as either STALE (provably out of
  date — a split label naming the wrong split, a `defaultGames` the standings have
  already exceeded, a `groupCuts` key no longer matching any group, a cut line past the
  end of its table, a rankings mirror older than three weeks) or NOTE (a judgement call
  — a split that just started, a season link pointing at last year, a trophy the
  honours board may be missing). Start a data session here rather than guessing.
  Anything it reports comes with the constant to edit.

## The playoff race panel

`renderRace()` / `raceRun()` sit between the standings table and the simulator on each
region page, and answer "who qualifies?" rather than "who wins the bracket?".

- **Enumeration, not simulation, wherever possible.** With *n* regular-season games
  left there are 2^n endings; up to `RACE_EXACT_MAX` every one is walked and weighted
  by the model probability, so the counts ("in 832 of 2,048 endings") are exact and
  words like *eliminated* and *clinched* are load-bearing. Past that it samples
  `RACE_ITERS` seasons and the panel changes its wording to match — an impossibility
  becomes "never seen". Never let sampled output claim mathematical certainty.
- **Fixtures are separated from playoff games by quota**, not by block name: a team
  gets `REGIONS[].defaultGames` regular-season games, and once its allowance is spent
  every later fixture it appears in is a bracket game. Keep `defaultGames` current or
  the panel silently races the wrong games.
- **Cuts come from `cutsForGroup()`**, shared with the standings table so the line one
  draws and the line the other measures against cannot drift apart. Grouped leagues
  (LCK Legend/Rise, LPL Ascend/Nirvana) race inside their group.
- **Ties follow the published order as far as the data reaches, then stop.** The LEC's
  rulebook (Liquipedia mirrors it) breaks them on head-to-head wins, then head-to-head
  game win %, then strength of victory, then the Spring standings. `raceRank()` applies
  the first, and `raceGamePct()` the second — each tiebreak measured among the teams
  still level after the one before it, which is the standard reading. Rule 2 needs map
  scores, so it only runs when every game between the tied teams has actually been
  played: a hypothetical Bo3 has a winner but no score, and 2–0 and 2–1 are not the same
  tiebreak. It declines rather than guessing, and the teams stay level.
- **What neither can split is a shared band**, counted as a fraction of a place and
  marked `=` in the Range column, because strength of victory has no definition this
  repo has verified and the Spring standings are not baked in. Do not invent a deeper
  tiebreak — the same rule as the constants. If you implement one, implement the
  *published* one and only where real data backs it.
- **`raceCommon()` names what a miss needs**, because "Alive" alone reads as a
  contradiction when a broadcast has just called the same team through. Riot's clinch
  graphics run on wins — a team nobody can pass is safe — while this counts a lost
  tiebreak as out, so a four-way tie for two places can separate the two answers. The
  panel now prints the results every miss has in common ("they only miss out if all of:
  …"), which makes that gap checkable rather than mysterious. Don't resolve such a
  disagreement by softening the maths.
- Locked scenarios live in `nexusdesk_race_<slug>` and are keyed by match id, so a lock
  on a game that has since been played is dropped rather than applied twice.

## Generated data: the DRAFTS block

`DRAFTS` sits between `/* DRAFTS:generated */` and `/* DRAFTS:end */` markers in the
script. **Never hand-edit it** — `tools/drafts.mjs` rewrites the whole block.

It exists because the lolesports API publishes no pick/ban order anywhere, and roughly
1% of completed games are missing from its live-stats feed entirely (HTTP 204 at any
timestamp). gol.gg has both, but sends no `Access-Control-Allow-Origin`, so the page can
never fetch it at runtime — the data has to be baked in ahead of time.

- `node tools/drafts.mjs --dry-run` — report what would change, write nothing
- `node tools/drafts.mjs` — patch `index.html` in place
- `node tools/drafts.mjs --prune` — also drop games from previous splits
- `.github/workflows/drafts.yml` runs it daily at 06:00 UTC and commits any change

The script is incremental (recorded games are skipped) and throttled to ~1 req/sec —
gol.gg is a small Patreon-funded site, so don't remove `POLITE_MS`. Scope is the current
split only, which keeps the block to tens of KB rather than hundreds.

**Split boundaries are handled automatically.** gol.gg addresses tournaments by name and
renames them every split, so the name is now discovered at runtime from gol.gg's own
tournament-list endpoint (`tools/golgg.mjs`) rather than hardcoded. `LEAGUES[].golgg` is
kept only as documentation and as a fallback when that endpoint is unreachable — when
`tools/stale.mjs` notes the published name has changed, update it to keep the record
honest, but nothing is broken in the meantime.

**Pruning is manual and deliberate.** DRAFTS is scoped to the current split, but nothing
removes the previous one — it just grows against the 400 KB budget, and past 480 KB
`check.mjs` stops warning and starts failing. `--prune` enumerates
every game Riot places in the current split and drops everything else. It only ever runs
on an explicit flag (or the `prune` input on the workflow's manual dispatch), and it
refuses to delete anything if enumeration was incomplete, since a partial list would
take the live split with it. Run it once after a rollover.

## Automation

These run without anyone asking:

- `.github/workflows/health.yml` — `tools/check.mjs` on every push and PR
- `.github/workflows/smoke.yml` — `tools/smoke.mjs` on every push and PR, and daily at 07:30 UTC
- `.github/workflows/drafts.yml` — `tools/drafts.mjs` daily at 06:00 UTC, commits changes
- `.github/workflows/api-canary.yml` — `tools/api-canary.mjs` daily at 07:00 UTC
- `.github/workflows/stale.yml` — `tools/stale.mjs` daily at 08:00 UTC
- `.github/workflows/links.yml` — `tools/links.mjs` weekly, Wednesdays at 08:15 UTC
- `.github/workflows/deployed.yml` — `tools/deployed.mjs` after each push to `main`, and daily at 08:45 UTC
- `.github/workflows/research.yml` — weekly data-refresh PR, Mondays at 09:00 UTC
  (**inert until an `ANTHROPIC_API_KEY` secret exists**; it skips with a note rather than failing)
- `.github/dependabot.yml` — monthly action bumps, minor/patch grouped into one PR
- GitHub Pages rebuild on push to `main`

The checks answer different questions and none of them substitutes for another:

| tool | question |
|---|---|
| `check.mjs` | does the script *parse*, and is the data structurally *sound*? |
| `api-canary.mjs` | does the API still *answer* in the shape the page reads? |
| `smoke.mjs` | does the page actually *render*? |
| `stale.mjs` | is the baked-in data still *true*? |
| `deployed.mjs` | is the live site serving *this* build? |
| `links.mjs` | do the links baked into the page still *resolve*? |

`smoke.mjs` serves the repo over http, opens it in headless chromium against a cold
profile (so, empty localStorage: the first-visit path), and checks the nav, home board,
all four league tabs, standings rows and bracket wiring, failing on any uncaught
exception or console error.

It also checks that **the race panel's odds add up**: exactly `cut` teams qualify in
every ending, so a group's probabilities must sum to its number of places. That one is
load-bearing — the race board is computed rather than fetched, so a broken edit renders
its empty state and throws nothing, and every other check here would stay green. It then narrows to a 390px viewport, runs axe, and finally
blocks the API to exercise the offline path.

That last group is the only check in the repo that does **not** need the network — it
blocks the API deliberately — so it keeps working during exactly the upstream outage
that turns the rest of the file red.

Because it needs the live API, a genuine upstream outage turns the smoke run red; the
canary issue is the explanation when that happens.

**Everything reports the same way.** `.github/actions/report-issue` is a composite action
that opens one labelled issue per check, updates it in place on subsequent runs, and
closes it once the check passes again — so a multi-day problem is one issue, not a pile,
and a recovery needs no cleanup. Each check owns a label: `api-canary`, `stale-data`,
`smoke-failing`, `drafts-failing`, `deploy-stale`, `links-dead`. Scheduled jobs report through it;
push and PR runs deliberately don't, because a red check is already in front of whoever
caused it.

The weekly research job opens a **pull request and never pushes to `main`** — the "never
invent scores/points/formats" rule above is only enforceable if a human reads the diff.

The canary walks the same lolesports API calls the page walks, in the same order with the
same fallbacks, and asserts the shapes the render code reads. It exists because the API is
unofficial and reached with a public key lifted from Riot's web client — when that key
rotates or a payload moves, the page renders empty tables rather than erroring, so nothing
tells you. On failure it opens a single `api-canary`-labelled issue, updates it in place on
subsequent runs, and closes it once the API recovers. An empty `getLive` (nothing on air)
and a league sitting between splits are treated as normal, not failures.

## Workflow

Typical session: `node tools/stale.mjs` to see what has actually drifted → research the
current LoL esports state → patch the relevant constant(s) → `node tools/check.mjs` →
`node tools/smoke.mjs` if anything touched rendering → commit → push. GitHub Pages
rebuilds automatically in ~1 minute, and `deployed.yml` confirms it landed.
