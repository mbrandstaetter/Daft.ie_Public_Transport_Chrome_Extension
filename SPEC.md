# Daft.ie Public Transport — Implementation Spec

A Chrome extension (MV3) that augments daft.ie property search with public transport
context: transit lines drawn onto Daft's own map, and door-to-door commute times from any
property to your saved destinations.

**Status:** implemented — see [README.md](README.md) for install and verification steps.
Phases 1 and 2 are built and covered by `npm test`; the manual browser check in the README
("Verifying it works") has **not** been run and is the outstanding gate. Phase 3 is not started.
**Target:** personal use first (unpacked), with provider interfaces kept swappable so a
Chrome Web Store release is a configuration change rather than a rewrite.

Where implementation contradicted this document, the document has been corrected in place
and the correction marked — see §4.2 (User-Agent) and §3.1 (`LINES_DATA`).

---

## 1. Goals

| # | Capability | Phase |
|---|---|---|
| G1 | Overlay Luas / DART / commuter-rail lines and stations on Daft's map | 1 |
| G2 | Save one or more named destinations (work, gym, parents) by address | 2 |
| G3 | Click a property pin → door-to-door public transport time to each destination | 2 |
| G4 | Draw the recommended journey (walk + transit legs) on the map | 2 |
| G5 | Commute badges on all visible pins, not just the clicked one | 3 |

**Non-goals for v1:** driving/cycling times, real-time delays (GTFS-R), rent-vs-commute
scoring, and any modification of Daft's own data or requests.

**Scope decisions taken:**
- Coverage: **Greater Dublin only**.
- Modes in the overlay: **Luas, DART, commuter rail** first. Buses are Phase 3 and must
  not be assumed away — see §5.4.
- Distribution: **personal now, Store later** (drives §4.2 and §12).

---

## 2. Verified findings about daft.ie

All of this was confirmed live against `www.daft.ie` on 2026-08-12. It is the factual base
the design rests on; **re-verify §2.2 and §2.4 before starting Phase 1**, as they depend on
Daft's bundle internals.

### 2.1 The map is MapLibre GL JS with MapTiler vector tiles

```
container:  div.maplibregl-map  (data-testid="map-component")
style:      142 layers, sources { openmaptiles, maptiler_attribution }
tiles:      https://api.maptiler.com/tiles/v3/tiles.json?key=…
glyphs:     https://api.maptiler.com/fonts/{fontstack}/{range}.pbf?key=…
```

This is the single most important finding: it means we can add **native vector layers** to
Daft's own map (correct z-order, GPU rendering, pans and zooms perfectly) rather than
maintaining a separately-synced overlay canvas.

Two surfaces carry a map:
- **Search map view** — `/property-for-rent/<area>?showMap=true`. One map, ~50 markers.
  Testids present: `mapsearch-container`, `map-search`, `close-map-button`,
  `map-count-banner`, plus a draw-your-own-area feature (`draw-map-onboarding-*`).
- **Property detail page** — `/for-rent/<slug>/<id>`. Map is **lazy-mounted on scroll**;
  it does not exist at page load.

### 2.2 The Map instance is reachable, and `addLayer` works

Daft bundles MapLibre (no `maplibregl` global), but the `Map` object is reachable by
walking the React fiber from `.maplibregl-map` — found 2 fiber hops up, inside a hook's
`memoizedState`. A recursive search for an object with `getCenter`, `addSource`, and
`transform` locates it reliably on both surfaces.

Proven live on the search map:

```js
map.addSource('__test_pt', { type: 'geojson', data: /* LineString */ });
map.addLayer({ id: '__test_pt_line', type: 'line', source: '__test_pt',
               paint: { 'line-color': '#00A651', 'line-width': 4 } });
// → layer count 142 → 143, map.getLayer() truthy
```

> Caveat on the evidence: the browser pane could not composite, so this was confirmed via
> the MapLibre API (layer registered, style layer count incremented) rather than visually.
> Phase 0 must confirm pixels.

### 2.3 Property coordinates are available client-side

Every listing carries a GeoJSON point. On the search page,
`__NEXT_DATA__.props.pageProps.listings[]` — 50/50 listings had `listing.point`:

```json
{ "id": 6282327, "point": { "type": "Point", "coordinates": [-6.240177677027, 53.287142333315] },
  "abbreviatedPrice": "€2,450+", "seoFriendlyPath": "/for-rent/…/6282327" }
```

**Do not build on this.** `__NEXT_DATA__` is the SSR payload, frozen at page load; panning
the map brings in listings that are not in it, and a `fetch`/`XHR` hook captured no
listing requests during a pan (their search likely goes through Next.js client routing).
Use it only as a Phase 0 convenience and as a fallback source of price/URL.

### 2.4 Markers give us both the id and the position — use `unproject`

```html
<div class="maplibregl-marker maplibregl-marker-anchor-bottom"
     style="transform: translate(-50%,-100%) translate(618.039px, 281.703px) …">
  <div data-testid="pin-container-6282327" role="button">€2,450+</div>
</div>
```

The **canonical** way to get a clicked property's coordinates:

