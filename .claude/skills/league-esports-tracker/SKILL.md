---
name: league-esports-tracker
description: Update Tom's League Esports Tracker (index.html, formerly branded NexusDesk) with current researched data. Use this skill whenever Tom says "update the league esports tracker", "update the league tracker", "update the tracker", "update the nexusdesk", "refresh the tracker", "update the power rankings", "update the honours", "new patch for the lol tracker", or asks for any data refresh, format check, or feature work on the tracker. Also trigger when Tom asks to verify playoff formats, tournament winners, or power rankings for the tracker. This skill researches current LoL esports state via web search and Leaguepedia/Liquipedia, then patches ONLY the baked-in data constants in index.html, verifies syntax, and commits + pushes.
---

# League Esports Tracker Update

Tom maintains the **League Esports Tracker** (formerly NexusDesk) — a single-file, dark-theme,
offline-capable HTML dashboard (`index.html`, this repo) tracking LoL esports across LEC, LCK,
LPL, LCS. Live data (schedules, live games, standings, team logos) comes from the unofficial
lolesports API at runtime and needs NO maintenance. Only the **baked-in constants** go stale
and need periodic research + patching.

## Trigger workflow

1. Work from the repo's `index.html` as-is — read it fresh each session rather than assuming
   it matches memory of a past session; it may have drifted.
2. Ask (or infer from Tom's message) which of the update areas below he wants. Default = full
   refresh of all baked-in data.
3. Research (see per-area sourcing below). NEVER invent results, scores, points, or formats.
   If a value can't be verified, keep the old value and say so in the changelog.
4. Patch via targeted string replacement of the named constants only — small surgical diffs,
   not rewrites.
5. Verify: extract the inline `<script>` block and run `node --check` on it (see CLAUDE.md for
   the exact command). Must pass before continuing.
6. Commit and push, with a changelog-style commit message listing every value changed and its
   source. Tom's localStorage state (sim brackets, caches) survives because keys and element
   IDs are untouched — see CLAUDE.md ground rules on the `nexusdesk_` prefix.

## Baked-in data blocks (all in the single `<script>` in index.html)

| Constant | What it holds | Update cadence |
|---|---|---|
| `POWER_RANKINGS` + `POWER_RANKINGS_ASOF` | Mirror of lolesports.com Global Power Rankings: team, region, pts, W/L, movement | Whenever Tom asks; weekly-ish |
| `HONOURS` | Season honours board: First Stand, LEC Versus/Spring, LPL splits, MSI, EWC, KeSPA Cup, Worlds | After each tournament concludes |
| `STORYLINES` | 4-5 season narrative bullets on the Home tab | When honours change |
| `FORMATS` | Playoff bracket wirings (de6 LEC, de6b LCK/LCS byes, de10 LPL, de8, se4) | If Riot changes a playoff format |
| `REGIONS` | Per-region: `splitLabel`, `defaultGames` (regular-season game count for the predictor), `defFormat`, channel/wiki URLs | At split boundaries |

## Research sourcing per area

**Power rankings** — the official table lives at lolesports.com/power-rankings, which is
JS-rendered and NOT fetchable. Strategy: (1) web search for recent articles mirroring the
current rankings (Sheep Esports, Dot Esports etc. cover big movements); (2) if search can't
establish the full current top-10 with points, ASK TOM for a screenshot of the page — he does
this happily. Parse team/pts/W-L/movement from the screenshot. Never guess points. Update
`POWER_RANKINGS_ASOF` to the date shown.

**Honours & winners** — web search first, then Leaguepedia (`lol.fandom.com`) and Liquipedia
(`liquipedia.net`) pages for the specific tournament. Record: winner, runner-up, series score,
venue/city, FMVP, and one implication line (seeds earned etc.), matching the existing `HONOURS`
entry style. Mark upcoming events `done:false`. Non-Riot events count too: EWC, KeSPA Cup,
Demacia Cup, NEST — Tom wants these tracked.

**Playoff formats** — fetch the Liquipedia playoffs page for each split, e.g.
`liquipedia.net/leagueoflegends/LCK/2026/Playoffs` (search for the page first). Read the
bracket column headings + seed entry points. Known 2026 state for reference: LEC = 6-team DE,
seeds 1-4 upper / 5-6 lower (`de6`); LCK & LCS = 6-team DE with seeds 1-2 bye to Round 2
(`de6b`); LPL Split 3 = 10-team DE, top-6 Ascend + 4 via Knights Rivals, seeds 1-2 bye to
Semis (`de10`). If a NEW format is needed, add a `FORMATS` entry using the existing schema:
`{id, g:'group label', col, row(1=upper,2=lower,0=span), s:['seed:N'|'w:Mx'|'l:Mx' x2]}` and
VERIFY the graph before delivery: total matches = 2N-2 for double elim (N-1 for single elim);
every upper-bracket match's loser consumed exactly once downstream (lower-bracket losers are
eliminated, consumed zero times); every non-final winner consumed exactly once; each seed used
exactly once. Add a matching `<option>` to the format dropdown in `buildRegionPage`.

**Split labels / game counts** — from Leaguepedia season pages. `defaultGames` = games per
team in the regular season (drives the record predictor defaults).

## Patching rules

- Read the file first; don't assume it matches training memory or a past session.
- NEVER rename constants, element IDs, or the `nexusdesk_` localStorage key prefix — Tom's
  saved brackets, caches, and settings depend on them. See CLAUDE.md.
- Never quote article prose into the file; write facts in Tom's terse dashboard style.
- Keep team names consistent with lolesports API naming (e.g. "Bilibili Gaming", "Anyone's
  Legend", "kt Rolster") so logo matching keeps working.
- After patching: `node --check` the extracted script before committing.

## Feature work (not just data)

If Tom asks for new features in the same session, follow the repo's established conventions
(see CLAUDE.md): single file, no build step, lolesports.com dark theme (pure black canvas,
cyan accent, region colours LEC teal / LCK silver / LPL red / LCS blue), corner-bracket panels,
Barlow Condensed / IBM Plex Mono / Inter, localStorage persistence, graceful offline fallback
for every network call. Big readable fonts — Tom reads this at a glance.

## Delivery

Commit the updated `index.html` with a changelog-style message listing every value changed and
its source, then push. GitHub Pages rebuilds automatically in ~1 minute. If power rankings came
from a Tom screenshot, note the as-of date he gave in the commit message.
