# Design v5: finance dashboard (review branch `design-v5`)

A full visual redesign of the Open Brain web app: navy and slate surfaces, green (good / done) and
amber (needs attention) signals, Inter for text and IBM Plex Mono with tabular numerals for every number.
Desktop gets a fixed left sidebar (with sub-links for Study and Brain); phones get a bottom bar.
No feature was removed.

## What changed
- **Today** is a dashboard: four stat tiles computed from your data (notes this week vs the week before
  with 14-day bars, total links and links per note, topics from `brain_graph()`, items to review =
  pending brain-page proposals + plan proposals + unanswered check-ins), a topic breakdown table,
  a recent-notes table, plus the existing composer, plan and "From your brain".
- **Jobs** gets a strip of pipeline tiles (new, applied, interviewing, average score).
- **Brain → Map** (`graph.js`, rewritten) is an analytical network view: color by topic with a legend that
  doubles as topic filters, dot size by number of links, hover (tap on phones) preview card, wheel / drag /
  pinch zoom and pan, + / − / reset buttons, search that highlights and zooms to matches, a "Min links"
  slider, a strong-links toggle, and a side panel ranking the most-connected notes with network totals.
  Clicking a note opens the detail panel ("Read the full note", connected notes with similarity).
- Thoughts render as compact table rows; everything else (Capture, Study, Library, Review, Ask, Edit,
  door-check flag, sign-in) is restyled in the same system.
- Files: `index.html` (all styles + layout), `shell.js` (sidebar, breadcrumb, dashboard numbers),
  `graph.js`, `planner.js` / `jobs.js` (small color fixes; planner shows "Notifications are off in demo mode").

## Demo mode (this branch only shows invented data)
`demo-mode.js` replaces the Supabase client with an in-memory fake (`.from()` chains, `.rpc()` including
`brain_graph`, `.auth.*`, `.functions.invoke`) and answers any `fetch` to the Supabase URL locally.
It opens signed in as a made-up user, turns off the service worker and push notifications, and shows a
"Demo data" badge. All notes, jobs, library entries, pages and names in it are invented.
- `?login=1` shows the sign-in screen.
- `?nodes=300` gives the map 300 notes (performance check).

**To go back to real data: delete `demo-mode.js` and its one `<script src="demo-mode.js">` line in
`index.html`.** Nothing else depends on it.

## Checking
- `npm run check` (includes `tests/design-v5/demo-app.test.mjs`: no Supabase requests, every tab without
  console errors, map hover / zoom / search / filter, 300-note frame time, no sideways scroll at 375px).
- Screenshots: `node scripts/design-review-screenshots.mjs` writes `design-review/*.png`.
- Real login and real data were **not** tested on this branch.
