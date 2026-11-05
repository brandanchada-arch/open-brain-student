# Design v3: "Garden" (warm, earthy, rustic)

Branch `design-v3`. A visual redesign of the whole web app; every feature from `master` is still there.

## The look
- **Paper**: cream and parchment backgrounds with a faint paper grain made only with CSS gradients (no images).
- **Colours**: terracotta (main buttons), moss (selected chips, active tab), ochre and clay accents, dark-brown ink for text.
  Body text is about 13:1 contrast on the paper; muted text is about 6:1.
- **Type**: Fraunces (a warm serif) for headings, Nunito Sans for body text. Both are stored in `fonts/`
  (SIL Open Font License), so the app needs no font server.
- **Shapes**: cards, buttons and the map have slightly uneven, organic corners.
- **Layout**: on a phone the tab bar floats at the bottom; on a computer (980px and wider) it becomes a side bar with the Capture button on top.

## The thought map (`graph.js`, rewritten)
The 3D rotating brain is replaced by a flat "root garden":
- Each thought is a **seed** coloured by topic; the topic chips above the map are the legend.
- **Bigger seed = more connections**; the best-connected seeds grow a small sprout.
- Links are **curved, branch-like lines**, in the topic's colour when both ends share a topic.
- **Hover** a seed (or **tap** it on a phone) for a preview card: text, topic, number of connections. Click / "Open thought" shows the full thought and its neighbours.
- **Zoom and pan**: mouse wheel, drag, pinch, the + / − buttons and the reset button (also keys + − 0 and arrows when the map has focus).
- **Search** ("Find on the map") highlights matching seeds and zooms to them.
- **Filters**: tap a topic chip to hide or show it; the "Min. connections" slider hides seeds with few links. "All links" switches to strong links only.
- Stays smooth with 300 notes (a frame draws in a few milliseconds; checked by the test).

## Demo mode (no real data on this branch)
`demo-mode.js` replaces the Supabase client with an in-memory fake full of **invented** data:
about 60 notes in 6 topics with links, library entries (one flagged by the door check), brain pages and proposals,
planner items, jobs at made-up companies. Nothing is copied from real notes, `curriculum/`, docs or logs.
- The app opens signed in as a made-up user, **Robin**. Add `?login=1` to the address to see the sign-in screen.
- `?nodes=300` grows the map to 300 notes.
- All writes stay in memory and are gone after a reload. Push notifications are switched off.
- Every `fetch` to the Supabase URL (or any `supabase.co` host) is answered locally and never sent.
- A small **"Demo data"** badge shows on every screen.

**To go back to real data:** delete `demo-mode.js` and its one `<script src="demo-mode.js"></script>` line in `index.html`
(right above `const sb = window.supabase.createClient(...)`). Nothing else depends on it.

## What changed
- `index.html`: new stylesheet, new map controls (search, slider, zoom buttons, preview card), side-bar brand, sign-in page text, demo script tag.
- `graph.js`: rewritten (same `obGraph.show / hide / reset / fit` API, same `brain_graph()` data).
- `review.css`, `ask-edit-check.css`: new colours. `shell.js`, `planner.js`, `jobs.js`: a few hard-coded dark-theme colours swapped for the new ones.
- New: `demo-mode.js`, `fonts/`, `tests/design-v3/` (browser tests), `scripts/design-review/shoot.mjs` (screenshots), `design-review/*.png`.
- Not touched: `supabase/`, `migration.sql`, `.github/`, `pc-setup/`, `config.js`, `brain-calendar.html`, `privacy.html`.

## Checking it
- `npm run check` runs everything, including `tests/design-v3/app.test.mjs`: no request to any `supabase.co` host,
  every tab opens with no console errors, map hover / zoom / pan / search / filters, 300-note speed, no sideways scroll at 375px, 44px tap targets.
- `node scripts/design-review/shoot.mjs` re-takes the screenshots in `design-review/`.

## Not tested on this branch
Real sign-in and real data were never used here. Before merging, remove demo mode and try the app against the real project.
