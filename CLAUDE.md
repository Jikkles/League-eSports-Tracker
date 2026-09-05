# League Esports Tracker

A single-file, offline-capable dashboard tracking LoL esports (LEC, LCK, LPL, LCS) —
schedules, live games, standings, power rankings, honours, playoff race odds, playoff
bracket predictor.
Deployed via GitHub Pages straight from this repo.

## Ground rules

- **Single file.** Everything the browser loads — markup, CSS, JS, data — lives in
  `index.html`. No build step, no bundler, no package.json. Edit it directly. The
  things outside it are the scripts in `tools/` — `drafts.mjs` and `gpr.mjs` (see
  below) — which are tooling, not part of the page: they *write into* `index.html`
  rather than shipping a second file to the browser.
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
  the file-size budget (400 KB warns, 600 KB fails — `SIZE_BUDGET` / `SIZE_CEILING`;
  both are the project's own numbers, not limits anything outside it enforces, and
  the check prints the gzipped size beside the raw one because that is the half a
  visitor actually pays),
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
    format, channel/wiki links, and `rank` (how the league orders its table — see
    the playoff race section). Two optional fields cover leagues that do not fit
    one number: `groupGames` where a league's groups are different sizes and so
    play different seasons (LPL Ascend 14, Nirvana 6), and `tableSpans` where the
    regular season is filed as more than one tournament (see below)
  - `EVENT` — the international-event tab: the next major (Worlds 2026), its
    dates, host, field, stages, wordmark, wiki links and `qual`, the
    qualification board of who is through and what decides the rest. See the
    section below
  - `HONOURS` — season honours board (tournament winners, runners-up, dates)
  - `STORYLINES` — home-tab narrative bullets
  - `POWER_RANKINGS` + `POWER_RANKINGS_ASOF` — mirror of lolesports.com Global Power
    Rankings. **No longer hand-maintained** — `tools/gpr.mjs` rewrites both nightly
    (see the GPR block below). Left in this list because everything else here reads
    it: `isTop10()` badges a top-10 clash on the schedule, and the simulator's
    `rating()` uses `pts` as a team's base strength
  - `FORMATS` — playoff bracket wirings, one per bracket the four leagues
    currently run and no more (`de6` LEC, `de6b` LCK/LCS, `de8b` LPL). Retiring
    one is safe: `simLoad()` falls back to the region's default when a viewer's
    saved format has gone, so add and remove them as the leagues change rather
    than keeping a museum of past brackets in the dropdown.
    **Not every edge in a bracket is a wire** — see the `pick` section below
- When patching baked-in data: research via web search / Leaguepedia (`lol.fandom.com`)
  / Liquipedia (`liquipedia.net`), never invent scores/points/formats — if a value can't
  be verified, leave it and say so. Make targeted string replacements, not rewrites.