1. Read the listing id from `data-testid="pin-container-<id>"`.
2. Parse the **second** `translate(Xpx, Ypx)` off the marker's inline transform.
3. `map.unproject([X, Y])` → exact `{lng, lat}`.

This works for every marker regardless of where it came from, and depends on nothing
beyond the map handle we already know how to obtain.

### 2.5 Anti-bot and consent

The site runs Akamai Bot Manager (`/jy2x/…`) and reCAPTCHA Enterprise, and a Didomi consent
gate. None of this affects us — a content script runs inside the user's own authenticated,
consented session and issues no requests to Daft. **The extension must never call Daft's
backend APIs directly**; everything comes from the DOM and the map instance.

### 2.6 A detail page names its own listing — but every source of that name goes stale

A detail page is about exactly one property, and it says which:
`props.pageProps.listing` carries `{ id, title, point.coordinates }`. No click is needed to
know what to measure. The trap is that the obvious places to read it from are *wrong* after
a client-side navigation between listings, and wrong in a way that looks perfectly healthy.

Verified live on 2026-08-13, routing from listing `6640128` to `6634811` via the page's own
"similar properties" links:

| Source | After a fresh load | After in-page navigation |
|---|---|---|
| `next.router.components[route].props.pageProps.listing` | correct | **correct** |
| `__NEXT_DATA__.props.pageProps.listing` | correct | stale — still the SSR'd listing |
| `script#propertyDetailsSchema` (JSON-LD `Residence`) | correct | stale, for the same reason |
| `document.title`, `location.pathname` | correct | correct |

The JSON-LD block is injected by `next/script` with a fixed `id`, so Next.js does not
re-render it; `__NEXT_DATA__` is the SSR payload and never changes after load (§2.3). Both
keep serving the previous property's address and coordinates indefinitely.

**Therefore: no candidate is trusted on its own.** Each must carry the id that is in the
URL, and one that does not is discarded rather than used as an approximation:

```
listingIdFromPath(location.pathname)  ->  "6634811"
pickListing([router, __NEXT_DATA__], "6634811")   // first to match the id wins
```

Two sources, in that order — the router's props because they stay correct, `__NEXT_DATA__`
behind it because it survives router internals being renamed, which is the likelier way the
first one breaks. The map's centre and its marker are deliberately **not** fallbacks: both
still yield a coordinate after the user pans, and a confident commute drawn for the wrong
property is a far worse outcome than no commute at all. When every candidate fails the gate,
say so.

Timing: `location` changes only once the new page's data has been fetched, so in practice
the router props are already fresh at the moment the URL changes. That is not guaranteed, so
detection uses the same retry ladder as map attachment (§3.2) — a stale read costs a retry,
never a wrong answer.

The detail-page marker carries **no** `pin-container-` testid (unlike §2.4), so the
click path does not exist there. This is the only way that page can be measured.

---

## 3. Architecture

MV3 forces a three-context split. The forcing constraint: the fiber walk in §2.2 requires
`world: "MAIN"`, and **MAIN-world content scripts have no `chrome.*` APIs** — no
`chrome.storage`, no `chrome.runtime.sendMessage`. Retrofitting this later is painful, so
it is baked in from the start.

```
┌─ MAIN world ──────────────┐   window.postMessage   ┌─ ISOLATED world ────────┐
│ • fiber walk → map handle │ ◄────────────────────► │ • message bridge        │
│ • addSource / addLayer    │                        │ • side panel UI (Shadow │
│ • marker click → unproject│                        │   DOM, injected)        │
│ • ensureLayers lifecycle  │                        │ • chrome.storage access │
└───────────────────────────┘                        └───────────┬─────────────┘
                                                                 │ chrome.runtime
                                                     ┌───────────▼─────────────┐
                                                     │ Service worker          │
                                                     │ • ALL Transitous calls  │
                                                     │ • IndexedDB commute cache│
                                                     │ • rate limiting / queue │
                                                     └─────────────────────────┘

  MAIN fetches the transport-line bundle directly from a web-accessible extension URL
  handed to it by ISOLATED (§3.1) — it never travels through postMessage.
```

### 3.1 Message contract

Define once in `src/shared/messages.ts` and use for both hops. Every `postMessage` payload
carries `__dpt: true` and is validated with `event.source === window`.

