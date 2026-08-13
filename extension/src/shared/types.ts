export type LineMode = 'luas' | 'dart' | 'commuter';
export type Surface = 'search' | 'detail';

export const ALL_MODES: LineMode[] = ['luas', 'dart', 'commuter'];

export const MODE_LABELS: Record<LineMode, string> = {
  luas: 'Luas',
  dart: 'DART',
  commuter: 'Commuter rail',
};

export interface Destination {
  id: string;
  label: string;
  address: string;
  lngLat: [number, number];
  color: string;
  enabled: boolean;
}

export type TravelMode = 'transit' | 'walk' | 'bike' | 'car';

export const TRAVEL_MODES: TravelMode[] = ['transit', 'walk', 'bike', 'car'];

export const TRAVEL_MODE_LABELS: Record<TravelMode, string> = {
  transit: 'Public transport',
  walk: 'Walk',
  bike: 'Cycle',
  car: 'Drive',
};

export const TRAVEL_MODE_SHORT: Record<TravelMode, string> = {
  transit: 'Transit',
  walk: 'Walk',
  bike: 'Cycle',
  car: 'Drive',
};

export interface CommuteOptions {
  /** Arrive-by answers "can I be at work by 9?"; depart-at answers a different question. */
  arriveBy: boolean;
  targetHour: number;
  targetMinute: number;
  /**
   * A specific Dublin-local date as `YYYY-MM-DD`, or null to track the next weekday.
   * Pinning it matters because timetables differ by day - a Saturday commute is not a
   * Tuesday one - and because it keeps results stable while comparing properties.
   */
  targetDate: string | null;
  travelMode: TravelMode;
  maxWalkMeters: number;
  maxTransfers: number;
  maxTravelMinutes: number;
}

export const DEFAULT_COMMUTE_OPTIONS: CommuteOptions = {
  arriveBy: true,
  targetHour: 9,
  targetMinute: 0,
  targetDate: null,
  travelMode: 'transit',
  maxWalkMeters: 1000,
  maxTransfers: 3,
  maxTravelMinutes: 120,
};

export interface DisplaySettings {
  visibleModes: LineMode[];
  showStops: boolean;
  lineOpacity: number;
  enabled: boolean;
  /** Plan and draw the route as soon as a property pin is clicked. */
  autoPlan: boolean;
  /** Where the user dragged the panel to, in viewport pixels. Null = default corner. */
  panelPos: { left: number; top: number } | null;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  visibleModes: [...ALL_MODES],
  showStops: true,
  lineOpacity: 0.9,
  enabled: true,
  autoPlan: true,
  panelPos: null,
};

export interface Leg {
  mode: string;
  routeName?: string;
  from?: string;
  to?: string;
  minutes: number;
  /** Decoded in the service worker so MAIN needs no polyline decoder. */
  coords: [number, number][];
}

export interface Itinerary {
  totalMinutes: number;
  walkMinutes: number;
  transfers: number;
  startTime: string;
  endTime: string;
  legs: Leg[];
}

export interface CommuteResult {
  destId: string;
  itineraries: Itinerary[];
  fromCache: boolean;
}

export type CommuteError =
  /** Nothing exists even with generously relaxed limits: the area has no useful service. */
  | { kind: 'no-route' }
  /**
   * A journey exists but falls outside the configured limits. Carries what it would
   * actually take, so the message can name the setting worth changing instead of
   * leaving the user to guess.
   */
  | { kind: 'outside-limits'; minutes: number; walkMinutes: number }
  | { kind: 'rate-limited' }
  | { kind: 'network'; detail: string }
  | { kind: 'session-cap' }
  /** Transitous rejected our client identification (HTTP 403) - see the UA rule. */
  | { kind: 'blocked' };

export interface GeocodeHit {
  label: string;
  lngLat: [number, number];
}
