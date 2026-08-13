/**
 * MAIN-world content script.
 *
 * Runs in the page's own JS context because the fiber walk needs access to expando
 * properties React sets on DOM nodes, which an isolated-world script cannot see. The
 * cost is that `chrome.*` is unavailable here - everything outward goes through
 * window.postMessage to the isolated-world bridge.
 */
import { findMapInstance, markerPixel, type MapLike } from './map-handle';
import {
  applySettings,
  destinationsToGeoJson,
  ensureLayers,
  setDestinations,
  setJourney,
  LAYER_LINES_CORE,
  type LineData,
} from './layers';
import { onIsolatedMessage, postToIsolated } from '../shared/messages';
import { listingIdFromPath, type DetailListing } from '../shared/listing';
import { resolveDetailListing } from './listing';
import {
  DEFAULT_DISPLAY_SETTINGS,
  type DisplaySettings,
  type Itinerary,
  type Surface,
} from '../shared/types';

const MAP_SELECTOR = '.maplibregl-map';
const PIN_SELECTOR = '[data-testid^="pin-container-"]';

let data: LineData | null = null;
let settings: DisplaySettings = DEFAULT_DISPLAY_SETTINGS;
const attached = new WeakSet<MapLike>();
let current: MapLike | null = null;
let currentContainer: HTMLElement | null = null;

/**
 * The drawn journey, held here rather than only pushed at the map. Two things would
 * otherwise lose it: setStyle(), which drops the journey source along with everything
 * else, and a detail page's lazy map, which mounts long after the route was calculated.
 */
let journey: { itinerary: Itinerary | null; color: string } = { itinerary: null, color: '#000000' };

const surface = (): Surface => (listingIdFromPath(location.pathname) ? 'detail' : 'search');

/* ------------------------------- attachment ------------------------------- */

/**
 * Everything we draw, drawn. Module-level rather than a closure inside attach() because
 * the inbound handlers need it too: layers and the journey can each arrive before the
 * other, and whichever lands second has to put both on the map.
 */
function refreshMap(): void {
  if (!current) return;
  if (data) ensureLayers(current, data, settings);
  // ensureLayers re-creates the journey source *empty*, so this must follow it.
  setJourney(current, journey.itinerary, journey.color);
}

function attach(map: MapLike, container: HTMLElement): void {
  if (attached.has(map)) return;
  attached.add(map);
  current = map;
  currentContainer = container;

  // setStyle() drops every custom source and layer; styledata is the only reliable
  // signal that it happened. ensureLayers is idempotent precisely so this is safe.
  map.on('styledata', refreshMap);
  map.on('load', refreshMap);
  refreshMap();

  bindLineHover(map, container);
  postToIsolated({ type: 'MAP_READY', surface: surface() });
}

function bindLineHover(map: MapLike, container: HTMLElement): void {
  const canvas = map.getCanvas();
  map.on('mouseenter', LAYER_LINES_CORE, () => {
    canvas.style.cursor = 'pointer';
  });
  map.on('mouseleave', LAYER_LINES_CORE, () => {
    canvas.style.cursor = '';
  });
  map.on('click', LAYER_LINES_CORE, (event: unknown) => {
    const features = (event as { features?: Array<{ properties?: Record<string, string> }> }).features;
    const props = features?.[0]?.properties;
    if (!props) return;
    postToIsolated({
      type: 'LINE_CLICKED',
      name: props['name'] ?? 'Line',
      detail: props['detail'] ?? '',
    });
  });
  void container;
}

/**
 * MapLibre adds `.maplibregl-map` inside its own constructor, so the class appearing
 * means the Map exists - but React may not have committed the ref that holds it yet.
 * Hence the retry ladder rather than a single attempt.
 */
function tryAttach(attemptDelays = [0, 120, 400, 1000, 2500]): void {
  const container = document.querySelector<HTMLElement>(MAP_SELECTOR);
  if (!container) return;

  const map = findMapInstance(container);
  if (map) {
    attach(map, container);
    return;
  }
  const [, ...rest] = attemptDelays;
  if (rest.length) {
    setTimeout(() => tryAttach(rest), rest[0]);
  } else {
    postToIsolated({
      type: 'MAP_ATTACH_FAILED',
      detail: 'Found a MapLibre container but could not reach the map instance.',
    });
  }
}

/**
 * Next.js swaps the map out on client-side navigation (search <-> detail, map toggle),
 * constructing a brand-new instance each time, and the detail-page map is lazy-mounted
 * on scroll. Both look identical from here: a new `.maplibregl-map` node appears.
 */
function syncMap(): void {
  const container = document.querySelector<HTMLElement>(MAP_SELECTOR);
  if (!container) {
    if (current) {
      current = null;
      currentContainer = null;
      postToIsolated({ type: 'MAP_LOST' });
    }
    return;
  }

  // Track the container, not just the map. Next.js can remove the old map and
  // insert the new one in a single commit, so we can be holding a dead instance
  // while a live container is already on screen. Keying off `current` alone leaves
  // that state permanently stuck: the map is non-null, so no retry ever starts.
  if (container !== currentContainer) {
    currentContainer = container;
    current = null;
    tryAttach();
    return;
  }

  const map = findMapInstance(container);
  if (map && !attached.has(map)) attach(map, container);
  else if (!map && !current) tryAttach();
}