| Message | Direction | Payload |
|---|---|---|
| `MAP_READY` | MAIN → ISOLATED | `{ surface: 'search' \| 'detail', mapId }` |
| `MAP_LOST` | MAIN → ISOLATED | `{ mapId }` |
| `PROPERTY_CLICKED` | MAIN → ISOLATED | `{ listingId, lng, lat, priceLabel?, url? }` |
| `LISTING_DETECTED` | MAIN → ISOLATED | `{ listingId, lng, lat, label? }` — a detail page selecting itself (§2.6, §6.6) |
| `LISTING_CLEARED` | MAIN → ISOLATED | `{ reason: 'navigated' \| 'unresolved', pending }` — `pending` means an answer is still coming |
| `VIEWPORT_CHANGED` | MAIN → ISOLATED | `{ bbox: [w,s,e,n], zoom }` (debounced 300 ms) |
| `VISIBLE_MARKERS` | MAIN → ISOLATED | `{ markers: [{ listingId, lng, lat }] }` (Phase 3) |
| `LINES_DATA` | ISOLATED → MAIN | `{ lines, stops }` — parsed GeoJSON, see note below |
| `COMMUTE_RESULT` | ISOLATED → MAIN | `{ listingId, destId, summary, geometry? , error? }` |
| `SETTINGS_CHANGED` | ISOLATED → MAIN | `{ visibleModes, lineOpacity, showStops }` |
| `HIGHLIGHT_ROUTE` | ISOLATED → MAIN | `{ geometry \| null }` |
| `PANEL_READY` | ISOLATED → MAIN | `{}` — mirror of `REQUEST_INIT`, see note below |

> **Both worlds need a "I'm listening now" message.** The two content scripts load in
> either order, and MAIN can resolve a detail listing before ISOLATED exists to hear about
> it. `REQUEST_INIT` covers ISOLATED loading first; `PANEL_READY` covers MAIN loading first,
> and MAIN answers it by re-announcing `MAP_READY` and the current `LISTING_DETECTED`.
> Re-announcement must be idempotent on the panel side: the same listing arriving twice is
> not a reason to spend another routing lookup. It is also the *only* safe delivery: MAIN
> resolves the listing synchronously at load, which beats ISOLATED's `chrome.storage`
> round-trip, so a `LISTING_DETECTED` arriving before settings are loaded would be acted on
> with `autoPlan` at its default of `true` — running lookups for a user who turned it off.
> The panel drops anything that arrives pre-boot and lets `PANEL_READY` fetch it again.

> **`LINES_DATA` carries the parsed GeoJSON, not a URL.** An earlier draft had MAIN fetch
> a `chrome-extension://` URL to avoid cloning a "few hundred KB" bundle. The built bundle
> is 24 KB + 19 KB, so the clone is free — and a page-context fetch of an extension
> resource is subject to daft.ie's own `connect-src` CSP, which if it blocked would make
> the lines silently never render and look exactly like an attach failure. The service
> worker reads the files (it can always read its own packaged resources, no
> `web_accessible_resources` needed) and passes them out through ISOLATED.

> **Privacy note.** MAIN-world `postMessage` is readable by Daft's own page JS. Send
> derived results (durations, leg summaries, journey polyline) — never the raw destination
> address or the saved-destinations list. The journey polyline does imply the destination;
> acceptable for personal use, revisit before a Store release (§12).

### 3.2 Map lifecycle — the actual Phase 1 risk

Adding a layer once is easy. Surviving the page is not. Three things destroy our layers:

1. **`map.setStyle()`** — wipes all custom sources and layers.
2. **Next.js client-side route changes** — search ↔ detail, `?showMap=true` toggled,
   `close-map-button`. The map is unmounted and a *new* instance constructed.
3. **Lazy mount** on the detail page — no map exists until the user scrolls.

Required design:

```ts
// Idempotent — safe to call any number of times.
function ensureLayers(map: Map, data: LineData): void

map.on('styledata', () => ensureLayers(map, data));  // survives setStyle
map.on('remove',    () => notify('MAP_LOST'));
```

plus a `MutationObserver` on `document.body` watching for `.maplibregl-map` being added or
replaced, which re-runs the fiber walk and re-attaches. Attachment must be tracked with a
`WeakSet<Map>` so we never double-bind handlers to the same instance.

### 3.3 Layer insertion order

Insert **below the first `symbol` layer** in Daft's style so our lines sit above the
basemap but beneath place labels and their price pins:

```ts
const beforeId = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
map.addLayer(layerSpec, beforeId);
```

All our ids are namespaced `dpt-*` so we can find and remove them cleanly.

### 3.4 The toolbar icon is the master switch

No popup: one click, one thing. `chrome.action.onClicked` flips `settings.enabled`, writes
it, and stops there.

**Propagation is via `chrome.storage.onChanged`, not `chrome.tabs.sendMessage`.** Two
reasons, and the second is the real one:

- `tabs.sendMessage` needs either the `tabs` permission or host permission for daft.ie,
  neither of which this extension requests (§9) and neither of which it should start
  requesting for a UI toggle.
- It would reach one tab. A master switch that leaves the overlay running in the three
  other daft.ie tabs you have open has not switched anything off. Storage reaches all of
  them, including ones opened later, which read the stored value at boot anyway.

**Off has to mean off**, and that is wider than it first looks:

- The panel is hidden outright, not greyed out.
- `applySettings` hides *everything* we own — lines, stops, the drawn route, and the
  user's own destination pins. Destination pins are exempt from the mode chips (turning
  Luas off says nothing about where you work) but not from this.
- No routing lookups. `selectProperty` returns early, so neither a pin click nor a detail
  page spends a request while the extension is off.
- Switching back on re-emits `PANEL_READY`, so a detail page re-selects and re-plans
  exactly as a fresh load would. Nothing has to be remembered across the off state.