- **`node tools/stale.mjs` says what needs patching.** It compares the constants above
  against the live API and gol.gg and reports drift as either STALE (provably out of
  date — a split label naming the wrong split, a `defaultGames` the standings have
  already exceeded, a `groupCuts` key no longer matching any group, a cut line past the
  end of its table, a ranking rule that no longer reproduces the last published table, a
  rankings mirror older than three weeks) or NOTE (a judgement call
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
  gets its group's regular-season allowance (`gamesForGroup()` — `REGIONS[].groupGames`
  where the groups are different sizes, `defaultGames` otherwise), and once that is
  spent every later fixture it appears in is a bracket game. Keep those current or
  the panel silently races the wrong games. Quota alone is no longer the whole story:
  the completed-games walk also skips `RACE_BLOCK_RX` blocks, because a window that
  spans a whole season contains mid-season knockouts (the LCK's Road to MSI) that
  would otherwise eat the allowance before the later rounds were reached.

- **`REGIONS[].tableSpans` is for a league whose regular season Riot files as more
  than one tournament.** The LCK plays one four-round season; the API publishes
  Rounds 1–2 and Rounds 3–4 as separate tournaments, each carrying only its own
  records — but the Legend/Rise groups are ranked on all 26 games. That mismatch is
  what made the panel disagree with the league: DN SOOPers went 5–3 in Rounds 3–4
  and still finished last in Rise, having gone 1–17 before it, so the page drew them
  below the qualification line and marked them clinched in the same row.
  `tableSpans:2` makes `fetchStandings()` add the earlier tournament's records in and
  widens `tableEvents()` — a window kept deliberately separate from `splitEvents()`,
  because the table spans the season but "this split's results", the form dots and
  the schedule modal still mean this split. Fed the whole season, the page's existing
  ranking chain reproduces the feed's own ordinals exactly, in both groups.

- **The feed's ordinal and the page's ranking must tell one story.** The rank column
  and cut line are drawn from `standingsCache` ordinals; the Range column, the odds
  and the status chips are computed. When those two disagree the panel renders a row
  below the line labelled *Locked*, and every arithmetic check stays green — the odds
  still sum to the number of places. `smoke.mjs`'s "race table agrees with itself"
  check reads the rendered table back and holds the halves against each other. If it
  fires, the question is which half is wrong: the feed is authoritative on a league's
  own tiebreaks, so suspect the page's inputs (the games window, the game count)
  before the ranking rule.
- **Cuts come from `cutsForGroup()`**, shared with the standings table so the line one
  draws and the line the other measures against cannot drift apart. Grouped leagues
  (LCK Legend/Rise, LPL Ascend/Nirvana) race inside their group.
- **Scorelines rank teams, not just match wins.** This is the rule the panel used to get
  wrong. The LEC rulebook (2026 season, v3.1) §6.1.2/§6.3.5: "Standings at the end of
  the Regular Season will be determined by the amount of Matches won and Game Win
  Percentage" — game win % across the *whole split*, as a ranking key, before any
  head-to-head tiebreak is reached. A 2–0 is worth more than a 2–1, and a team can be
  passed without losing a match, which is why the panel used to disagree with the
  broadcast. Only teams level on both reach §6.6: head-to-head match record, head-to-head
  game win %, strength of victory (§6.7, by matches won then games won), then the Spring
  standings.
- **`REGIONS[].rank` is that order, first key first**, and `raceMetric()` implements one
  metric per name (`wins`, `gamePct`, `h2h`, `h2hGamePct`, `sov`, `sovGames`).
  `check.mjs` rejects a name the engine does not answer to, because an unknown metric is
  skipped in silence and the table then ranks on whatever is left. All four leagues rank
  the same way for the first four; only the LEC has a published rule beyond them.
- **§6.6.2 restarts the chain**, and `raceSplitRuns()` recurses rather than walking down
  the list: the moment a metric separates anyone they are placed, and whoever is still
  level starts again from the first tiebreak — so a three-way tie that head-to-head
  splits 2/1/1 sends the two survivors back to their own head-to-head, not on to the
  next metric.
- **An unplayed Bo3 has no scoreline, so the scoreline is enumerated too.** `raceCluster()`
  branches every game a tied cluster has left over its possible scorelines, weights each
  by the model (`raceScoreWeights()`, from the per-game edge: 2–0 at 1/(1+2q)), runs the
  chain on each, and reports the distribution. A place can be held in 60% of the ways the
  games fall, and the odds now say so rather than pretending the question is not there.
  Branching is per cluster rather than per ending — only teams level on match wins care —
  and cached on (cluster, who won their games), which is what keeps a 65,536-ending
  enumeration under a quarter of a second.
- **What the rules still cannot split is a shared band**, counted as a fraction of a
  place and marked `=` in the Range column: after strength of victory the LEC goes to the
  Spring standings, which this page does not hold. Do not invent a deeper tiebreak — the
  same rule as the constants. If you implement one, implement the *published* one and
  only where real data backs it.
- **`stale.mjs` checks the rule against reality**, by rebuilding the last finished split
  of each league from the schedule, ranking it with the functions lifted out of
  `index.html`, and comparing against the ordinals the league published. It runs the
  page's own code rather than a copy, so it catches both a rule change and a bad edit to
  the engine. That check is what caught the original bug; re-run it before trusting any
  change in here.
- **`raceCommon()` names what a miss needs**, because "Alive" alone reads as a
  contradiction when a broadcast has just called the same team through. Riot's clinch
  graphics run on wins — a team nobody can pass is safe — while this counts a lost
  tiebreak as out, so a four-way tie for two places can separate the two answers. The
  panel now prints the results every miss has in common ("they only miss out if all of:
  …"), which makes that gap checkable rather than mysterious. Don't resolve such a
  disagreement by softening the maths.
- **A lock can name the scoreline too.** `nexusdesk_race_<slug>` is keyed by match id, so
  a lock on a game that has since been played is dropped rather than applied twice, and
  the value is a side optionally followed by the loser's game count: `a` leaves the
  scoreline to the model, `a0` pins a 2–0 and `a1` a 2–1. Plain `a`/`b` is every lock
  saved before scorelines mattered, so it stays valid and nobody's stored scenario is
  lost. `lockSide()` / `lockScore()` read it; the picker only appears under a game that
  already has a side, because on most games nobody cares.
- **The scenario sentences get their own enumeration.** The odds may leave a scoreline
  weighted, being a sum over endings; a sentence may not, because "they are through if
  they win" is sometimes only true of a 2–0. `raceScen()` walks every remaining result
  *and* scoreline (`RACE_SCEN_MAX`, 4,096) so `raceConditions()` can say "GIANTX beat
  NAVI 2–0 and MKOI beat TH 2–0 — in". Each game takes a whole number of bits so the
  search stays on a bitmask, which needs its option count to be a power of two — a
  regular-season Bo5 is the case that gives up and falls back to naming results only, as
  does a split with too many games left. `raceTerms()` offers the side-only constraint
  before the scoreline one so the shorter true sentence wins.
- **That walk turns the cluster cache off**, and the reason is worth keeping in mind
  before reusing `raceCluster()` anywhere else: the cache keys on *who* won each game,
  which is a complete key while a scoreline's weights follow from its winner, and the
  wrong key the moment scorelines are pinned independently of it.

## A bracket with a choice in it

`FORMATS.de6b` (LCK/LCS) carries a `pick`, and it is the one thing in the
simulator that is not a graph. The LCK's top seed picks its Round 2 opponent
from the two Round 1 winners and the second seed takes whoever is left — a
decision made on a stage, which no wiring can hold. In 2026 Gen.G took KT and
left T1 to Hanwha Life; the fixed wiring drew Gen.G vs T1, and a viewer trying
to replay the split had no way to correct it.

- **`pick` names the two slots that may trade**, as `a: [matchId, slotIndex]`
  and `b: [...]`, plus the button's `label` and a `note` saying whose rule it
  is. `simState[slug].pick` is the boolean recording whether they have.
- **The swap happens before anything resolves, not after.** `simResolve()`
  copies every match's sources, trades the two named slots in that copy, and
  only then walks the bracket — so one swap at the top re-routes the lower
  bracket and the final along with it. Swapping the resolved pairs instead
  would fix Round 2 and leave everything downstream drawing the old bracket.
- **Winners survive a swap.** `simResolve()` already drops the ones the change
  orphans, so a viewer who has played the bracket out does not lose it to a
  pairing correction. Changing *format* still clears both.
- **The note names the LCK and only the LCK.** Both leagues on this format give
  their top seed some bracket-side choice, but only the LCK's is published in a
  form this repo has verified, so that is all the note claims. The button itself
  asserts nothing — it lets a viewer set a pairing, which a simulator may always
  do.
- **`check.mjs` holds the pick to the bracket**: a match id the format does not
  have, or a slot index that is not 0 or 1, swaps nothing at all — the button
  sits there doing nothing while the bracket quietly draws the pairing the
  league did not play. It also requires the label and the note, because a
  control that changes what the bracket claims happened may not be unlabelled.
- **The pick is not how the LCK's 2026 bracket actually maps, and that is worth
  knowing before reaching for it.** Fitting the wiring against the played games
  says so: swapping the two *bye seeds* reproduces all six completed matches
  and projects the next two exactly, while the Round 2 pick swap gets Round 2
  right and the lower bracket wrong (five of six). The reason is that the lower
  bracket takes the seed-2 match's loser first, so the two bye orders route the
  whole lower half differently — which no reading of the Round 2 rule would
  have told you. `simFillFrom()` tries both and lets the feed decide.

## Filling the bracket from what was played

The simulator's first job for most viewers is not "what if" but "show me what
happened", and clicking a double elimination out by hand is ten to twelve
decisions before you can change anything. **"Fill from results"** on every
region page reads the played bracket back out of the feed.

- **Two sides identify a match, never a round name.** Block labels are Riot's
  and they differ by league and by season ("Playoffs", "Finals", "Play In
  Knockouts"); who played whom does not. `simFillFrom()` walks the bracket in
  dependency order — repeated passes until nothing new lands, which needs no
  topological sort — and looks each match up by its pair once both slots
  resolve to real teams.
- **A pair keeps a queue, not a result.** A double elimination sends the same
  two teams back at each other regularly: KT and Dplus KIA met in Round 1 and
  again in the lower bracket a week later. Keyed on the pair alone the second
  result silently overwrote the first, and Round 1 filled with the wrong
  winner. `simRealGames()` queues them in played order and a fill consumes the
  earliest one it has not used.
- **The play-in is excluded deliberately.** It is a different tournament that
  feeds this one, and its losers are not in the bracket at all — matching them
  in fills Round 1 with games the bracket never held.
- **The variant is decided by fit, not by rulebook.** Two things about a real
  bracket are not in the wiring: a format's `pick`, and which way round the two
  bye seeds sit. Every combination is tried and the one reproducing the most
  played games wins, ties going to the ranked order with no swap so the least
  surprising bracket is the default. This is the one place in the repo where a
  question about a league's format is answered by measurement.
- **It says what it did, including when that is nothing.** A league between
  splits and a bracket this wiring cannot express both otherwise leave a button
  that looks broken. The message clears on any other redraw, so a count never
  outlives the bracket it described.
- **What `smoke.mjs` does and does not catch here.** It clicks the real button
  on all four tabs and fails on the two unambiguous bugs: a winner who is not
  one of the two teams in that match, and a fill that places nothing while the
  feed has completed bracket games. It reports the ratio ("6 of 6 played") but
  does **not** fail on a shortfall, because a bracket that genuinely stops
  fitting its wiring is a data question rather than a build failure — that is
  `stale.mjs`'s department, and it does not ask it yet. Watch the ratio.

## The international-event tab

A sixth item leads the nav's tabs, fenced off by a rule on either side: one tab
for the next major the four leagues feed into (right now Worlds 2026), sitting
between the All chip and the leagues because it is the season's main event
rather than a fifth league. It is driven by the `EVENT` constant and, through
`EVENT.feed`, by two calls the four leagues never make. Above the fold it
carries Live Now and then a real qualification board (see `EVENT.qual` below),
in that order, because what is on air outranks what is still to be decided; the
board shares its row with the power rankings and the stage strip sits under it,
taking whatever height is left over — the rankings are a tall column, and the
left of the row otherwise stopped halfway up it and left a hole above the
fixtures. The column stretches rather than starting, the board keeps its
natural size, and the three stage cards grow into the difference. Under the
strip come Next Up and Recent Games, and the published bracket last — it is the
slowest-moving thing on the tab, announced once and then unchanged for weeks,
while the boards above it are why anyone opens the tab twice in a day.

**Everything on the tab is now real except the fixtures, and that is the
tournament's own state rather than the page's.** The qualification board, the
stage windows and the whole bracket wiring are facts. What nobody has is a
schedule: no fixture on this tournament carries a kick-off time and the draw
has not been made, so the three fixture boards keep the `evtRow()` placeholder
— TBD wherever a time, a team or a result will go — and swap themselves for
real rows the day Riot publishes one, with no edit to this file. The *Work in
progress* badge says which half is which. Nothing on the tab is invented: the
host, field and qualification routes come from Leaguepedia's tournament page,
linked from the hero; the stage windows and venues from Riot's own *MSI and
Worlds Updates* post on lolesports.com; and the bracket from the API.

- **`EVENT.stages` carries Riot's published stage schedule, and it is the second
  thing on the tab with facts on it.** Riot announced the windows and the three
  venues long before any fixture had a kick-off time, so the strip prints dates
  where it used to print TBD. Each stage takes `when` (the string a viewer
  reads), `from`/`to` (the same window as ISO dates, so a machine can hold it),
  `venue` — a string, or a **list** for the one stage played in two buildings:
  the quarters and semis stay in Allen and the final moves to Brooklyn six days
  later, which is a fact a single line has to fudge — `detail` for the breakdown
  inside the window, and `sub` for the format. `when` and the ISO pair are the
  same window written twice on purpose: without the pair nothing could check the
  string, so `check.mjs` refuses a `when` that has no `from`/`to`, and then holds
  the window inside `EVENT.start`/`end`, forbids one that runs backwards, and
  requires the strip to be in playing order. `stale.mjs` reads the pair to name
  the stage that should be on air, which turns "under way and still a
  placeholder" into a note pointing at a window a reader can check.
  **A stage window is not a game time.** Per-match times do not exist yet — the
  feed carries none, see `EVENT.feed` below — and nothing on this tab should let
  a viewer read one off the strip.
- **`EVENT.feed` is the tab's whole connection to the API**, and it is two
  fields: `league`, the API's own league slug for the tournament (`worlds` — an
  id that has carried every Worlds since 2011), and `stage`, the slug of the
  stage drawn as a bracket. Everything else follows from those.
  - **`fetchEventSchedule()` filters to `EVENT.start` onwards, and that filter
    is load-bearing.** Because the league id spans every season, an unfiltered
    fetch opens the tab on last year's final under the heading *Recent Games*.
    It also pages back for history *only once there is history to want* — the
    four leagues page back unconditionally, but here a second call before the
    tournament starts fetches 2025 for the filter to throw away.
  - **The schedule caches under `EVENT.slug`, alongside the four leagues, and
    that is deliberate.** It is not the thing the `REGIONS` rule above warns
    about: the walks that mean "a league with a season" all iterate
    `Object.keys(REGIONS)` and never see this key, while the three sweeps that
    iterate the cache itself — `matchFinished()`, the logo harvest and the
    offline check — all want it. The logo harvest is why a Worlds team's crest
    appears at all, given the page fetches four leagues and this tournament
    draws on nineteen teams from six. `check.mjs` refuses an `EVENT.slug` that
    is also a `REGIONS` key, because that collision would overwrite a real
    league's schedule with the tournament's.
  - **`fetchEventBracket()` finds its tournament by date overlap**, not by a
    slug spelt by hand and not by taking the newest. Riot's own tournament
    record for Worlds 2026 reads 20 Oct – 20 Nov where its announcement reads
    15 Oct – 14 Nov, so the two agree on overlapping and on nothing else. The
    id is cached once found; a bracket's shape does not change after it is
    announced.
  - **Both calls are `allSettled` inside the deep refresh.** A tournament this
    page merely previews must never be able to take the four leagues down.
- **The bracket panel is drawn from the feed, and its trick is `origin`.** Riot
  wires the whole tournament before anybody is in it: every match slot carries
  an `origin` naming the match that feeds it, with slot 1 the winner and slot 2
  the loser. `evtOriginLabel()` reads those back, so a bracket nobody has
  played says *Loser of Upper Bracket – Final* where it would otherwise be
  twelve identical rows of TBD — and for a four-team double elimination that
  sends exactly one team on, the route through it is the only question there
  is. A slot whose origin is a `decisionPoint` is a seeding decision rather
  than a match, so it stays TBD: reading Riot's slot numbers as seeds would be
  inventing a draw. Route labels are set in mono and smaller than a team name,
  which is the one thing the panel must not let a viewer confuse. No score box
  is drawn on a match nobody has played.
- **What checks it.** `check.mjs` holds `EVENT.feed.league` to a lower-case
  slug (the page matches league slugs in lower case, so a capital renders an
  empty tab and says nothing). `api-canary.mjs` walks both calls — reading
  `EVENT.feed` out of `index.html` rather than spelling it again, so a rollover
  cannot leave a canary guarding last year's league — and fails if the league
  vanishes, if the named stage goes, or if no slot carries a match `origin`,
  which is the failure that would silently turn the panel back into a wall of
  TBD. It treats *no fixtures yet* as normal, because it is. `smoke.mjs` reads
  the drawn bracket back and fails on a slot that named neither a team nor a
  route, and reads the three fixture boards back for the middle state that an
  exception halfway through `evtFillList()` would leave — rows that are neither
  fixtures nor placeholders. A bracket Riot has not published is **reported,
  not failed**: whether one exists is a data question, and this repo answers
  those in `stale.mjs`.
- **`EVENT` is not a `REGIONS` entry, on purpose.** Every `Object.keys(REGIONS)`
  walk on this page — the home board, the refresh loop, the standings, the race,
  the simulators — means "a league with a season", and a fifth key would have to
  be special-cased out of all of them.
- **The slug is written down three times**: in `EVENT.slug`, in the nav button's
  `data-tab` and in the page section's `id`, because `switchTab()` resolves a tab
  to a section by name and neither half of the markup can see the constant.
  Rolling the tab on to the next event means editing all three — `check.mjs`
  holds them to each other, so getting two of them right fails the build rather
  than rendering a tab that opens a blank page.
- **`EVENT.qual` is the qualification board, and it is the one part of the tab
  with facts on it.** Riot publishes no qualification feed, so it is researched
  and patched by hand like `HONOURS`, from Leaguepedia's participants table on
  the page the hero already links. Each region carries `routes` — the seed
  table, one entry per place, each with the `on` date that place is settled —
  and `thru`, every team already qualified. **Those two lists are deliberately
  not the same list**, because qualifying and being seeded are two different
  games: three Korean teams are at Worlds with every placement that seeds them
  still to be played, and filing any of them under a seed row would be
  inventing a result nobody has played.
- **A `thru` entry says three separable things**, and keeping them apart is what
  lets the board be honest about a team it cannot place. `via` is the route it
  took, and only once that is settled — `check.mjs` holds the name to `routes`,
  and the route is struck off the places still open. `how` is free text for a
  team through by something that is not one of its region's places at all
  (Hanwha Life were at Worlds the day they won MSI, months before Korea seeded
  anybody). `seed` is what gets printed: a number where the games have decided
  it, a list where they have only narrowed it. Left out, it is read off `via`
  — the routes are the seed table — and otherwise falls back to every seed
  nobody has been given. **The list form is a narrowing, not a hedge.** T1
  cannot finish below fourth and BILIBILI GAMING cannot finish below second,
  and a board that only knew "unseeded" could not say either.
- **The board is drawn, and the seed is the one thing written.** A league mark
  per region, then one slot per place that region sends: a filled slot carries
  a team's badge, an empty one is the dashed outline of a place still to be
  played. A team with one seed left to it is drawn in that seed's slot and
  captioned `#3`; a team with several is still only a count, drawn in the
  leftmost slot nobody holds and captioned `#1–4` — which is what stops the
  position it landed in from reading as its seed. Nothing else is printed: the
  routes used to sit under the badges, where they read as a caption for the
  team above them, and they are back in the `title` where a pointer and a
  screen reader get them. Six regions are laid out two-across, and the whole
  panel takes three quarters of the row with the Global Power Rankings in the last quarter —
  `renderRanks()` draws every `[data-ranks]` element on the page rather than
  the one id it used to own, so both boards come from one function and one
  constant.
- **Two things make the crests work.** `LOGO_SLUGS` widens the league-image
  harvest past the four `REGIONS` (LCP and CBLOL have no season here, but they
  have a crest), and each `thru` entry carries its own `logo` URL, seeded into
  the page's logo cache at boot — that cache is otherwise filled from the
  fixtures of four leagues, and half this board plays in leagues the page never
  fetches. Being inside `EVENT`, those URLs are already checked weekly by
  `links.mjs`.
- **What holds it together.** `check.mjs` holds a `thru`'s route name to its
  region's `routes` (a misspelt one renders a place that is already won as
  still open), requires each region's `slug` and an https `logo` (http would be
  blocked as mixed content and fall back to initials on a board where the crest
  is the only name), and holds the place totals to the prose in `EVENT.field`,
  which is the same arithmetic written out twice on one screen. It also holds
  every `seed` inside its region's route table and refuses two teams settled on
  the same one, since the second of those is drawn into the first's slot and
  disappears off the board. `smoke.mjs` reads the slots back against the
  constant and fails on one that drew nothing, carries no title, or left a
  qualified team with no seed under it — and counts the settled captions
  against the constant, because a caption that silently widened to a range is
  the board unlearning something. `stale.mjs` reads the `on` dates back: a
  place whose date has passed while its region is still a team short is STALE,
  one falling within a week is a NOTE, and — the case the arithmetic cannot see
  — a team still drawn across a range of seeds after every place *in that
  range* has been settled is STALE too, because a full region's counts stay
  perfectly happy while the board goes on saying it does not know something the
  league decided days ago.
