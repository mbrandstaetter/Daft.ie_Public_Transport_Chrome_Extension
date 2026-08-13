# Publishing

Everything needed for a Chrome Web Store submission, plus the things that are genuinely
still open. Run `npm run package` to produce `release/dublin-commute-overlay-<version>.zip`.

---

## Blockers — resolve before submitting

### 1. The extension has never been run in a real browser

Automated tests cover the data, the routing API contract, and the map-layer logic. They do
**not** cover the thing most likely to break: attaching to Daft's MapLibre instance through
the React fiber, and surviving navigation. Work through **"Verifying it works"** in the
README first. Publishing software to the public that has never been executed is not a
defensible position, and the screenshots below cannot be produced without doing it anyway.

### 2. Transitous has not been asked

The routing service is free and volunteer-run, and asks to be contacted before heavy or
automated use. A personal, unlisted install is well inside that; a public listing that may
attract arbitrary numbers of users is exactly what the request is about. Draft email below.

If the answer is no, or no reply arrives, the fallback is a self-hosted MOTIS instance —
`RoutingProvider` already exists for this, so it is a base-URL change rather than a rewrite
(SPEC.md §4.2).

### 3. Unverified: `declarativeNetRequest` setting `User-Agent`

Transitous rejects generic user agents with `HTTP 403` (verified). Whether Chrome lets an
extension set `User-Agent` on its *own* service-worker requests is untested. Load the
extension, do one lookup, and confirm no `blocked` error appears. If it does, this must be
solved before other people depend on it.

---

## Store listing copy

**Name** (75 max)

```
Dublin Commute Overlay
```

**Short description** (132 max — currently 114)

```
See Luas, DART and rail lines on daft.ie property maps, and how long the commute is to the places you actually go.
```

**Detailed description**

```
Dublin Commute Overlay adds two things to property searching on daft.ie: the public
transport network drawn on the map, and real commute times from any property you click.

TRANSPORT LINES
Luas, DART and commuter rail are drawn directly into the site's own map, so they pan and
zoom with it rather than floating on top. Toggle each mode on or off, and show or hide
stops and stations.

COMMUTE TIMES
Save the places you actually travel to — work, college, family — and they appear as pins on
the map. Click any property and you get door-to-door times to each one, with the full leg
breakdown ("walk 10 · Luas Green 21 · walk 8") rather than a single number that hides a
15-minute walk at each end. The chosen journey is drawn on the map.

Compare by public transport, walking, cycling or driving. Pin a specific date and time so
every property is judged against the same Tuesday 09:00 — or check what a Saturday looks
like, when timetables differ.

HONEST NUMBERS
When no route is found, it distinguishes "no public transport serves this property" from
"this exceeds the limits you set, and here is what it would actually take". Journeys
containing impossible legs — a tram covering five stops in zero minutes, which live
operator feeds do occasionally report — are discarded rather than shown as an
unrealistically fast commute.

PRIVACY
No accounts, no analytics, no tracking. Destinations and settings stay in your browser.
The only data leaving your device is the coordinates being routed between, sent to the
Transitous public transport routing service.

Covers Greater Dublin: Luas, DART and commuter rail.

Open source: https://github.com/mbrandstaetter/Daft.ie_Public_Transport
Not affiliated with, endorsed by, or connected to Daft Media Ltd.
```

**Category:** Travel (alternative: Productivity)
**Language:** English (Ireland/UK)

---

## Privacy tab answers

**Single purpose** (must be narrow, or it is rejected)

```
Display public transport lines and commute times on daft.ie property map pages.
```

**Permission justifications**

| Field | Answer |
|---|---|
| `storage` | Stores the user's saved commute destinations and display settings locally, so they persist between visits. |
| `declarativeNetRequestWithHostAccess` | Sets an identifying User-Agent header on the extension's own requests to the Transitous routing API. That service rejects requests with generic user agents, and its usage policy requires callers to identify themselves. Used for no other purpose and on no other host. |
| Host permission `https://api.transitous.org/*` | The public transport routing service that calculates commute times. It is the only network destination the extension contacts. |
| Content script on `https://www.daft.ie/*` | The extension's entire function is to draw transport lines onto the map on these pages and read which property pin was clicked. |

**Data usage disclosures** — tick **Location** (property and destination coordinates are
sent for routing). Do **not** tick authentication information, personal communications,
financial information, health information, personally identifiable information, web
history, or user activity. Then confirm all three certifications: data is not sold, not
used for unrelated purposes, and not used to determine creditworthiness.

**Privacy policy URL**

```
https://github.com/mbrandstaetter/Daft.ie_Public_Transport/blob/main/PRIVACY.md
```

---

## Screenshots

1280×800 or 640×400, between one and five. Take these while doing the README verification:

1. Search map with the transport lines overlaid — the core idea, so make it the first one.
2. A property clicked, panel showing the commute with the leg breakdown and the journey
   drawn on the map.
3. Destination pins visible alongside the property pins.
4. Travel-mode chips and the date/time controls.

Avoid capturing Daft's logo prominently, and do not use their branding in the promo tile.

---

## Draft email to Transitous

Send before listing publicly — their contact details are at https://transitous.org/.
Adjust the volume estimate to something you actually believe.

```
Subject: Courtesy notice: small browser extension using the routing API

Hello,

I've built a browser extension that overlays Dublin's public transport network on the
Irish property site daft.ie and shows commute times from a property to a user's saved
destinations. It uses your /api/v1/plan and /api/v1/geocode endpoints. I'd like to publish
it on the Chrome Web Store, and your usage policy asks that I check with you first.

How it behaves:

- Requests are only made on an explicit user click. No prefetching, no background activity.
- Results are cached locally (IndexedDB) for 7 days, keyed on rounded coordinates, so
  repeat lookups of the same property cost nothing.
- Client-side limits: max 2 concurrent requests, 250 ms apart, 200 per browser session,
  with exponential backoff on 429/503.
- Identifying User-Agent set via declarativeNetRequest:
  DublinCommuteOverlay/<version> (+<repo URL>)
- Attribution to Transitous and your sources page is shown in the UI and the listing.

Realistically this is a niche tool for people flat-hunting in Dublin, so I'd expect tens of
users rather than thousands, and a handful of requests per user per session. But I don't
want to push traffic at a volunteer-run service without asking.

Is this acceptable? If you'd rather I didn't, or if there's a volume you'd want me to stay
under, I'm happy to either hold off or move to a self-hosted MOTIS instance.

The source is at https://github.com/mbrandstaetter/Daft.ie_Public_Transport if you'd like
to check any of the above.

Thanks for running Transitous — it made this possible at all.

<your name>
```

---

## Steps only you can do

The Store requires an account, a fee, and acceptance of a legal agreement, so the
submission itself is yours to make:

1. Register at https://chrome.google.com/webstore/devconsole (one-off **$5** fee).
2. Accept the Developer Agreement.
3. **New item** → upload `release/dublin-commute-overlay-0.1.0.zip`.
4. Paste the listing copy above; upload icon and screenshots.
5. Fill the Privacy tab using the answers above; add the privacy policy URL.
6. Choose visibility — **Unlisted** is worth considering first: the extension is
   installable by link and testable by real users without being publicly discoverable,
   which fits an untested first release and keeps routing volume predictable.
7. Submit. Review typically takes a few days; extensions with host permissions and a
   content script sometimes take longer.

## After a version bump

```bash
npm version patch      # or edit extension/manifest.json
npm run package
```

`manifest.json` is the source of truth for the version; the build syncs the User-Agent
string to it. Keep `package.json` and the manifest in step.