The badge shows `off` only — a permanent badge on a working extension is noise. It does
not survive a browser restart, so it is repainted from storage on `onStartup` and
`onInstalled`.

---

## 4. Data layer

Two independent providers, both behind interfaces.

### 4.1 `TransportLineProvider` — network geometry

**Decision: prebuilt static bundle. Transitous is not viable for this.**

Measured: `GET /api/experimental/map/routes?zoom=13&min=53.33,-6.28&max=53.36,-6.24`
returns routes whose `segments` reference polylines **by index** —

```json
{"routes":[{"mode":"REGIONAL_RAIL","transitRoutes":[{"id":"BRAY-HOWTH-I","shortName":"DART"}],
  "segments":[{"from":0,"to":1,"polyline":0}, …]}]}
```

— with **no top-level `polylines` array**. The geometry requires a further
`/api/experimental/map/route-details?routeIdx=…` call *per route*, and the index-only
response is already ~500 KB for a small central-Dublin bbox. Per-viewport fetching is out
on both payload size and request count.

```ts
interface TransportLineProvider {
  getLines(bbox: BBox, zoom: number, modes: Mode[]): Promise<FeatureCollection>;
  getStops(bbox: BBox, modes: Mode[]): Promise<FeatureCollection>;
}
```

- **`StaticBundleProvider`** (v1) — reads a GeoJSON file shipped with the extension.
- `TransitousMapProvider` — recorded as rejected; do not reimplement.
- `PmTilesProvider` — future, if coverage expands beyond Dublin (§12).

#### Build step: `tools/build-transport-data.mjs`

Run manually, output committed so the extension has no build-time network dependency.

1. Download NTA/TFI GTFS from data.gov.ie (per-operator schedule files; Luas, Irish Rail,
   later Dublin Bus / Go-Ahead).
2. Filter to `route_type` ∈ {0 tram, 1 subway, 2 rail} for v1, and to the Greater Dublin
   bbox `[-6.60, 53.15, -5.95, 53.65]`.
3. For each `route_id` × direction, select the **longest** `shape_id` as representative;
   drop the rest. This collapses hundreds of trip shapes to one line per route direction.
4. Simplify with Douglas–Peucker at ~5 m tolerance; round coordinates to 5 decimals.
5. Emit `FeatureCollection` with per-feature properties:
   `{ routeId, shortName, longName, mode, agency, color, textColor }` — `color` from
   GTFS `route_color`, with a hardcoded fallback table (Luas Green `#00A651`, Luas Red
   `#E30613`, DART `#0A8A3F`, commuter rail `#6B4E9B`).
6. Emit a second `FeatureCollection` from `stops.txt` for stations, filtered to the same
   modes: `{ stopId, name, modes }`.
7. Print output sizes; fail the build if lines exceed 2 MB.
8. **Assert the output contains Luas Green, Luas Red, DART, and ≥1 commuter-rail route;
   fail loudly otherwise.** Without this, a feed URL change or an over-aggressive filter
   ships a bundle silently missing Luas and nobody notices until a user does.

Step 1 is the least-specified part of this document and it is the first thing Phase 1
touches. The exact resolved download URLs and feed versions must be **pinned into this
spec and into `ATTRIBUTION.md` the first time the script is run** — data.gov.ie's dataset
pages are stable, the file URLs behind them historically are not.

Expected size for rail-only Dublin: well under 500 KB. Buses are the size problem, not rail.

**Licence:** NTA GTFS is published as open data on data.gov.ie under CC-BY 4.0 — record the
exact licence and feed version in `public/data/ATTRIBUTION.md` at build time.

### 4.2 `RoutingProvider` — commute times

**Decision: Transitous public API (MOTIS) for v1.** Verified working against Ireland:

```
GET https://api.transitous.org/api/v1/plan
      ?fromPlace=53.2871,-6.2402&toPlace=53.3438,-6.2546&time=2026-08-13T08:00:00Z
```

returned 5 real itineraries — `WALK 10 min → TRAM "Green" (Luas) 21 min → WALK 8 min`,
total 39 min. Stops carry `ie-transport-for-ireland_*` ids, so Irish GTFS is loaded.
`/api/v1/map/stops` also works and returns real coordinates.

**`arriveBy=true` is honored** — verified separately, since §6.2 depends on it. The same
query with `arriveBy=true&time=…T08:00:00Z` returned itineraries arriving 07:50Z, 07:55Z
and 07:58Z (clustering just *before* the target) rather than departing after it.

**…but only for `itineraries`, never for `direct`.** Re-checked 2026-09-13: combining
`arriveBy=true` with `directModes` makes MOTIS route backwards from the destination, and
the `direct` array it returns is wrong in two ways. Its polyline is rotated about the
backward search's meeting point — it starts mid-route, reaches one end, jumps across the
city and returns, drawing as a closed loop of twice the true length — and on a one-way
network it measures the *return* trip (a Ballymun → Trinity drive came back as 8.4 km /
13 min, byte-for-byte the answer to an explicit Trinity → Ballymun request, against
6.5 km / 8 min the way round actually being travelled). Walk, cycle and drive are
therefore always requested with `arriveBy=false`, and the arrive-by framing is applied
locally: street routing has no timetable, so departure = target − duration.

