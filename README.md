# League Esports Tracker

**[jikkles.github.io/League-eSports-Tracker →](https://jikkles.github.io/League-eSports-Tracker/)**

A single-page dashboard for following professional League of Legends esports — LEC, LCK, LPL and
LCS — in one dark-theme, mobile-friendly view. Built as a personal fan tool, not affiliated with
Riot Games or any league.

## What it does

- **Home** — a one-page board: today's live/upcoming/completed counts with a per-region
  breakdown, a live panel naming whatever is on air right now (or counting down to the next
  match when nothing is), Next Up and Recent Games side by side with per-region filters, the
  global power rankings, the season honours board, and a rundown of current storylines.
- **Per-region tabs (LEC / LCK / LPL / LCS)** — where to watch (with an embedded live player when
  a broadcast is on), recent results with per-game VOD links, the current standings table with
  playoff and play-in cut lines, the upcoming schedule, and a "so far this season" honours
  summary.
- **Team profiles** — click any team to see its record, current form/streak, a model-estimated
  power rating, and every game it's played, live, or has coming up.
- **Series boards** — click any finished series, anywhere it appears, to open it game by game:
  both line-ups with champion portraits, each player's KDA, level, CS and gold, the team totals
  for kills, gold, towers, drakes and barons, the ten bans, which team drafted first, and the
  winner of each game. Teams hold the same column throughout, so sides are read off the
  BLUE/RED chip rather than the layout.
- **Playoff Simulator** — an interactive bracket predictor per region: set win probabilities (or
  let the model estimate them) and simulate the playoffs to see title odds.

## How it works

- **Live data** — schedules, live game state, standings and team logos are pulled at runtime from
  the same unofficial public API that powers lolesports.com. If a browser blocks the direct
  request, the app automatically falls back through a couple of public CORS proxies.
- **Baked-in data** — things that don't come from that API (global power rankings, the honours
  board, season storylines, playoff bracket formats) are hand-researched and stored as constants
  in the file, refreshed periodically from [Leaguepedia](https://lol.fandom.com) and
  [Liquipedia](https://liquipedia.net).
- **Drafts** — the LoL Esports API publishes no pick/ban order, and about 1% of completed games
  are missing from its live-stats feed altogether. [gol.gg](https://gol.gg) has both but sends no
  CORS headers, so the page can't fetch it at runtime. `tools/drafts.mjs` scrapes it and bakes the
  result into `index.html`; a GitHub Action re-runs it daily, so the site keeps itself current
  with no manual step.
- **State** — your saved playoff-bracket simulations and caches persist locally in your browser
  via `localStorage`. Nothing is sent to a server; there is no backend.
- **Keeping itself honest** — because there's no build step, a broken hand-edit would otherwise
  go straight to the live site, and the unofficial API can move without warning. Six checks run
  on their own, each asking a different question:

  | | question it answers |
  |---|---|
  | `tools/check.mjs` | does the page parse, and is the baked-in data structurally sound? |
  | `tools/api-canary.mjs` | does the unofficial API still answer in the shape the page reads? |
  | `tools/smoke.mjs` | does the page actually render, in a real headless browser — on a phone, for a screen reader, and with the API pulled out from under it? |
  | `tools/stale.mjs` | is the hand-researched data still true, or has the season moved on? |
  | `tools/deployed.mjs` | is the live site serving the commit that was just pushed? |
  | `tools/links.mjs` | do the wiki and stream links baked into the page still go anywhere? |

  Each raises a single GitHub issue when it fails, updates that issue in place rather than
  piling up duplicates, and closes it automatically once the problem clears. `stale.mjs` is
  the one that turns "remember to check the data" into "the repo tells you": it compares the
  baked-in constants against the live sources daily and reports what has drifted, down to
  which constant to edit.

## Tech

It's deliberately one file: `index.html` contains all the markup, CSS and JavaScript. No build
step, no dependencies, no framework. Open it directly in a browser or serve the folder with
anything static (e.g. `python -m http.server`) to work on it locally.

Deployed via GitHub Pages straight from `main` — every push rebuilds the live site in about a
minute.

## Updating the data

This repo is set up for [Claude Code](https://claude.com/claude-code): `CLAUDE.md` documents the
project's ground rules, and `.claude/skills/league-esports-tracker/` contains a skill that
researches current standings/results/formats and patches the relevant constants for you. From
the repo folder, just run `claude` and ask for what you want updated. Running
`node tools/stale.mjs` first will tell you what actually needs attention.

The same job also runs weekly in CI (`.github/workflows/research.yml`), opening a pull request
rather than pushing — because the rule for this data is *never invent a score, a points total or
a format*, and the only way to hold a bot to that is to read the diff. It stays dormant until an
`ANTHROPIC_API_KEY` repository secret is added.

## Disclaimer

Unofficial fan project. Not affiliated with or endorsed by Riot Games, LEC, LCK, LPL, LCS or any
of the teams/organisations shown.