- **A stale place names the game that settled it.** The board itself cannot be
  fetched, but the *results* behind it can: `getSchedule` serves the LCP and the
  CBLOL as happily as the four leagues with a season on the page, so `stale.mjs`
  quotes the completed knockout games alongside the finding — `30 Aug · Finals ·
  Team Secret Whales 3–0 CTBC Flying Oyster` — and the patch is a lookup rather
  than a research session. It quotes and does not conclude: which route a result
  fills is the rulebook's business, not the feed's, so nothing is written for
  you. Findings carry this as an optional `evidence` array, rendered `<br>`-joined
  in the issue because a newline inside a table cell ends the row.
- **`stale.mjs` is what notices the tab has gone off.** The parts of it that are
  fetched can break loudly; the constant behind it cannot. Once the event
  `EVENT` names has been played, the tab advertises a finished tournament — with
  a bracket that will happily go on rendering the last one — while every other
  check stays green. It reports STALE past `EVENT.end`, and NOTE once the event
  is under way and the fixture boards are still the placeholder, naming the
  stage whose window we are inside so the note points at something checkable.
- **The mark is the event's own wordmark, inlined.** `EVENT.logo` is a data:
  URI — Riot's 2026 wordmark recoloured white for the black canvas, scaled to
  twice the size it is ever drawn at, WebP, about 8 KB of the file budget. It
  was hotlinked from Leaguepedia first and that 404'd for the CI runner while
  serving fine from a desktop: Fandom's CDN answers some networks and not
  others, and every viewer it refuses would have got the text fallback. The
  other crests can afford to be hotlinked — they are one badge among many, each
  with a placeholder — but this one is a whole tab, and inlining also makes it
  the only mark on the page that survives an offline first visit. Being a data:
  URI it is not an http link, so `links.mjs` does not check it; nothing can rot.
  Keep the two wiki links, which it does check.

