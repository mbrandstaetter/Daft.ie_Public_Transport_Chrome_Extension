/**
 * Service worker: the only place that talks to the network.
 *
 * Everything routes through here so caching, rate limiting and the declarativeNetRequest
 * User-Agent rule all apply in one place, and so requests are not attributed to daft.ie
 * by a content-script Referer.
 */
import { planKey, readPlan, writePlan, clearCache } from './cache';
import { RateLimitedError, SessionCapError, schedule } from './limiter';
import { TransitousError, geocode, plan, relaxOptions } from './transitous';
import type { PanelToWorker, WorkerReply } from '../shared/messages';
import {
  DEFAULT_COMMUTE_OPTIONS,
  DEFAULT_DISPLAY_SETTINGS,
  type CommuteError,
  type CommuteOptions,
  type CommuteResult,
  type Destination,
  type DisplaySettings,
} from '../shared/types';
import { resolveTarget } from '../shared/time';

/* --------------------------------- storage -------------------------------- */

async function getDestinations(): Promise<Destination[]> {
  const { destinations } = await chrome.storage.sync.get('destinations');
  return (destinations as Destination[]) ?? [];
}

async function setDestinations(destinations: Destination[]): Promise<void> {
  await chrome.storage.sync.set({ destinations });
}

async function getCommuteOptions(): Promise<CommuteOptions> {
  const { commuteOptions } = await chrome.storage.sync.get('commuteOptions');
  return { ...DEFAULT_COMMUTE_OPTIONS, ...((commuteOptions as Partial<CommuteOptions>) ?? {}) };
}

async function getSettings(): Promise<DisplaySettings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_DISPLAY_SETTINGS, ...((settings as Partial<DisplaySettings>) ?? {}) };
}

// Every field that changes the answer must be in the key, or switching mode or time
// would serve a stale result from the previous settings.
const optionsHash = (o: CommuteOptions) =>
  [
    o.travelMode,
    o.arriveBy ? 'a' : 'd',
    `${o.targetHour}:${o.targetMinute}`,
    o.maxWalkMeters,
    o.maxTransfers,
    o.maxTravelMinutes,
  ].join('/');

/* ------------------------------ bundled data ------------------------------ */

/**
 * Read here rather than in the page: the service worker can always read its own packaged
 * resources, with no web_accessible_resources entry and no exposure to daft.ie's CSP.
 * Cached in module scope so repeated map mounts do not re-read the files.
 */
let linesPromise: Promise<{ lines: unknown; stops: unknown }> | null = null;

function getLineData(): Promise<{ lines: unknown; stops: unknown }> {
  linesPromise ??= (async () => {
    const [lines, stops] = await Promise.all([
      fetch(chrome.runtime.getURL('data/dublin-rail-lines.json')).then((r) => r.json()),
      fetch(chrome.runtime.getURL('data/dublin-rail-stops.json')).then((r) => r.json()),
    ]);
    return { lines, stops };
  })();
  return linesPromise;
}

/* --------------------------------- routing -------------------------------- */

function toCommuteError(err: unknown): CommuteError {
  if (err instanceof SessionCapError) return { kind: 'session-cap' };
  if (err instanceof RateLimitedError) return { kind: 'rate-limited' };
  if (err instanceof TransitousError) {
    if (err.status === 429 || err.status === 503) return { kind: 'rate-limited' };
    // Transitous enforces client identification; a 403 means our User-Agent rule did
    // not apply, which is a configuration fault rather than a transient network error.
    if (err.status === 403) return { kind: 'blocked' };
    return { kind: 'network', detail: err.message };
  }
  return { kind: 'network', detail: (err as Error)?.message ?? 'unknown error' };
}

