# Design v1: minimal and clean

Branch `design-v1`. This is a visual redesign of the whole web app. Every feature still works, and it all runs on **invented demo data**.

## The look
- Near-white page (`#FBFBFA`), white cards, 1px hairline borders, no shadows. One accent color (blue `#3E63DD`), used for primary buttons, focus rings and the active nav icon.
- Inter type at small, crisp sizes. Section labels are small uppercase grey text. The sub-tabs are an underlined tab row, and the Today / This week switch is a segmented control.
- On a computer, the menu sits in a left sidebar with Capture on top. On a phone it's a plain white bottom bar, and every button there is at least 44px tall.
- All colors are tokens in `:root` at the top of the `<style>` block in `index.html`.

## The thought map (`graph.js`, rewritten)
- Flat 2D map. Dots are colored by topic (legend chips above the map, with counts). A dot's size grows with its number of connections. Links are thin grey lines.
- Hovering a dot shows a preview card with the topic, connection count and first lines. On a phone, the first tap shows the card and its "Open note" button opens the full note. Clicking a dot opens the detail panel, which lists the connected notes.
- You can zoom with the mouse wheel or a pinch, and drag to move the map. There are + / − / reset buttons in the corner.
- Search fades every dot except the matches and moves the view to them.
- Filters: topic chips switch topics on and off, the "Min. links" slider hides dots with few connections, "Strong links" hides the weaker links, and "Show all" resets the filters.
- The layout is worked out once, and after that the map only redraws when something changes. With 300 dots, one frame takes about 1–2ms (`?nodes=300`).

## Demo mode: how to go back to real data
**Delete `demo-mode.js` and its `<script src="demo-mode.js">` line in `index.html` (just above `const sb = window.supabase.createClient(...)`). That's all.** Nothing else depends on it.

While it's there:
- The Supabase client is replaced by an in-memory fake that covers `.from()` chains, `.rpc()` (including `brain_graph`), `.auth.*` and `.functions.invoke`. `fetch` calls to any `supabase.co` host are answered locally, so nothing goes to the real project.
- The app opens signed in as a made-up user ("Alex"). `?login=1` shows the sign-in screen first, and any email and password then "sign in".
- Saves, edits, approvals and ticks stay in memory and are gone after a reload.
- Push notifications can't be turned on, and the service worker isn't registered.
- A small "Demo data" badge shows on every screen.
- All content is invented: 60 notes across Finance, Courses, Job Search, Real Estate, AI Tools and Personal, with links between them, plus library entries (one with a door-check flag), brain pages, proposals, planner items and jobs.

## Checking
- `npm run check` includes the new browser test, `tests/design-v1/app.test.mjs`. It loads the app from a local server and checks that:
  - no request goes to `supabase.co`
  - every tab opens with no console errors
  - the map's hover, zoom, drag, search and filters work
  - 300 dots draw fast
  - nothing scrolls sideways at 375px wide
  - the phone buttons are at least 44px
- Screenshots: `node scripts/design-screenshots.mjs` (`FONTS=1` loads Inter) writes them to `design-review/`.
- **Not tested on this branch: real login and real data.**
