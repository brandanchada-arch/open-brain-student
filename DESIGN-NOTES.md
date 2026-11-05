# Design v2: "Neural" (branch `design-v2`)

A dark, futuristic "second brain": near-black background with a faint dot grid, cyan and
violet light, glow only on active things (selected tab, focused box, hovered dot). Fonts:
Space Grotesk (headings), Inter (text), JetBrains Mono (labels, dates, numbers).
Text colours keep at least 4.5:1 contrast on the cards. `prefers-reduced-motion` turns off
every animation, the light trails on the map and the hover pulse (a still ring is shown instead).

## THIS BRANCH RUNS ON DEMO DATA ONLY

`demo-mode.js` swaps the Supabase client for an in-memory fake with invented notes
(60 thoughts in 6 topics, links, library entries, brain pages, proposals, planner items, jobs).
It also blocks every `fetch` to the Supabase URL, turns off the service worker and push
notifications, and shows a "Demo data" badge. Writes live only in the open tab.

- `?login=1` shows the sign-in screen (any email/password "signs in" to the demo).
- `?graph=300` pads the brain map to 300 dots (performance check).

**To go back to real data:** delete `demo-mode.js` and the one line
`<script src="demo-mode.js"></script>` (with its comment) in `index.html`. Nothing else
depends on it. Real login and real data were **not** tested on this branch.

## What changed

| File | Change |
|---|---|
| `index.html` | All new styles. Side rail on computers (960px+), bottom bar on phones. Today is two columns on a computer. New map controls (search, zoom buttons, topic filter, min. connections, stats). Same IDs, so all scripts work unchanged |
| `graph.js` | Rewritten: 2D force-directed map. Colour = topic (legend), size = connections, hover/tap preview card, click for the full thought, wheel/drag/pinch zoom and pan, +/−/reset buttons, search that highlights and zooms to matches, topic filters, min. connections slider. Same `obGraph.show/hide/reset/fit` API |
| `shell.js` | Toast colours moved to CSS; `body[data-screen]` set for per-screen widths |
| `review.css`, `ask-edit-check.css` | Warning and badge colours matched to the new palette |
| `demo-mode.js` | New, see above |
| `tests/design-neural/app.test.mjs` | Browser test: no supabase.co requests, every tab opens without console errors, map hover/zoom/search/filter, no sideways scroll at 375px, 300-node frame time |
| `design-review/` | Screenshots and the script that takes them (`node design-review/take-screenshots.mjs`) |
