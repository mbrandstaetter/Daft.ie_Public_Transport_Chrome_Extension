import type {
  CommuteError,
  CommuteOptions,
  CommuteResult,
  Destination,
  DisplaySettings,
  GeocodeHit,
  Itinerary,
  Surface,
} from './types';

/** Namespace tag on every window.postMessage payload, so we ignore Daft's own traffic. */
export const DPT = '__dpt_v1';

/* ------------------------- MAIN world -> ISOLATED ------------------------- */

export type MainToIsolated =
  | { type: 'MAP_READY'; surface: Surface }
  | { type: 'MAP_LOST' }
  | { type: 'MAP_ATTACH_FAILED'; detail: string }
  | { type: 'PROPERTY_CLICKED'; listingId: string; lng: number; lat: number; priceLabel?: string }
  /**
   * A detail page identifies its own property, so the commute is measured without a click.
   * Sent independently of the map: the coordinates come from the page's data, and the
   * answer is useful before the lazy-mounted map exists.
   */
  | { type: 'LISTING_DETECTED'; listingId: string; lng: number; lat: number; label?: string }
  /**
   * The self-selected listing no longer applies: `navigated` means we left it (or moved to
   * another), `unresolved` means this is a detail page whose coordinates could not be read.
   * `pending` says a `LISTING_DETECTED` is on its way, so the panel can wait rather than
   * telling the user to click a pin that a detail page does not have.
   */
  | { type: 'LISTING_CLEARED'; reason: 'navigated' | 'unresolved'; pending: boolean }
  | { type: 'LINE_CLICKED'; name: string; detail: string }
  | { type: 'REQUEST_INIT' };

/* ------------------------- ISOLATED -> MAIN world ------------------------- */

export type IsolatedToMain =
  /**
   * The GeoJSON travels in the message rather than as a chrome-extension:// URL for MAIN
   * to fetch. A page-context fetch of an extension resource is subject to daft.ie's own
   * connect-src CSP, and if that blocks it the lines silently never render. The bundle is
   * ~43 KB, so the structured clone costs nothing worth protecting.
   */
  | { type: 'LINES_DATA'; lines: unknown; stops: unknown }
  | { type: 'SETTINGS_CHANGED'; settings: DisplaySettings }
  | { type: 'HIGHLIGHT_ROUTE'; itinerary: Itinerary | null; color: string }
  /** Destination pins are drawn on the map, not just listed in the panel. */
  | { type: 'DESTINATIONS'; destinations: Array<Pick<Destination, 'id' | 'label' | 'lngLat' | 'color' | 'enabled'>> }
  | { type: 'CLEAR_SELECTION' }
  /**
   * The mirror of `REQUEST_INIT`. Whichever world loads first would otherwise announce
   * into an empty room: MAIN can resolve a detail listing before the panel is listening.
   */
  | { type: 'PANEL_READY' };

/* ---------------------- ISOLATED <-> service worker ----------------------- */

export type PanelToWorker =
  | { type: 'GET_STATE' }
  | { type: 'GET_LINES' }
  | { type: 'PLAN'; listingId: string; lng: number; lat: number }
  | { type: 'GEOCODE'; text: string }
  | { type: 'ADD_DESTINATION'; destination: Destination }
  | { type: 'REMOVE_DESTINATION'; id: string }
  | { type: 'UPDATE_DESTINATION'; id: string; patch: Partial<Destination> }
  | { type: 'SAVE_SETTINGS'; settings: DisplaySettings }
  | { type: 'SAVE_COMMUTE_OPTIONS'; options: CommuteOptions }
  | { type: 'WIPE_ALL' };

export type WorkerReply =
  | {
      ok: true;
      kind: 'state';
      destinations: Destination[];
      settings: DisplaySettings;
      commuteOptions: CommuteOptions;
    }
  | { ok: true; kind: 'plan'; results: Array<CommuteResult | ({ destId: string } & { error: CommuteError })> }
  | { ok: true; kind: 'lines'; lines: unknown; stops: unknown }
  | { ok: true; kind: 'geocode'; hits: GeocodeHit[] }
  | { ok: true; kind: 'ack' }
  | { ok: false; error: string };

/* -------------------------------- helpers -------------------------------- */

interface Envelope<T> {
  [DPT]: true;
  dir: 'm2i' | 'i2m';
  payload: T;
}

function post<T>(dir: 'm2i' | 'i2m', payload: T): void {
  const envelope: Envelope<T> = { [DPT]: true, dir, payload };
  window.postMessage(envelope, window.location.origin);
}

export const postToIsolated = (msg: MainToIsolated) => post('m2i', msg);
export const postToMain = (msg: IsolatedToMain) => post('i2m', msg);

function listen<T>(dir: 'm2i' | 'i2m', handler: (msg: T) => void): () => void {
  const onMessage = (event: MessageEvent) => {
    // Only same-window messages; anything cross-frame is not ours.
    if (event.source !== window) return;
    const data = event.data as Envelope<T> | undefined;
    if (!data || data[DPT] !== true || data.dir !== dir) return;
    handler(data.payload);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

export const onMainMessage = (h: (msg: MainToIsolated) => void) => listen('m2i', h);
export const onIsolatedMessage = (h: (msg: IsolatedToMain) => void) => listen('i2m', h);