## The spoiler guard

Somebody who opens this page to see when their team plays next should not have
last night's result thrown at them on the way past. One switch in the header —
**Scores hidden** — governs the whole page, and it is on by default.

**The line it draws is a specific match result versus aggregate season state**,
and that line is the whole design. "T1 beat HLE 3–1 on Tuesday" destroys a game
you have not watched; "T1 are 17–9, third in Legend Group" tells you almost
nothing about any single game and is the reason you opened the tab. Guarding by
*panel* instead recurses without end — hide the standings and the race panel
below it still says ELIMINATED, hide that and the simulator seeds from the
table — so panels are never the unit. Anything new on the page gets asked the
one question instead: does this reveal a match, or a season?

What that puts on the guarded side:

- **Every results board** — the home board's **Recent Games**, the event tab's,
  and each region page's **Recent Results**. The fixture is drawn in full (the
  date, both crests, both team codes, the round, the Bo) and only the score is
  withheld, behind a per-match click.
- **Every score on a match still being played**, which is the same result one
  refresh early: the Live Now cards on the home board and the event tab, and the
  live row on a region page's Schedule. 1–0 in a Bo5 hands over game one as
  plainly as a finished 3–1 hands over the series — and so does the card's
  **Game N** label, since a Bo5 on game 5 is 2–2 whether the score beside it is
  drawn or not. Both go together, and the card falls back to saying *Live*. What
  is never guarded is the dash a broadcast with no published score already
  carries: there is nothing behind it to reveal.