```ts
interface RoutingProvider {
  plan(from: LngLat, to: LngLat, opts: CommuteOptions): Promise<Itinerary[]>;
}
```

- **`TransitousProvider`** (v1).
- `SelfHostedMotisProvider` — same wire format, different base URL. This is the Store path:
  MOTIS in Docker with the NTA GTFS + an Ireland OSM extract.
- `TravelTimeProvider` / commercial — only if a hosted option is preferred later.

**Batch matrix is unconfirmed.** `/api/experimental/one-to-many-intermodal` and
`/api/v1/one-to-many` both returned **HTTP 400** against the live server across several
parameter spellings — the deployed MOTIS version may predate them or serialize `many`
differently. Phase 3 (badges on all pins) must begin by re-testing these; if they stay
unavailable, fall back to sequential `/plan` calls under the §7 rate limits, which caps
how many pins can realistically be badged at once.

#### Transitous obligations (non-negotiable)

- Send a `User-Agent` identifying the app and a contact address. `User-Agent` is a
  forbidden header for `fetch()`, so set it with **`declarativeNetRequest` `modifyHeaders`**
  scoped to `api.transitous.org`. A content-script fetch would carry
  `Referer: daft.ie` and misattribute the traffic — another reason all calls go through the
  service worker.

  > **Corrected 2026-08-12 — this is enforced, not courtesy.** An earlier draft of this
  > spec called the User-Agent a fair-use nicety on the evidence that every test call
  > succeeded without one. That evidence was wrong: those calls went through a fetch tool
  > that sends a browser UA. A request with Node's default UA gets:
  >
  > ```
  > HTTP 403  Generic user-agent headers are not allowed, please set your own.
  >           Please review the usage policy: https://transitous.org/
  > ```
  >
  > So the DNR rule is load-bearing. Extension service-worker requests do carry Chrome's
  > own UA, which is not "generic" and should pass on its own, but that identifies the
  > browser rather than this app, which is what the policy actually asks for.
  >
  > Still unverified, and the thing to check first when loading the extension: whether
  > `modifyHeaders` may set `User-Agent`, and whether an extension's own service-worker
  > requests are subject to its own DNR rules. A 403 is surfaced as a distinct
  > `blocked` error state rather than a generic network failure precisely so this
  > diagnoses itself. Fallback if DNR cannot do it: self-host MOTIS.
- Attribute in the UI: link `https://transitous.org/sources/` and the OSM copyright page.
- It is a best-effort volunteer service that asks to be contacted before heavy use. §7's
  caching and rate limiting is a requirement, not an optimisation.

---

## 5. Feature: transport line overlay (Phase 1)

### 5.1 Rendering

Two sources, four layers, all `dpt-*`:

| Layer | Type | Notes |
|---|---|---|
| `dpt-lines-casing` | line | White (or dark, per §5.3) halo, `line-width` = core + 3 |
| `dpt-lines-core` | line | `line-color: ['get','color']`, width interpolated by zoom (2 px @ z10 → 6 px @ z16) |
| `dpt-stops-circle` | circle | Radius by zoom, white stroke; hidden below z12 |
| `dpt-stops-label` | symbol | Station names; **z13+ only** |
| `dpt-dest-halo` / `dpt-dest-dot` / `dpt-dest-label` | circle, circle, symbol | Saved destinations. Added **last**, so they sit above the network *and* the journey line — they are the fixed reference the whole panel is about. Not affected by the master switch or the mode chips, which govern the transport overlay only. |

`line-join: round`, `line-cap: round`.

> **Font gotcha.** `dpt-stops-label` needs a fontstack MapTiler will serve. Do not invent
> one — read `text-font` off an existing symbol layer in Daft's style and reuse it. If no
> usable stack is found, skip the label layer and fall back to hover tooltips.

### 5.2 Interaction

- Hover a line → cursor `pointer`, thicken via a feature-state, tooltip with
  `shortName — longName`.
- Click a line → panel shows the route and its stations.
- Click a station → panel shows the station and the routes serving it.
- Toggle per mode (Luas / DART / Commuter rail) in the panel; persisted in settings.
- A master on/off toggle that removes every `dpt-*` layer, for an unobstructed map.

### 5.3 Basemap contrast

Daft's MapTiler style is light. Casing is white with the core colour on top. If Daft ever
ships a dark style, detect it from the `background` layer's paint colour and invert the
casing. One-line check, worth having.

### 5.4 Buses (Phase 3)

Dublin Bus + Go-Ahead is several hundred overlapping routes and will render as unreadable
spaghetti if handled the same way. When it comes:
- zoom-gate — no bus lines below z13;
- render as a single de-emphasised colour by default, not per-route colours;
- offer "high-frequency spines only" (BusConnects C/G/S/N) as the default subset;
- expect the bundle to jump by an order of magnitude — this is the trigger for PMTiles.

---

## 6. Feature: destinations and commute times (Phase 2)

