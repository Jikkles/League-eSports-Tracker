---
name: league-esports-tracker
description: Update Tom's League Esports Tracker (index.html in the League-eSports-Tracker GitHub repo, formerly branded NexusDesk / LeagueEsportsTracker.html) with current researched data. Use this skill whenever Tom says "update the league esports tracker", "update the league tracker", "update the tracker", "update the nexusdesk", "refresh the tracker", "update the power rankings", "update the honours", "new patch for the lol tracker", or references index.html in this repo and asks for any data refresh, format check, or feature work. Also trigger when Tom asks to verify playoff formats, tournament winners, or power rankings for the tracker. This skill researches current LoL esports state via web search and Leaguepedia/Liquipedia, then patches ONLY the baked-in data constants in the single-file HTML, verifies syntax, commits, and pushes.
---

# League Esports Tracker Update

Tom maintains the **League Esports Tracker** (formerly NexusDesk) — a single-file, dark-theme, offline-capable HTML dashboard
tracking LoL esports across LEC, LCK, LPL, LCS, themed to closely match lolesports.com (cyan accent,
pure-black surfaces, Inter typography, pill-shaped controls). Live data (schedules, live games, standings,
team logos) comes from the unofficial lolesports API at runtime and needs NO maintenance. Only the
**baked-in constants** go stale and need periodic research + patching.

Lives at `index.html` in the root of this repo (`League-eSports-Tracker`, github.com/Jikkles), served live via
GitHub Pages at `jikkles.github.io/League-eSports-Tracker/`. The filename must stay exactly `index.html` —
renaming it breaks Pages hosting.

## Trigger workflow (Claude Code / repo context)

1. Read the current `index.html` from the repo working directory — never regenerate from scratch; it may
   have drifted from what you remember from chat sessions.
2. Ask (or infer from his message) which of the update areas below he wants. Default = full refresh of
   all baked-in data.
3. Research (see per-area sourcing below). NEVER invent results, scores, points, or formats. If a value
   can't be verified, keep the old value and say so in the changelog.
4. Patch via python (str_replace/bash) — targeted replacement of the named constants only.
5. Verify: extract the `<script>` block and run `node --check` on it. Must pass before committing.
6. Commit with a clear message (e.g. "Update power rankings as of 11 Aug") and push to `main`. GitHub
   Pages rebuilds automatically within ~1 minute.
7. Summarise in chat: every value changed with its source. Remind Tom his localStorage state (sim
   brackets, caches) survives because keys and element IDs are untouched, and that his phone may need a
   pull-to-refresh to see the update since it's cached as a home-screen app.

## Baked-in data blocks (all in the single <script> in index.html)

| Constant | What it holds | Update cadence |
|---|---|---|
| `POWER_RANKINGS` + `POWER_RANKINGS_ASOF` | Mirror of lolesports.com Global Power Rankings: team, region, pts, W/L, movement | **Automated** — `tools/gpr.mjs`, nightly. Never hand-edit |
| `HONOURS` | 2026 honours board: First Stand, LEC Versus/Spring, LPL splits, MSI, EWC, KeSPA Cup, Worlds | After each tournament concludes |
| `STORYLINES` | 4-5 season narrative bullets on the Home tab | When honours change |
| `FORMATS` | Playoff bracket wirings (de6 LEC, de6b LCK/LCS byes, de10 LPL, de8, se4) | If Riot changes a playoff format |
| `EVENT` | The international-event tab: Worlds 2026's dates, host, field, stages, wordmark, wiki links, and `qual` — the qualification board (per-region `routes` with the date each place is settled, and `thru`, the teams already through) | As each region's places are decided; roll it on once the event is played |
| `REGIONS` | Per-region: `splitLabel`, `defaultGames`, `defFormat`, `cuts`/`groupCuts` (playoff/play-in qualification lines), channel/wiki URLs | At split boundaries |

## Research sourcing per area

**Power rankings** — no research needed any more, and no hand-editing. `tools/gpr.mjs` scrapes the
official board at lolesports.com/en-GB/gpr/<year>/current and rewrites the whole `/* GPR:generated */`
block nightly. If Tom asks for a rankings refresh, run `node tools/gpr.mjs` (add `--dry-run` first to
show him what would change) and commit that — do not go looking for articles or ask for a screenshot.
If the scrape fails, say so rather than filling the block in by hand; a hand-edit is overwritten on the
next nightly run and the two sources then disagree.