- **The standings' Form and Streak columns**, which are the two columns of that
  table that are not standings: the last five matches drawn as pips, and the
  current run. `L2` says you lost on Tuesday.

And what stays plainly visible: W / L / Win% totals, the playoff race's odds,
ranges and LOCKED/ELIMINATED chips, the simulator, the honours board and the
storylines. All of those are the season rather than a game — and the last two
are editorial, which no mechanism can guard without gutting them. If the home
board needs to be spoiler-safe end to end, that is a writing decision.

### How it is built

**There are three row shapes and all three are guarded.** `.nxt`, built by
`renderRecent()` and `evtFixRow()` and scored by the shared `scoreCellHTML()`;
`.match`, built by `matchRow()` for the region pages; and `.lcard`, built by
`liveCard()` for either Live Now panel. They have different tells, which is the
thing to remember when any of them is next edited — a change that guards one
shape and not the others looks completely fine on the tab you happened to be
looking at.

- **Hiding the number is not hiding the result.** The `.nxt` row also dims the
  loser's crest and code and paints the winner's score green. The `.match` row
  does neither — instead it puts a green diamond beside the winner's name,
  which answers the question on its own. The `.lcard`'s tell is not a score at
  all: **Game 5** of a Bo5 is 2–2 however carefully the number beside it is
  covered. Every one of those is suppressed alongside the number by a `spoil`
  class on the row. Leaving one behind is the bug this feature is most likely to
  grow, so `smoke.mjs` checks the dimming, the diamond and the game number by
  name rather than only checking that the score went away.
