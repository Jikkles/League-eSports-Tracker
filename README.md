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
the repo folder, just run `claude` and ask for what you want updated.

## Disclaimer

Unofficial fan project. Not affiliated with or endorsed by Riot Games, LEC, LCK, LPL, LCS or any
of the teams/organisations shown.
