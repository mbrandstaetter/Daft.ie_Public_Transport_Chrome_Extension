# Dublin Commute Overlay

A Chrome extension that draws Dublin's public transport network onto daft.ie's own map and
tells you how long the commute would be from any property you click to the places you
actually go.

- **Transport lines** — Luas, DART and commuter rail rendered as native vector layers
  inside Daft's map, so they pan and zoom with it rather than floating over it.
- **Commute times** — click any property pin to get door-to-door times to each saved
  destination, with the leg breakdown ("walk 10 · Luas Green 21 · walk 8") and the journey
  drawn on the map.
- **Detail pages answer themselves** — open a listing and its commute is already there, no
  click needed: the page names which property it is about, so there is nothing to select.
- **By transport, walk, bike or car** — switch mode in the panel; the whole comparison
  re-runs.
- **Pin the day and time** — measure every property against the same Tuesday 09:00, or
  check what a Saturday looks like. Defaults to the next weekday.
- **Your destinations on the map** — saved places show as coloured pins, so you can see
  where a property sits relative to them before asking for a number.
- **One click to switch it off** — the toolbar icon is a master switch. Off means the
  panel is gone, nothing of ours is on Daft's map, and no lookups happen at all; the icon
  shows an `off` badge. It applies to every open daft.ie tab at once.

Design rationale and the findings behind it are in [SPEC.md](SPEC.md); privacy in
[PRIVACY.md](PRIVACY.md); release process in [PUBLISHING.md](PUBLISHING.md).

> Not affiliated with, endorsed by, or connected to Daft Media Ltd. "Daft" and "daft.ie"
> are their trademarks; this is an independent tool that runs in your own browser.

## Install (unpacked)

```bash
npm install && npm run data && npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select the `dist/` folder. Visit any daft.ie search page with the map open, e.g.
`https://www.daft.ie/property-for-rent/dublin-city?showMap=true`.

`npm run data` downloads ~8 MB of GTFS and writes ~43 KB of GeoJSON into
`extension/public/data/`. It only needs re-running when timetables change.

## Verifying it works

The automated tests cover the data, the routing API contract, and the map-layer logic:

```bash
npm test
```

To look at the panel itself without loading the extension — useful for UI work — run:

```bash
npm run preview
```

and open `http://localhost:5173/preview.html`. It renders the real built `isolated.js`
against stubbed extension APIs. It has to be served over HTTP rather than opened as a
file: a `file://` or `data:` page has origin `"null"`, and `window.postMessage` — which
the panel's bridge uses — rejects that outright.

Neither of these covers the one thing only a real browser can: that the extension attaches
to Daft's map and survives navigation. **That check is manual and is the first thing to do
after loading**, because it is where this extension is most likely to break:

1. Open a search page with `?showMap=true` → transport lines are visible.
2. Pan and zoom → lines track the basemap exactly, with no drift.
3. Click a property → open its detail page → scroll to the map → lines appear there too.
4. Press Back → lines are still on the search map.
5. Close the map and reopen it → lines return.
6. Console is clean, and layers are not duplicated.

On a detail page, one more thing to check, because it is the one place the extension
commits to an answer with nothing to click:

7. Open a listing directly → the commute appears without any interaction, and the panel
   names *that* listing.
8. From there, click through to a similar property at the bottom of the page → the answer
   changes to the new listing rather than keeping the old one. Getting this wrong would
   show a confident commute for the wrong property, so it is worth checking deliberately —
   the address in the panel must match the address at the top of the page.
9. Scroll down to the map → the journey is drawn there, even though it was calculated
   before the map existed.

10. Click the toolbar icon → the panel disappears, the lines and your destination pins go
    with it, and the icon gains an `off` badge. Click again → everything comes back, and a
    detail page re-answers itself. Open a second daft.ie tab first to confirm both follow.

`npm run preview` also has a `?detail` mode and a **Toolbar icon** button that render these
paths against stubs.

If step 1 fails with "Couldn't attach to Daft's map", their bundle has changed shape; the
fix is confined to `extension/src/main-world/map-handle.ts`.

If commute lookups report *"the routing service rejected this client"*, the
`declarativeNetRequest` User-Agent rule is not being applied — see below.

## How it fits together

MV3 forces three execution contexts, because reaching Daft's map object requires running
in the page's own JS world, where `chrome.*` does not exist:

| Context | Responsibility |
|---|---|
| `main-world/` | Finds Daft's MapLibre instance via the React fiber, adds our layers, reads marker clicks, and identifies which listing a detail page is about. Talks out via `postMessage`. |
| `isolated/` | Bridges `postMessage` ↔ `chrome.runtime`, renders the panel in a Shadow DOM. |
| `background/` | Every network call, the IndexedDB plan cache, and the rate limiter. |