- **Two mechanisms, because there are two kinds of question.** A score is a
  per-match question and gets a per-match reveal: the button is drawn on every
  row carrying a score, live or finished, and the row's `spoil` class decides
  whether button or score is painted. Form is a *mode* — nobody wants one
  team's form — so it is masked wholesale off a single `spoil-free` class on
  `<body>`, with `sp-cell` / `data-mask` giving the cell a placeholder. Anything else that turns out to
  need masking later says so in its markup rather than in a new mechanism.
- **Everything is `visibility:hidden`, never `display:none`.** Cells keep their
  boxes, so nothing reflows when the switch is flipped, and the content leaves
  the accessibility tree, which `opacity` would not do. That is also what makes
  `applySpoil()` possible: the switch flips classes across the page instead of
  re-rendering the home board, the event tab and four region pages — three of
  which are expensive, and one of which would collapse any series the viewer
  had open.
- **Two pieces of state that deliberately differ.** `spoilFree` is the viewer's
  standing preference and persists in `nexusdesk_spoilerFree`. `spoilShown` is
  the handful of rows opened in this visit and does **not** persist: coming back
  later hides them again, which is the whole point. Turning the guard back on
  clears it, because a guard still open on the twelve results you already looked
  at is not a guard.
- **A reveal applies to every copy of that fixture**, not to the row that was
  clicked — the same match is a `.nxt` on the home board and a `.match` on its
  region page, and revealing it in one place and not the other would be a guard
  that only half remembers what you asked for. `spoilShown` is keyed by match
  id, and `applySpoil()` re-marks the whole page.
