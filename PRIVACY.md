# Privacy Policy — Dublin Commute Overlay

_Last updated: 2026-08-13_

Dublin Commute Overlay is a browser extension that overlays public transport lines on
daft.ie property maps and calculates commute times to destinations you choose.

This policy describes exactly what the extension does with data. It is short because the
extension does very little.

## What is collected

**Nothing is collected by the developer.** There is no analytics, no telemetry, no error
reporting, no advertising identifier, and no account. The developer has no server and
receives no data from your use of the extension, ever.

## What is stored, and where

All of it stays in your own browser:

| Data | Where | Why |
|---|---|---|
| Destinations you add (label, address text, coordinates) | `chrome.storage.sync` | So your commute destinations persist, and follow you across browsers if you have Chrome Sync enabled |
| Your settings (travel mode, time, date, walking and journey limits, panel position) | `chrome.storage.sync` and `chrome.storage.local` | So the extension behaves consistently |
| Cached journey results | IndexedDB, in the extension's own storage | So re-checking a property does not repeat a network request. Cleared automatically after 7 days |

If you have Chrome Sync switched on, `chrome.storage.sync` data is synchronised by Google
between your own signed-in browsers, under
[Google's privacy policy](https://policies.google.com/privacy). The developer has no access
to it. Turning off Chrome Sync keeps this data on one device.

## What is sent off your device

One kind of request only: journey lookups to **[Transitous](https://transitous.org/)**, a
free, community-run public transport routing service.

Each request contains:

- the **coordinates** of the property you clicked,
- the **coordinates** of the destination you are measuring against,
- the date, time and travel mode you have configured.

It does **not** contain your address text, your destination labels, your IP-derived
identity, any account information, any cookie, or anything identifying you or the
extension's other data. Requests are not tagged with a user identifier of any kind.

Requests are only made when **you click a property pin** (or press "Calculate commute" if
you have turned automatic lookups off). There is no background activity, and no
prefetching. Results are cached so that repeating the same lookup does not repeat the
request.

Address search, when you add a destination, sends the **text you typed** to the same
service in order to turn it into coordinates.

Transitous is operated independently of this extension. Their handling of requests is
described at [transitous.org](https://transitous.org/). Consider whether you are
comfortable with a third party receiving the coordinates of places you look up, since those
coordinates will typically include where you live or work.

## What the extension can see on daft.ie

The extension runs only on `https://www.daft.ie/*`. On those pages it reads the map and the
property pins in order to draw transport lines and to know which property you clicked. It
does **not** read your Daft account, saved searches, messages, or any form you fill in, and
it never sends anything to Daft or reads Daft's own network traffic.

The journey it draws on the map is passed to the page's own JavaScript context in order to
render it. This means the coordinates of a drawn route are technically visible to code
running on daft.ie while a route is displayed. Nothing else the extension stores is exposed
this way.

## Permissions, and why each exists

| Permission | Reason |
|---|---|
| `storage` | Save destinations and settings, as described above |
| `declarativeNetRequestWithHostAccess` | Attach an identifying `User-Agent` to the extension's own requests to Transitous, which their usage policy requires |
| `host_permissions: api.transitous.org` | Make the journey lookups |
| Content scripts on `www.daft.ie` | Draw the overlay and read property pin positions |

The extension deliberately does **not** request `tabs`, `<all_urls>`, `scripting`, `history`,
`cookies`, or `webRequest`.

## Deleting your data

**Options → "Delete all my data"** clears saved destinations, settings, and the cached
journey results. Removing the extension from Chrome also removes all of its storage.

## Children

The extension is not directed at children and collects nothing from anyone.

## Changes

Any change to this policy will be committed to
[the repository](https://github.com/mbrandstaetter/Daft.ie_Public_Transport), so the full
history of what this document has said is public and auditable.

## Contact

Please open an issue at
[github.com/mbrandstaetter/Daft.ie_Public_Transport/issues](https://github.com/mbrandstaetter/Daft.ie_Public_Transport/issues).
