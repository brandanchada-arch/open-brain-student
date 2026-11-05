# Design v4: "Glass"

A calm redesign of the whole web app: frosted-glass panels floating over a soft colour
gradient, large rounded corners, layered soft shadows, the computer's own system font, and
springy (slightly bouncy) movement between tabs and panels. It follows your device's light
or dark setting. This branch (`design-v4`) runs on **invented demo data only**.

Screenshots: `design-review/` (re-make them with `node design-review/take-screenshots.mjs`).

## What changed

| File | Change |
|---|---|
| `index.html` | New stylesheet (glass panels, gradient, system fonts, light + dark, spring transitions, sidebar on wide screens, floating tab bar on phones). New sign-in look. Today becomes two columns on a computer. New map controls. Web fonts removed. One `<script src="demo-mode.js">` line added. |
| `graph.js` | Rewritten map (see below). Same data (`brain_graph()`), same "read the full thought" sheet. |
| `review.css`, `ask-edit-check.css` | Same rules, recoloured for glass and dark mode. |
| `shell.js` | Toast uses the glass colours. |
| `planner.js`, `jobs.js` | Fold-out titles use a CSS class instead of grey inline colour. `planner.js` shows "Notifications: off in demo mode" when `demo-mode.js` is loaded. |
| `demo-mode.js` | **New.** The fake back end (below). |
| `tests/design-v4/` | **New.** Browser test of the whole app on demo data + the small local server it uses. |
| `design-review/` | **New.** Screenshots and the script that takes them. |

`gaps.js`, `library.js`, `review.js`, `ask.js`, `edit-thought.js` and `door-flag.js` did not need code
changes: their screens are restyled through the shared CSS classes. Nothing in `supabase/`,
`migration.sql`, `.github/`, `pc-setup/`, `config.js`, `brain-calendar.html` or `privacy.html` changed.

## The map (Brain → Map)

- One soft round dot per thought; **colour = topic** (legend under the map), **size = number of connections**.
- **Hover** a dot (or **tap** it on a phone) for a frosted preview card: first words, topic, connection count.
  Click it (or tap it again, or press "Open note") to read the whole thought and jump to linked ones.
- **Zoom and move**: mouse wheel / trackpad, drag, two-finger pinch, the + / − buttons, the keyboard (+, −, arrows).
  The corner button eases back to the whole map and clears search and filters.
- **Search** box: matching dots get a blue ring, the rest fade, and the map glides to the matches.
- **Filters**: tap a topic in the legend to hide or show it; the "Min links" slider hides loosely connected dots.
  "Strong links only" hides weaker lines.
- The layout is worked out once when the data arrives, and the map only redraws while something moves,
  so it stays smooth with hundreds of dots (the test checks 300: one frame takes a few milliseconds).
- With "reduce motion" switched on in the device settings, zooms and panels jump instead of gliding.

## Demo mode (`demo-mode.js`)

Loaded in `index.html` just before the Supabase client is created. It:

- replaces `supabase.createClient()` with an in-memory fake: `.from()` query chains, `.rpc()` (including
  `brain_graph`), `.auth.*` and `.functions.invoke` all answer from invented data;
- answers any `fetch` to a `*.supabase.co` address itself, so nothing is ever sent there;
- opens signed in as a made-up user ("Riley"); add `?login=1` to the address to see the sign-in screen
  (any email and password then "sign in");
- keeps every write (new thought, edit, approve, tick a task…) and the app's own small caches in memory
  only: a reload starts fresh;
- turns off push-notification subscribe and service-worker registration;
- shows a small yellow **"Demo data"** badge;
- `?nodes=300` grows the map to 300 notes for a speed check.

All demo content is invented: about 60 notes in 6 topics (Finance, Courses, Job Search, Real Estate,
AI Tools, Personal) with links between them, 6 library entries (one deliberately trips the door-check
warning), 3 brain pages, 2 proposals, planner items, calendar events and 7 made-up job postings.

### Going back to real data

Delete **`demo-mode.js`** and its one line in `index.html`:

```html
<script src="demo-mode.js"></script>
```

That is all. The rest of the redesign works with the real database unchanged. (The `tests/design-v4`
test and the screenshot script need demo mode, so delete or skip them too if you remove it.)

## Checked, and not checked

- `npm run check` passes, including the new browser test: no request reaches supabase.co, every tab
  opens with no console errors, map hover / zoom / search / filters work, nothing scrolls sideways at
  375px wide, and the tab bar and map buttons are at least 44px.
- **Real login and real data were not tested on this branch.** Everything ran on demo data in a
  headless browser. Voice capture, PDF reading (it loads pdf.js from a CDN) and push notifications
  could not be exercised there.