- **One switch, on the nav row, not one per panel.** It was three panel
  buttons first, which read as three separate controls for what was always a
  single page-wide preference. It sits at the far right of the tabs, pushed
  there by an auto margin, because a mode that governs every tab belongs beside
  the tabs rather than tucked in with the clock. It is cyan while the guard is
  on, because a page with scores hidden and nothing saying so looks like a page
  with missing data.
  Below **1249px** it drops to the icon alone, and that number is measured
  rather than picked: the tabs and their two rules take 1022px, so the labelled
  pill only fits on that row from about 1250px up, and below it the nav wraps
  and leaves the switch orphaned on a line of its own. The common laptop widths
  (1280, 1366, 1440) keep the words. The same block trims the tab padding,
  because the tab row was *exactly* full at 1024px before the switch joined it
  — anything at all pushed LCS onto a second line, and the tabs give back the
  44px rather than the switch giving up its tap target.
- **Default on.** A spoiler guard that is off until you find it protects
  nobody — the visitor it exists for does not know it is there. The switch and
  the persisted preference are what keep that from being a nuisance to the
  people who want scores.
- **The reveal listener is in the capture phase, and that is load-bearing.**
  Rows on both shapes carry their own click handler that expands the series into
  game-by-game boards — which would hand over, one game at a time, exactly the
  result the click was asking to see. A bubble-phase listener on `document` runs
  *after* that handler has fired, so stopping propagation there stops nothing.
  Capture runs document-downwards and gets in first. `smoke.mjs` has a check for
  this precise regression, on both shapes.
- **A match with no id is not guarded**, because the reveal is keyed by id and
  a hidden score nobody can open is a dead end rather than a courtesy.
- **Two callers opt out with `matchRow(ev, phase, {noSpoil:true})`**, and the
  line is *lists you meet* versus *lists you asked for*. A team modal's "Played
  this split" is the list you clicked that team to read; the honours modal's
  archive sits behind a card that already prints the champion and the score, so
  a guard inside it guards nothing.