**Worlds qualification** — Leaguepedia's participants table on the tournament page (`lol.fandom.com/wiki/2026_Season_World_Championship`) is the source of record; it lists every seed, its qualification path and the date it is settled. Fetch it as wikitext via the MediaWiki API (`/api.php?action=parse&page=...&prop=wikitext&format=json`) — plain page fetches are blocked, and Liquipedia refuses them outright. Resolve team names through the lolesports `/getTeams` feed rather than the wiki's short codes, so the spelling matches everything else on the page. Never place a team on a seed the wiki has not assigned it.

**Honours & winners** — web_search first, then Leaguepedia (`lol.fandom.com`) and Liquipedia
(`liquipedia.net`) pages for the specific tournament. Record: winner, runner-up, series score,
venue/city, FMVP, and one implication line (seeds earned etc.), matching the existing `HONOURS` entry
style. Mark upcoming events `done:false`. Non-Riot events count too: EWC, KeSPA Cup, Demacia Cup, NEST.

**Playoff formats & qualification cuts** — fetch the Liquipedia playoffs/standings page for each split.
Known 2026 state for reference: LEC = 6-team DE single table, top 6 qualify (`de6`, `cuts:[{after:6,kind:'po'}]`);
LCS = 6-team DE single table, top 6 qualify (`de6b`, same cut shape); LCK = Legend/Rise groups
(`groupCuts`: Legend top 2 → playoffs, Legend 3-5 & Rise 2-4 → play-in, Rise 5th out); LPL Split 3 =
Ascend/Nirvana groups (`groupCuts`: Ascend top 6 → playoffs, Ascend 7-8 & Nirvana top 2 → play-in). If a
league's group structure or cut points change, update `groupCuts`/`cuts` in `REGIONS` — this drives the
cyan (playoff) / dashed (play-in) lines drawn in the standings tables, so verify against the official
bracket rather than assuming last split's shape carries over.

If a NEW bracket format is needed, add a `FORMATS` entry using the existing schema:
`{id, g:'group label', col, row(1=upper,2=lower,0=span), s:['seed:N'|'w:Mx'|'l:Mx' x2]}` and VERIFY the
graph before delivery: total matches = 2N-2 for double elim (N-1 for single elim); every upper-bracket
match's loser consumed exactly once downstream (lower-bracket losers are eliminated, consumed zero
times); every non-final winner consumed exactly once; each seed used exactly once. Add a matching
`<option>` to the format dropdown in `buildRegionPage`.

**Split labels / game counts** — from Leaguepedia season pages. `defaultGames` = games per team in the
regular season (drives the record predictor and GL column defaults): 2026 values are LEC 9 (single RR
Bo3), LCK 15 (Rounds 3-4), LPL 14 (Ascend double RR), LCS 14.

## Patching rules

- Patch with python string replacement (or str_replace) on the exact current constant text — read the
  file first; don't assume it matches training memory. Small surgical diffs only.
- NEVER rename constants, element IDs, or localStorage key prefixes (`nexusdesk_`) — Tom's saved
  brackets, caches, and settings depend on them.
- Never quote article prose into the file; write facts in Tom's terse dashboard style.
- Keep team names consistent with lolesports API naming (e.g. "Bilibili Gaming", "Anyone's Legend",
  "kt Rolster") so logo matching and the team-code abbreviation fallback keep working.
- File must remain named `index.html` — never rename it during patching.
- After patching: `node --check` the extracted script before committing.

## Feature work (not just data)

If Tom asks for new features in the same session, follow his established conventions: single file, no
build step, lolesports.com-style theme (cyan `#0BC6E3` accent, pure-black `#000`/`#111`/`#181818`
layered surfaces, pill-shaped buttons/chips, heavy title-case Inter headings, region colours LEC teal /
LCK silver / LPL red / LCS blue), localStorage persistence, graceful offline fallback for every network
call (including the CORS-proxy fallback chain in `api()` for mobile/file:// contexts), large readable
fonts — Tom reads this at a glance, often on his phone.

## Delivery

Commit updated `index.html` to `main` with a clear commit message, push, and confirm the push succeeded.
Give Tom a chat changelog with sources. End by reminding him GitHub Pages takes about a minute to rebuild, and his phone (added to
home screen) may need a pull-to-refresh or a close-and-reopen to pick up the change since it's cached.
