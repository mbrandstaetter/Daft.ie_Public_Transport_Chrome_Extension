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
import { DEFAULT_DISPLAY_SETTINGS, type DisplaySettings, type Surface } from '../shared/types';

const MAP_SELECTOR = '.maplibregl-map';
const PIN_SELECTOR = '[data-testid^="pin-container-"]';

let data: LineData | null = null;
let settings: DisplaySettings = DEFAULT_DISPLAY_SETTINGS;
const attached = new WeakSet<MapLike>();
let current: MapLike | null = null;
let currentContainer: HTMLElement | null = null;

const surface = (): Surface =>
  /\/(for-rent|for-sale|share|new-home-for-sale)\/[^/]+\/\d+/.test(location.pathname)
    ? 'detail'
    : 'search';

/* ------------------------------- attachment ------------------------------- */

function attach(map: MapLike, container: HTMLElement): void {
  if (attached.has(map)) return;
  attached.add(map);
  current = map;
  currentContainer = container;

  const refresh = () => {
    if (data) ensureLayers(map, data, settings);
  };

  // setStyle() drops every custom source and layer; styledata is the only reliable
  // signal that it happened. ensureLayers is idempotent precisely so this is safe.
  map.on('styledata', refresh);
  map.on('load', refresh);
  refresh();

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
function watchForMap(): void {
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
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
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
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
      if (current) ensureLayers(current, data, settings);
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
      if (current) setJourney(current, msg.itinerary, msg.color);
      break;
    }
    case 'CLEAR_SELECTION': {
      if (current) setJourney(current, null, '#000000');
      break;
    }
  }
});

/* ---------------------------------- boot ---------------------------------- */

bindMarkerClicks();
watchForMap();
tryAttach();
// The isolated side may load first or second; ask for state either way.
postToIsolated({ type: 'REQUEST_INIT' });