## Generated data

Two blocks in the script are written by tooling rather than by hand, both fenced
by markers `check.mjs` holds you to. Rewriting a whole block is deliberate: a
generated region with a hard edge cannot be half-edited, and a hand-tweak inside
one is simply overwritten on the next run rather than silently kept.

### The DRAFTS block

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
removes the previous one — it just grows against the 400 KB budget, and past 600 KB
`check.mjs` stops warning and starts failing. Pruning is no longer the main lever on
that number, and the warning no longer pretends it is: DRAFTS is around a tenth of the
file, so `--prune` recovers a tenth. The rest is the page, and the page does not reset
at a split boundary. `--prune` enumerates
every game Riot places in the current split and drops everything else. It only ever runs
on an explicit flag (or the `prune` input on the workflow's manual dispatch), and it
refuses to delete anything if enumeration was incomplete, since a partial list would
take the live split with it. Run it once after a rollover.

### The GPR block

`POWER_RANKINGS_ASOF` and `POWER_RANKINGS` sit between `/* GPR:generated */` and
`/* GPR:end */`. **Never hand-edit them** — `tools/gpr.mjs` rewrites the whole
block from lolesports.com's official Global Power Rankings.

- `node tools/gpr.mjs --dry-run` — print the board it would write, change nothing
- `node tools/gpr.mjs` — patch `index.html` in place
- `node tools/gpr.mjs --top 10` — how many teams the board carries (default 10)
- `node tools/gpr.mjs --year 2026` — override the season
- `.github/workflows/gpr.yml` runs it daily at 07:45 UTC and commits any change

**It is baked in rather than fetched, for the same reason DRAFTS is.**
lolesports.com/gpr is a Next.js page, not an API: the rankings arrive as ~2 MB of
server-rendered React payload, which is not something to make a phone download,
and the GraphQL endpoint behind it (`/api/gql`) refuses freeform queries —
persisted operation IDs only, and those change with every deploy of their site.
So don't try to move this to a runtime fetch; it was checked.

- **The board is read out of the page's Apollo cache, not its markup.** The HTML
  ships the whole `teamGPR` array inline for hydration; `sliceJSONArray()` finds
  that key and bracket-matches to the end of the array, so what comes back is the
  real JSON Riot's own client renders from. Scraping the rendered table instead
  would mean parsing a wall of generated class names that changes on any restyle.
  If a redesign moves that payload the scrape fails loudly (`No teamGPR payload`),
  which is the point — a silent empty board would be worse.
- **`t` is taken from `/getTeams` by team id, not from the GPR payload.** Riot
  spells the same team differently in different places, and the page matches
  rankings to fixtures *by name*: `isTop10()` and the simulator's `rating()` both
  key on `nk(name)`. The team-list API uses the same spelling the schedule feed
  does, so taking the name from there is what keeps that join working. This was a
  live bug — the hand-mirrored board said `Gen.G` where every feed says
  `Gen.G Esports`, so Gen.G's games were never badged a top-10 clash and the
  simulator rated them off the fallback. Don't "tidy" a name back.
- **`wl` is the match record, not the game record** (`teamMatchRecord`), which is
  what the GPR table prints beside the score. Both are in the payload.
- **`move` is the rank change over 7 days**, from `teamGPRHistory`. Riot's own
  `previousTeamGPR` is the day before, which is flat for around 90% of teams and
  makes the ▲/▼ column say nothing; the history is published roughly every ten
  days and reproduces the movement the board carried when it was mirrored by
  hand. `MOVE_DAYS` in `gpr.mjs` is that window, and the generated comment in
  `index.html` states it so the column's meaning is written down.
- **`stale.mjs` still checks the age**, but it now means something different: not
  "go and mirror this" but "the nightly job has quietly stopped, or Riot has
  stopped publishing a current board". `gpr.yml` raises its own issue when a run
  *fails*; what it cannot see is a run succeeding against a frozen board.

## Automation

These run without anyone asking:

- `.github/workflows/health.yml` — `tools/check.mjs` on every push and PR
- `.github/workflows/smoke.yml` — `tools/smoke.mjs` on every push and PR, and daily at 07:30 UTC
- `.github/workflows/drafts.yml` — `tools/drafts.mjs` daily at 06:00 UTC, commits changes
- `.github/workflows/api-canary.yml` — `tools/api-canary.mjs` daily at 07:00 UTC
- `.github/workflows/gpr.yml` — `tools/gpr.mjs` daily at 07:45 UTC, commits changes
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
`smoke-failing`, `drafts-failing`, `gpr-failing`, `deploy-stale`, `links-dead`. Scheduled jobs report through it;
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

Two of those constants are not yours to patch: `DRAFTS` and the GPR block. If a
session wants either refreshed now rather than at its next scheduled run, run
`tools/drafts.mjs` or `tools/gpr.mjs` and commit what it writes.
