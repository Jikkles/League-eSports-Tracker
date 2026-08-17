# League Esports Tracker

A single-file, offline-capable dashboard tracking LoL esports (LEC, LCK, LPL, LCS) —
schedules, live games, standings, power rankings, honours, playoff bracket predictor.
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
  and the file-size budget. `.github/workflows/health.yml` runs it on every push and PR,
  so a broken edit fails CI rather than reaching Pages.
- **For anything that touches rendering**, also run `node tools/smoke.mjs` — it opens the
  real page in a browser and is the only check that catches a parse-clean edit which
  throws on first render. It needs playwright, installed *without* a package.json:
  ```
  npm install --no-save playwright && npx playwright install chromium
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

## Generated data: the DRAFTS block

`DRAFTS` sits between `/* DRAFTS:generated */` and `/* DRAFTS:end */` markers in the
script. **Never hand-edit it** — `tools/drafts.mjs` rewrites the whole block.

It exists because the lolesports API publishes no pick/ban order anywhere, and roughly
1% of completed games are missing from its live-stats feed entirely (HTTP 204 at any
timestamp). gol.gg has both, but sends no `Access-Control-Allow-Origin`, so the page can
never fetch it at runtime — the data has to be baked in ahead of time.

- `node tools/drafts.mjs --dry-run` — report what would change, write nothing
- `node tools/drafts.mjs` — patch `index.html` in place
- `.github/workflows/drafts.yml` runs it daily at 06:00 UTC and commits any change

The script is incremental (recorded games are skipped) and throttled to ~1 req/sec —
gol.gg is a small Patreon-funded site, so don't remove `POLITE_MS`. Scope is the current
split only, which keeps the block to tens of KB rather than hundreds.

**At split boundaries** the `LEAGUES[].golgg` tournament names in `tools/drafts.mjs` go
stale (`LEC 2026 Summer Season`, `LCK 2026 Rounds 3-4`, …). The script fails loudly with
"tournament … returned no played matches" rather than silently writing nothing — when
that happens, find the new name from a gol.gg game page `<title>` and update the map.

## Automation

Five things run without anyone asking:

- `.github/workflows/health.yml` — `tools/check.mjs` on every push and PR
- `.github/workflows/smoke.yml` — `tools/smoke.mjs` on every push and PR, and daily at 07:30 UTC
- `.github/workflows/drafts.yml` — `tools/drafts.mjs` daily at 06:00 UTC, commits changes
- `.github/workflows/api-canary.yml` — `tools/api-canary.mjs` daily at 07:00 UTC
- GitHub Pages rebuild on push to `main`

The three checks answer different questions and none of them substitutes for another:
`check.mjs` asks whether the script *parses*, `api-canary.mjs` asks whether the API
*answers*, and `smoke.mjs` asks whether the page *works* — it serves the repo over http,
opens it in headless chromium against a cold profile (so, empty localStorage: the
first-visit path), and checks the nav, home board, all four league tabs, standings rows
and bracket wiring, failing on any uncaught exception or console error.

Because it needs the live API, a genuine upstream outage turns the smoke run red; the
canary issue is the explanation when that happens.

The canary walks the same lolesports API calls the page walks, in the same order with the
same fallbacks, and asserts the shapes the render code reads. It exists because the API is
unofficial and reached with a public key lifted from Riot's web client — when that key
rotates or a payload moves, the page renders empty tables rather than erroring, so nothing
tells you. On failure it opens a single `api-canary`-labelled issue, updates it in place on
subsequent runs, and closes it once the API recovers. An empty `getLive` (nothing on air)
and a league sitting between splits are treated as normal, not failures.

## Workflow

Typical session: research current LoL esports state → patch the relevant constant(s) →
`node tools/check.mjs` → commit → push. GitHub Pages rebuilds automatically in ~1 minute.
