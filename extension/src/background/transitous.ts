/**
 * Transitous (MOTIS) routing provider.
 *
 * Verified against the live server on 2026-08-12: Ireland is covered (stop ids are
 * `ie-transport-for-ireland_*`), and `arriveBy=true` is honoured - a request targeting
 * 08:00Z returned itineraries arriving 07:50/07:55/07:58Z rather than departing after it.
 *
 * The batch endpoints (`/api/v1/one-to-many`, `/api/experimental/one-to-many-intermodal`)
 * returned HTTP 400 across several parameter spellings, so this provider is deliberately
 * one-request-per-property. Re-test before building anything that needs a matrix.
 *
 * Transitous is a volunteer-run, best-effort service. The rate limiting in limiter.ts and
 * the cache in cache.ts are requirements of using it politely, not optimisations.
 */
import type { CommuteOptions, GeocodeHit, Itinerary, Leg } from '../shared/types';

const BASE = 'https://api.transitous.org/api';

export class TransitousError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/* --------------------------- polyline decoding ---------------------------- */

/**
 * Google encoded-polyline. MOTIS reports the precision it used (`precision` on the leg
 * geometry, typically 7 rather than the classic 5), so it must be passed in.
 */
export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  const factor = 10 ** precision;
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

/* --------------------------------- shapes --------------------------------- */

interface MotisLeg {
  mode: string;
  duration?: number;
  startTime: string;
  endTime: string;
  routeShortName?: string;
  headsign?: string;
  from?: { name?: string };
  to?: { name?: string };
  legGeometry?: { points?: string; precision?: number };
}

interface MotisItinerary {
  duration: number;
  startTime: string;
  endTime: string;
  transfers?: number;
  legs: MotisLeg[];
}

function toLeg(leg: MotisLeg): Leg {
  const seconds =
    leg.duration ?? (new Date(leg.endTime).getTime() - new Date(leg.startTime).getTime()) / 1000;
  return {
    mode: leg.mode,
    routeName: leg.routeShortName || undefined,
    from: leg.from?.name,
    to: leg.to?.name,
    minutes: Math.round(seconds / 60),
    coords: leg.legGeometry?.points
      ? decodePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? 5)
      : [],
  };
}

/**
 * Rejects itineraries containing a physically impossible transit leg: zero elapsed time
 * between two different places.
 *
 * This is not hypothetical. On 2026-08-13 the live Luas Green feed reported trams running
 * Balally -> city centre in 0 minutes (`07:15 -> 07:15`), which made MOTIS return an
 * 18-minute journey for one that genuinely takes about 39. Sorting by duration then puts
 * the corrupt result first, so the panel would confidently show the wrong number for a
 * decision as consequential as where to live.
 *
 * Deliberately narrow: it only catches legs that cannot be true under any timetable, not
 * legs that merely look fast. A leg that is implausibly *short* but non-zero still gets
 * through - detecting those would need a speed model this has no business inventing.
 */
function isPlausible(it: MotisItinerary): boolean {
  return !it.legs.some((leg) => {
    if (leg.mode === 'WALK') return false; // zero-length walks are normal at interchanges
    const seconds =
      leg.duration ?? (new Date(leg.endTime).getTime() - new Date(leg.startTime).getTime()) / 1000;
    if (seconds > 0) return false;
    const from = leg.from?.name;
    const to = leg.to?.name;
    return !from || !to || from !== to;
  });
}

function toItinerary(it: MotisItinerary): Itinerary {
  const legs = it.legs.map(toLeg);
  return {
    totalMinutes: Math.round(it.duration / 60),
    walkMinutes: legs.filter((l) => l.mode === 'WALK').reduce((s, l) => s + l.minutes, 0),
    transfers: it.transfers ?? Math.max(0, legs.filter((l) => l.mode !== 'WALK').length - 1),
    startTime: it.startTime,
    endTime: it.endTime,
    legs,
  };
}

/* ---------------------------------- calls --------------------------------- */