### 6.1 Destinations are a list from day one

The original ask was "an address", but house-hunting almost always involves two commutes.
Modelling one and generalising later is an invasive change; modelling a list now is free.

```ts
interface Destination {
  id: string;            // uuid
  label: string;         // "Work", "Mum's"
  address: string;       // as entered
  lngLat: [number, number];
  color: string;         // for the journey line and badge
  enabled: boolean;
}
```

Address entry uses Transitous `/api/v1/geocode?text=…` (through the service worker) with an
autocomplete list; the user picks a result, which fixes the coordinates. Allow a manual
"drop a pin" fallback for addresses that fail to geocode — Irish addressing makes this a
real case, not a nicety. Eircode entry is not supported (no free lookup); note it in the UI.

The geocoder is worldwide and ranks on string similarity alone: "Trinity College" returns
a Warwickshire match first and the Dublin one third, and the `place` bias parameter barely
shifts it. Hits are therefore re-ranked Ireland-first (country is `areas[adminLevel === 2]`)
and every label carries its locality, plus the country when it is not Ireland.

### 6.2 Commute options (defaults)

| Option | Default | Rationale |
|---|---|---|
| Direction | **Arrive by** | You need to be at work by 09:00; departure-time search answers a different question |
| Time | **09:00** Dublin local | |
| Date | Next weekday, or **pinned** | Auto-tracking keeps it current; pinning lets every property be judged against the same day, and lets a weekend be checked deliberately |
| Travel mode | **Public transport** | Also walk, cycle, drive |
| Max walk | 1000 m | |
| Max transfers | 3 | |
| Results kept | Best 3 itineraries | |

Direction, time, date and travel mode live in the panel — they are what you change while
comparing properties. The limits live in the options page. Changing any of them is part of
the cache key (§7).

**Non-transit modes take a different request shape**, established by testing the live
server: `directModes=WALK|BIKE|CAR`, results read from `direct` rather than `itineraries`.
Two details are easy to get wrong silently:

- `maxDirectTime` **must** be sent. Without it, walk and bike return an empty `direct`
  array — indistinguishable from "no route exists" unless you know to look.
- `transitModes=''` suppresses transit. `transitModes=NONE` is rejected outright
  (`enum ModeEnum: unknown value NONE`), and omitting it makes the server compute a full
  transit plan that is then discarded.

### Guarding against bad upstream data

Operator feeds degrade. On 2026-08-13 the Luas Green feed reported trams running Balally →
city centre in zero minutes, so MOTIS returned an 18-minute journey for one that takes
about 39 — and duration-sorting promoted it to the headline figure.

Itineraries with a transit leg of zero elapsed time between two *different* places are
dropped. The rule is intentionally narrow — only what no timetable can make true. Legs
that are implausibly short but non-zero still pass; excluding those would require a speed
model, which is out of scope and would risk discarding genuine express services.

### 6.3 On click

Planning is automatic on click by default, toggleable from the panel (`autoPlan`). With it
on, the best journey is also drawn immediately — a click should yield a route on the map,
not a number that needs a second click to visualise. With it off, the click only selects
the property and offers an explicit **Calculate commute** button, which is the setting to
use when browsing quickly or staying well inside the free service's fair use.

1. MAIN detects the marker click (delegated listener on the map container, matching
   `[data-testid^="pin-container-"]`), derives `{listingId, lng, lat}` per §2.4, posts
   `PROPERTY_CLICKED`.

   > **Register with `addEventListener('click', handler, true)` — capture phase.** Daft
   > owns the pin's own click handler and may call `stopPropagation()`, in which case a
   > bubble-phase listener never fires at all and the whole feature looks broken for a
   > reason unrelated to routing. The handler is passive: never `preventDefault`, never
   > stop propagation, so Daft's own popup keeps working.
2. ISOLATED shows the panel immediately in a loading state — Daft's own popup keeps working
   and is not modified.
3. Service worker checks IndexedDB; on miss, queues a `/plan` per enabled destination.
4. `COMMUTE_RESULT` per destination streams back as each resolves.

### 6.3a On a detail page, there is nothing to click

A detail page is about one property, so requiring a click there is asking the user to tell
the extension something the page already knows — and §2.6 shows the detail marker has no
`pin-container-` testid to click anyway. The page selects itself:

1. MAIN resolves the listing per §2.6 and posts `LISTING_DETECTED`. This happens
   **independently of the map**: the coordinates come from the page's data, so the answer
   is available before the lazy-mounted map (§3.2) exists, and often before the user has
   scrolled anywhere near it.
2. ISOLATED treats it as a selection like any other and honours `autoPlan` — on, the
   commute is already there when the page finishes loading; off, the **Calculate commute**
   button is waiting with the property already chosen.
3. On navigation to another listing, MAIN posts `LISTING_CLEARED` first and the new
   `LISTING_DETECTED` when the page data catches up. The panel must drop the old answer at
   step one rather than leaving a stale number under a new address.

Consequences to hold onto:

- **The journey outlives the map.** A route calculated at *t*=1 s must still be drawn when
  the map mounts at *t*=20 s, so MAIN holds the current journey in module state and
  re-applies it on attach — the same treatment destination pins already get, and the same
  reason: `setStyle()` and remounts drop everything.
- **Only the automatic selection is automatic to clear.** A pin the user clicked on the
  search map is theirs; navigation clears the page's own selection, not that one.
- **Request volume moves.** Lookups now follow browsing rather than clicking: one per
  enabled destination per listing opened. That is the intended behaviour, but it spends the
  session cap (§7) without being asked, so it is stated in the README and `autoPlan` off
  remains the way to put every lookup back behind a button.

### 6.4 Result presentation

Show the **leg breakdown**, not a bare number — the number alone hides a 15-minute walk at
each end:

```
Work            38 min      arrive 08:52
  walk 10 min → Luas Green (Balally) 21 min → walk 8 min

Mum's           1 h 04      arrive 08:58
  walk 4 min → DART (Dundrum…) …
```

Clicking a result sends `HIGHLIGHT_ROUTE` with the itinerary geometry; MAIN draws it in
`dpt-journey` — walk legs dashed, transit legs solid in the route colour, endpoints
marked. Clearing the selection removes the layer.

MOTIS returns leg geometry as encoded polylines; decode in the service worker and pass
GeoJSON over the wire so MAIN needs no decoder.

### 6.5 Failure states

Every one of these needs a visible, non-alarming UI state: no route found within
`maxTravelTime`; property outside GTFS coverage; Transitous 5xx/timeout (offer retry);
rate-limited (say so, with the cached result if there is one); geocoding failure.

---

## 7. Caching and rate discipline

Transitous is volunteer-run. This section is a correctness requirement.

**Cache key**

```
plan:{originLat.toFixed(5)},{originLng.toFixed(5)}|{destId}|{optionsHash}|{arrivalBucket}
```

5 decimals ≈ 1.1 m — precise enough to distinguish properties, coarse enough that a
re-click on the same pin always hits. `arrivalBucket` is the resolved target datetime
(next weekday 09:00), so a whole session shares one bucket.

> **Build the bucket in `Europe/Dublin` and serialize it with its offset.** Dublin is
> UTC+1 in August and UTC+0 in January, so a naively-constructed UTC bucket routes the
> wrong hour for half the year *and* silently splits the cache across the DST boundary.
> 09:00 Dublin is the user-meaningful time; the wire format is whatever the API takes.

**Store:** IndexedDB (`dpt-cache`, store `plans`), value = itineraries + `fetchedAt`.
**TTL:** 7 days for successful plans, 1 hour for "no route found", no caching of 5xx.
**Eviction:** LRU above 5000 entries.

**Limits, enforced in the service worker:**
- max 2 concurrent requests;
- ≥250 ms between request starts;
- soft cap of 200 network plans per browser session, then a UI warning;
- exponential backoff with jitter on 429/503, starting 2 s, capped 60 s;
- an in-flight map keyed by cache key, so double-clicks coalesce.

Prefetching is explicitly forbidden in v1: only a user click causes a network plan. Phase 3
badging revisits this, and must not ship against public Transitous without either the batch
endpoint or a self-hosted backend.

---

## 8. Storage

| Store | Contents |
|---|---|
| `chrome.storage.sync` | `destinations[]`, `commuteOptions` — small, worth syncing |
| `chrome.storage.local` | `visibleModes`, `lineOpacity`, `showStops`, `panelCollapsed`, session counters |
| IndexedDB `dpt-cache` | commute plans (§7) |
| bundled `public/data/*.geojson` | transport lines and stops (§4.1) |

Home and work addresses are personal data. They stay local, are never sent anywhere except
as coordinates to the routing provider, and the options page gets a **"Delete all my data"**
button that clears all four. This becomes a privacy-policy obligation on a Store release.

---

## 9. Manifest and permissions

```jsonc
{
  "manifest_version": 3,
  "name": "Dublin Commute Overlay",
  "permissions": ["storage", "declarativeNetRequestWithHostAccess"],
  "host_permissions": ["https://api.transitous.org/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    { "matches": ["https://www.daft.ie/*"], "js": ["main-world.js"],
      "world": "MAIN", "run_at": "document_idle" },
    { "matches": ["https://www.daft.ie/*"], "js": ["isolated.js"],
      "world": "ISOLATED", "run_at": "document_idle" }
  ],
  "declarative_net_request": {
    "rule_resources": [{ "id": "transitous-ua", "enabled": true, "path": "rules/transitous.json" }]
  }
}
```

No `web_accessible_resources`: the bundled GeoJSON is read by the service worker and
passed over the message channel (§3.1), so nothing needs exposing to the page.

Deliberately **not** requested: `tabs`, `<all_urls>`, `scripting`, `webRequest`. Keep it
minimal — it is also what makes an eventual Store review straightforward. The on/off
toggle is the place this constraint bites, and §3.4 is how it is met without `tabs`.

`action` carries a `default_title` and **no** `default_popup`: with no popup, clicks reach
`chrome.action.onClicked`, which is the whole toggle. Adding a popup later would silently
stop that event firing.