async function planForProperty(
  origin: [number, number]
): Promise<Array<CommuteResult | ({ destId: string } & { error: CommuteError })>> {
  const [destinations, options] = await Promise.all([getDestinations(), getCommuteOptions()]);
  const enabled = destinations.filter((d) => d.enabled);
  if (!enabled.length) return [];

  const target = resolveTarget(options);
  const hash = optionsHash(options);

  return Promise.all(
    enabled.map(async (dest) => {
      const key = planKey(origin, dest.id, hash, target.toISOString());

      // The relaxed probe is cached alongside the plan, so a repeat click on a property
      // that failed does not re-ask the routing service.
      const relaxedKey = `${key}|relaxed`;

      const emptyResult = async (): Promise<{ destId: string } & { error: CommuteError }> => {
        let probe = await readPlan(relaxedKey);
        if (!probe) {
          try {
            probe = await schedule(relaxedKey, () =>
              plan(origin, dest.lngLat, target, relaxOptions(options))
            );
            await writePlan(relaxedKey, probe);
          } catch {
            probe = []; // a failed diagnostic must not replace the real answer
          }
        }
        const best = probe[0];
        return best
          ? {
              destId: dest.id,
              error: { kind: 'outside-limits', minutes: best.totalMinutes, walkMinutes: best.walkMinutes },
            }
          : { destId: dest.id, error: { kind: 'no-route' } };
      };

      const cached = await readPlan(key);
      if (cached) {
        // An empty array is a cached "no route found", not a cache miss - returning it
        // as `itineraries: []` makes the panel skip the row silently.
        if (!cached.length) return emptyResult();
        return { destId: dest.id, itineraries: cached, fromCache: true };
      }

      try {
        const itineraries = await schedule(key, () =>
          plan(origin, dest.lngLat, target, options)
        );
        await writePlan(key, itineraries);
        if (!itineraries.length) return emptyResult();
        return { destId: dest.id, itineraries, fromCache: false };
      } catch (err) {
        return { destId: dest.id, error: toCommuteError(err) };
      }
    })
  );
}

/* -------------------------------- messaging ------------------------------- */

async function handle(message: PanelToWorker): Promise<WorkerReply> {
  switch (message.type) {
    case 'GET_STATE':
      return {
        ok: true,
        kind: 'state',
        destinations: await getDestinations(),
        settings: await getSettings(),
        commuteOptions: await getCommuteOptions(),
      };

    case 'GET_LINES': {
      const { lines, stops } = await getLineData();
      return { ok: true, kind: 'lines', lines, stops };
    }

    case 'PLAN':
      return {
        ok: true,
        kind: 'plan',
        results: await planForProperty([message.lng, message.lat]),
      };

    case 'GEOCODE': {
      try {
        const hits = await schedule(`geocode:${message.text}`, () => geocode(message.text));
        return { ok: true, kind: 'geocode', hits };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }

    case 'ADD_DESTINATION': {
      const destinations = await getDestinations();
      destinations.push(message.destination);
      await setDestinations(destinations);
      return { ok: true, kind: 'ack' };
    }

    case 'REMOVE_DESTINATION': {
      await setDestinations((await getDestinations()).filter((d) => d.id !== message.id));
      return { ok: true, kind: 'ack' };
    }

    case 'UPDATE_DESTINATION': {
      const destinations = (await getDestinations()).map((d) =>
        d.id === message.id ? { ...d, ...message.patch } : d
      );
      await setDestinations(destinations);
      return { ok: true, kind: 'ack' };
    }

    case 'SAVE_SETTINGS': {
      await chrome.storage.local.set({ settings: message.settings });
      return { ok: true, kind: 'ack' };
    }

    case 'SAVE_COMMUTE_OPTIONS': {
      await chrome.storage.sync.set({ commuteOptions: message.options });
      return { ok: true, kind: 'ack' };
    }

    // Backs the options page's "delete all my data" control.
    case 'WIPE_ALL': {
      await Promise.all([chrome.storage.sync.clear(), chrome.storage.local.clear(), clearCache()]);
      return { ok: true, kind: 'ack' };
    }

    default:
      return { ok: false, error: 'unknown message' };
  }
}

// A single listener: two would both call sendResponse and race for the one reply slot.
chrome.runtime.onMessage.addListener((message: PanelToWorker, _sender, sendResponse) => {
  handle(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: (err as Error).message } satisfies WorkerReply));
  return true; // async response
});