async function getJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new TransitousError(`network: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new TransitousError(`HTTP ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

const DIRECT_MODE: Record<Exclude<CommuteOptions['travelMode'], 'transit'>, string> = {
  walk: 'WALK',
  bike: 'BIKE',
  car: 'CAR',
};

/**
 * Transit journeys come back in `itineraries`; walk/bike/car come back in `direct`.
 *
 * Two parameters were established by testing the live server, and both are easy to get
 * wrong silently:
 *  - `maxDirectTime` must be set explicitly. Without it, walk and bike return an empty
 *    `direct` array (the default cutoff is far below a real commute), which reads as
 *    "no route" rather than "you didn't ask for a long enough one".
 *  - `transitModes=''` suppresses transit entirely. `transitModes=NONE` is rejected
 *    (`enum ModeEnum: unknown value NONE`), and omitting it makes the server compute a
 *    full transit plan we would then throw away.
 */
export async function plan(
  from: [number, number],
  to: [number, number],
  targetTime: Date,
  options: CommuteOptions
): Promise<Itinerary[]> {
  const params = new URLSearchParams({
    fromPlace: `${from[1]},${from[0]}`,
    toPlace: `${to[1]},${to[0]}`,
    time: targetTime.toISOString(),
    arriveBy: String(options.arriveBy),
  });

  const travelMode = options.travelMode;
  const isTransit = travelMode === 'transit';
  if (isTransit) {
    params.set('maxTransfers', String(options.maxTransfers));
    params.set('maxTravelTime', String(options.maxTravelMinutes));
    params.set('maxPreTransitTime', String(Math.round(options.maxWalkMeters / 1.4)));
  } else {
    params.set('directModes', DIRECT_MODE[travelMode]);
    params.set('transitModes', '');
    params.set('maxDirectTime', String(options.maxTravelMinutes * 60));
  }

  const body = await getJson<{ itineraries?: MotisItinerary[]; direct?: MotisItinerary[] }>(
    `${BASE}/v1/plan?${params}`
  );

  const raw = isTransit ? body.itineraries ?? [] : body.direct ?? [];
  const usable = raw.filter(isPlausible);
  const itineraries = usable.map(toItinerary);

  // MOTIS returns several departures for the same journey pattern; keep the fastest few.
  itineraries.sort((a, b) => a.totalMinutes - b.totalMinutes);
  return itineraries.slice(0, 3);
}

interface GeoArea {
  name?: string;
  adminLevel?: number;
  default?: boolean;
}

interface GeoHit {
  name?: string;
  lat?: number;
  lon?: number;
  areas?: GeoArea[];
}

const countryOf = (hit: GeoHit) => hit.areas?.find((a) => a.adminLevel === 2)?.name ?? '';

/**
 * The geocoder is worldwide and ranks purely on string similarity, so "Trinity College"
 * puts a Warwickshire match above the Dublin one and `place` biasing barely moves it.
 * Since this extension is for Irish property search, Irish hits are promoted and the
 * country is always shown so near-identical names stay distinguishable.
 */
/**
 * Limits used to work out *why* a lookup came back empty.
 *
 * "No route found" is technically true in both of the common cases but tells the user
 * nothing: a property 3 km from the nearest stop and a 2h10 commute against a 2h cap look
 * identical. Re-asking once with deliberately generous limits separates them - if a
 * journey appears, the limits were the constraint and we can say by how much; if nothing
 * appears, the area genuinely has no service.
 *
 * Only ever issued after a failure, and the outcome is cached, so this costs at most one
 * extra request per property/destination/settings combination.
 */
const RELAXED = { maxWalkMeters: 3000, maxTransfers: 4, maxTravelMinutes: 240 } as const;

export function relaxOptions(options: CommuteOptions): CommuteOptions {
  return { ...options, ...RELAXED };
}

export async function geocode(text: string): Promise<GeocodeHit[]> {
  const params = new URLSearchParams({
    text,
    language: 'en',
    place: '53.3498,-6.2603', // Dublin: a nudge, not a filter
  });
  const body = await getJson<GeoHit[]>(`${BASE}/v1/geocode?${params}`);

  const usable = body.filter((h) => typeof h.lat === 'number' && typeof h.lon === 'number');
  const irish = usable.filter((h) => countryOf(h) === 'Ireland');
  const rest = usable.filter((h) => countryOf(h) !== 'Ireland');

  return [...irish, ...rest].slice(0, 8).map((hit) => {
    const areas = hit.areas ?? [];
    // adminLevel 6/7 are county and town; the `default` area is the geocoder's own pick.
    const locality =
      areas.find((a) => a.default)?.name ??
      areas.find((a) => a.adminLevel === 7)?.name ??
      areas.find((a) => a.adminLevel === 6)?.name;
    const country = countryOf(hit);
    const parts = [hit.name, locality, country === 'Ireland' ? undefined : country];
    return {
      label: parts.filter(Boolean).join(', '),
      lngLat: [hit.lon as number, hit.lat as number] as [number, number],
    };
  });
}