`declarativeNetRequest` rule: set `User-Agent` on requests to `api.transitous.org` to
`DublinCommuteOverlay/<version> (+<contact url or email>)`.

**Stack:** TypeScript + Vite + `@crxjs/vite-plugin` (MV3-aware, handles the multi-world
content script entries and gives HMR). No runtime dependency on MapLibre — we use Daft's
instance and never load our own copy.

---

## 10. Repo layout

```
extension/
  manifest.json
  src/
    main-world/    map-handle.ts  layers.ts  markers.ts  journey.ts  listing.ts  bus.ts
    isolated/      bridge.ts  panel/  (Shadow DOM UI)
    background/    service-worker.ts  routing/  cache/  ratelimit.ts
    shared/        messages.ts  types.ts  listing.ts  geo.ts
    options/       options.html  options.ts
  public/data/     dublin-rail-lines.geojson  dublin-rail-stops.geojson  ATTRIBUTION.md
tools/
  build-transport-data.mjs
SPEC.md
```

The panel UI lives in a **Shadow DOM** root to keep Daft's stylesheets out.

---

## 11. Phases

### Phase 0 — feasibility spike (do this before anything else)

One question: **does the map handle survive real navigation with layers intact?**

Acceptance: with a hardcoded two-line GeoJSON, the lines are *visible on screen* and
correctly positioned through this full cycle —

1. Load `/property-for-rent/dublin-city?showMap=true` → lines visible.
2. Pan and zoom → lines track the basemap exactly.
3. Click a property → open the detail page → scroll to the lazy map → lines appear there too.
4. Browser back → search map → lines still there.
5. Toggle the map off (`close-map-button`) and on → lines return.
6. No duplicate layers, no duplicate listeners, no console errors, after all of the above.

If step 3, 4 or 5 cannot be made to hold, stop and reconsider: the fallback is a
separately-positioned overlay canvas driven by `map.project()`, which is more code and
strictly worse, and it should be a deliberate decision rather than a drift.

### Phase 1 — line overlay (G1)
Build step and bundle → `StaticBundleProvider` → the four layers → mode toggles → hover and
click interactions → panel shell.

### Phase 2 — commute times (G2, G3, G4)
Destination CRUD and geocoding → service-worker routing with cache and rate limiting →
click-to-commute → leg breakdown → journey line → failure states.

### Phase 3 — breadth (G5)
Re-test the batch endpoints → badges on visible pins (gated on batch or self-hosting) →
buses per §5.4 → possibly isochrones via `/api/v6/one-to-all`.

---

## 12. Risks and open questions

| Risk | Severity | Mitigation |
|---|---|---|
| Daft ships a bundle change that breaks the fiber walk | **High** | Fiber walk is one isolated module with a clear failure signal; show a "couldn't attach to map" badge rather than failing silently. Overlay-canvas fallback is the escape hatch. |
| Layers lost on navigation | **High** | Phase 0 gate; `ensureLayers` + `styledata` + MutationObserver (§3.2) |
| Transitous unavailable or rate-limits us | Medium | Cache-first; degrade to "commute unavailable"; `SelfHostedMotisProvider` is the documented answer |
| Batch matrix endpoints don't exist on the live server | Medium | Confirmed 400 today; Phase 3 is explicitly gated on re-testing |
| Daft's pin handler swallows the click event | Medium | Capture-phase listener (§6.3) — cheap, but invisible as a cause if missed |
| DNR cannot set `User-Agent` on our own SW requests | **High** | Transitous 403s generic UAs (§4.2). Surfaced as a distinct `blocked` error; fallback is self-hosted MOTIS |
| Geocoder ranks UK/other matches above Irish ones | Medium | Confirmed: "Trinity College" returns Warwickshire first. Results are re-ranked Ireland-first and labelled with country (§6.1) |
| MapTiler fontstack unavailable for labels | Low | Reuse an in-style `text-font`; degrade to tooltips |
| GTFS route colours missing or ugly | Low | Fallback colour table in the build step |
| Daft's ToS on modifying their pages | Low, but real | Client-side, personal, no scraping of their APIs, no ad interference. Re-read before any Store release. |

**Open, to decide when reached:**
- Store release needs: privacy policy, a self-hosted routing backend, and a decision on
  whether the journey polyline leaking the destination to Daft's page JS (§3.1) is
  acceptable — if not, the journey line has to be drawn in an overlay canvas instead.
- Whether to add GTFS-R real-time (`developer.nationaltransport.ie`, free API key) for
  live departures at stations. Nice, and out of scope for v1.
- Whether the bundle should be refreshed automatically from data.gov.ie when timetables
  change, or manually re-run and re-committed. Manual for v1.

---

## 13. Attribution (required in the UI)

- Transit routing: [Transitous](https://transitous.org/) / [sources](https://transitous.org/sources/)
- Map data: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)
- Timetable and route data: National Transport Authority via [data.gov.ie](https://data.gov.ie/), CC-BY 4.0
- Basemap: © MapTiler (Daft's own attribution — do not obscure it)
