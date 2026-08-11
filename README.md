# League Esports Tracker

**[jikkles.github.io/League-eSports-Tracker →](https://jikkles.github.io/League-eSports-Tracker/)**

A single-page dashboard for following professional League of Legends esports — LEC, LCK, LPL and
LCS — in one dark-theme, mobile-friendly view. Built as a personal fan tool, not affiliated with
Riot Games or any league.

## What it does

- **Home** — live matches happening right now, a 48-hour agenda across every region, a global
  power rankings sidebar, the season honours board, and a rundown of current storylines.
- **Per-region tabs (LEC / LCK / LPL / LCS)** — where to watch (with an embedded live player when
  a broadcast is on), recent results, the current standings table with playoff/relegation cut
  lines, the upcoming schedule, and a "so far this season" honours summary.
- **Team profiles** — click any team to see its record, current form/streak, a model-estimated
  power rating, and every game it's played, live, or has coming up.
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