Two data sources, deliberately split:

- **Line geometry** is precomputed from NTA/TFI GTFS by `tools/build-transport-data.mjs`
  and shipped with the extension. Fetching it live is not viable — Transitous' route
  endpoint returns polyline *indices* without geometry, needing another request per route.
- **Routing** is live, from [Transitous](https://transitous.org/) (MOTIS). No API key.

## When a destination says there's no route

Two very different situations produce an empty result, and the extension distinguishes
them rather than reporting both as "no route found":

- **No public transport serves this property.** There is no stop within a sensible walk.
  Common for rural and edge-of-county listings — some have zero stops within 3 km, and no
  setting will fix that.
- **Outside your limits.** A journey exists but exceeds your maximum walking distance or
  journey time. The message tells you what it would actually take, so you can decide
  whether to raise the limits in options.

The two are told apart by re-asking once with deliberately generous limits, only after a
failure, with the outcome cached — so it costs at most one extra request per
property/destination/settings combination.

Worth knowing when a destination fails more often than you'd expect: business names can
geocode to several places. "Amazon Web Services" matches half a dozen sites around Dublin,
several of them data centres in industrial estates with long walks from the nearest stop.
The picker shows the locality for each match, so it is worth checking you chose the one
you meant.

## A note on trusting the numbers

Routing runs on live operator data, which is sometimes wrong. On 2026-08-13 the Luas Green
feed reported trams running Balally → city centre in **zero minutes**, which turned a
39-minute journey into an apparent 18-minute one — and because results are sorted fastest
first, that would have been the headline number.

Itineraries containing a transit leg with zero elapsed time between two *different* places
are therefore dropped, since no timetable can make that true. The filter is deliberately
narrow: a leg that is implausibly short but non-zero still gets through, because ruling
those out would need a speed model this project has no business inventing. If a commute
looks too good, it is worth a second look.

## Using Transitous responsibly

Transitous is free and volunteer-run. This matters in code, not just in spirit:

- A lookup happens only for a property you are actually looking at — one you clicked, or
  the single listing a detail page is about. Nothing is prefetched for properties nearby,
  in the results list, or in the viewport.
- Results are cached in IndexedDB for 7 days, keyed on position rounded to ~1 m.
- Max 2 concurrent requests, 250 ms apart, 200 per session, with exponential backoff.
  Detail pages spend that budget without being asked: one lookup per enabled destination
  per listing opened, so with two destinations, browsing 100 listings in one browsing
  session reaches the cap. Revisits are free, and going over reports itself rather than
  failing quietly. Turning off *Calculate automatically on click* puts every lookup back
  behind a button.
- Requests carry an identifying `User-Agent` set by a `declarativeNetRequest` rule.
  This is **enforced**, not a courtesy — generic user agents get `HTTP 403`.

Whether `declarativeNetRequest` can set `User-Agent` on the extension's own service-worker
requests is the one unverified assumption in the build; a 403 surfaces as its own distinct
error state so it diagnoses itself. If you end up making heavy use of this, or want to
publish it, run your own MOTIS instance instead — see SPEC.md §4.2.

## Layout

```
extension/src/main-world/   map attachment, layers, marker clicks, detail-page listing
extension/src/isolated/     bridge + panel UI
extension/src/background/   routing, cache, rate limiting
extension/src/shared/       message contract, types, Dublin-time handling
tools/build-transport-data.mjs   GTFS -> GeoJSON
tools/build.mjs                  esbuild bundler
tools/selftest.mjs               data + live API checks
tools/layertest.mjs              map-layer logic against a fake MapLibre
tools/preview.html               panel harness (stubbed chrome.* APIs)
tools/preview-server.mjs         serves dist/ for the harness
```

The panel can be dragged by its header and remembers where you put it; a click on the
header still collapses it, the two being told apart by how far the pointer moved.

## Scope

Greater Dublin, rail modes only (Luas, DART, commuter rail). Buses are deliberately out —
several hundred overlapping routes need zoom-gating and a different rendering strategy to
stay legible; see SPEC.md §5.4.

## Attribution

- Routing: [Transitous](https://transitous.org/) — [sources](https://transitous.org/sources/)
- Timetable and route data: National Transport Authority via
  [data.gov.ie](https://data.gov.ie/), CC-BY 4.0
- Map data: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)
- Basemap: © MapTiler (Daft's own; the extension does not obscure their attribution)

MIT licensed. Not affiliated with Daft Media Ltd.

## Status

Phases 1 and 2 are built and covered by `npm test`. **The manual browser check in
"Verifying it works" has not been run** — the map integration is unverified against the
live site. Do that before relying on it, and certainly before publishing it to anyone else
(see [PUBLISHING.md](PUBLISHING.md)).