/**
 * The same observer covers the map and the URL. Client-side navigation always rewrites
 * the DOM, so a mutation is a reliable "something changed" signal - and reading
 * `location` costs nothing next to the map query that is happening anyway. `popstate`
 * covers the back button, which can restore a page without rebuilding much of it.
 */
function watchPage(): void {
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      syncLocation();
      syncMap();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', syncLocation);
}

/* ----------------------------- detail listings ---------------------------- */

let currentPath = location.pathname;
/** The listing the panel has been told about, kept so it can be re-announced. */
let announced: DetailListing | null = null;

/**
 * Props lag the URL: after a route change Next.js updates `location` before the new
 * page's data is in place, and reading too early yields the *previous* listing. The gate
 * in shared/listing.ts rejects that, so a stale read costs a retry rather than showing
 * the wrong property's commute. Same ladder shape as tryAttach.
 */
function detectListing(listingId: string, attemptDelays = [0, 120, 400, 1000, 2500]): void {
  // A newer navigation supersedes an in-flight ladder.
  if (listingIdFromPath(location.pathname) !== listingId) return;

  const listing = resolveDetailListing(location.pathname);
  if (listing) {
    announced = listing;
    postToIsolated({ type: 'LISTING_DETECTED', ...listing });
    return;
  }

  const [, ...rest] = attemptDelays;
  if (rest.length) {
    setTimeout(() => detectListing(listingId, rest), rest[0]);
  } else {
    postToIsolated({ type: 'LISTING_CLEARED', reason: 'unresolved', pending: false });
  }
}

function syncLocation(): void {
  if (location.pathname === currentPath) return;
  currentPath = location.pathname;

  const listingId = listingIdFromPath(currentPath);
  if (listingId === (announced?.listingId ?? null)) return;

  // Drop the previous listing's answer immediately - it belongs to a property that is no
  // longer on screen. The replacement arrives once the page's data catches up.
  announced = null;
  postToIsolated({ type: 'LISTING_CLEARED', reason: 'navigated', pending: listingId !== null });
  if (listingId) detectListing(listingId);
}

/* --------------------------------- markers -------------------------------- */

/**
 * Capture phase, deliberately. Daft owns the pin's own click handler and may call
 * stopPropagation() on it; a bubble-phase listener would then never fire and the whole
 * commute feature would look broken for a reason unrelated to routing. The handler is
 * strictly passive - it never preventDefaults or stops propagation, so Daft's popup
 * still opens exactly as it would without us.
 */
function bindMarkerClicks(): void {
  document.addEventListener(
    'click',
    (event) => {
      if (!current) return;
      const target = event.target as HTMLElement | null;
      const pin = target?.closest?.(PIN_SELECTOR) as HTMLElement | null;
      if (!pin) return;

      const listingId = pin.dataset['testid']?.replace('pin-container-', '') ?? '';
      const marker = pin.closest('.maplibregl-marker') as HTMLElement | null;
      if (!marker || !listingId) return;

      const pixel = markerPixel(marker);
      if (!pixel) return;

      const { lng, lat } = current.unproject(pixel);
      postToIsolated({
        type: 'PROPERTY_CLICKED',
        listingId,
        lng,
        lat,
        priceLabel: pin.textContent?.trim() || undefined,
      });
    },
    true
  );
}

/* --------------------------------- inbound -------------------------------- */

onIsolatedMessage((msg) => {
  switch (msg.type) {
    case 'LINES_DATA': {
      // Keep any destinations that arrived first rather than replacing the whole object.
      data = { lines: msg.lines, stops: msg.stops, destinations: data?.destinations };
      // refreshMap, not ensureLayers: a map that attached before this arrived had no
      // sources to draw into, so a journey calculated in the meantime is still unpainted.
      refreshMap();
      break;
    }
    case 'SETTINGS_CHANGED': {
      settings = msg.settings;
      if (current) applySettings(current, settings);
      break;
    }
    case 'DESTINATIONS': {
      // Held on `data` as well as pushed to the source, so a restyle (which drops every
      // custom source) restores the pins along with everything else.
      const geojson = destinationsToGeoJson(msg.destinations);
      if (data) data.destinations = geojson;
      else data = { lines: null, stops: null, destinations: geojson };
      if (current) setDestinations(current, geojson);
      break;
    }
    case 'HIGHLIGHT_ROUTE': {
      // Held as well as drawn: on a detail page the route is usually calculated before
      // the map has mounted, so `current` being null here is the normal case, not an edge.
      journey = { itinerary: msg.itinerary, color: msg.color };
      if (current) setJourney(current, journey.itinerary, journey.color);
      break;
    }
    case 'CLEAR_SELECTION': {
      journey = { itinerary: null, color: '#000000' };
      if (current) setJourney(current, null, journey.color);
      break;
    }
    case 'PANEL_READY': {
      // Re-announce anything the panel may have missed by loading second.
      if (current) postToIsolated({ type: 'MAP_READY', surface: surface() });
      if (announced) postToIsolated({ type: 'LISTING_DETECTED', ...announced });
      break;
    }
  }
});

/* ---------------------------------- boot ---------------------------------- */

bindMarkerClicks();
watchPage();
tryAttach();
const bootListingId = listingIdFromPath(location.pathname);
if (bootListingId) detectListing(bootListingId);
// The isolated side may load first or second; ask for state either way.
postToIsolated({ type: 'REQUEST_INIT' });
