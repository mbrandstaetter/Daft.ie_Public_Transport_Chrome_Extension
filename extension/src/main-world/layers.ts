import type { MapLike } from './map-handle';
import type { DisplaySettings, Itinerary, LineMode } from '../shared/types';

export const SRC_LINES = 'dpt-lines';
export const SRC_STOPS = 'dpt-stops';
export const SRC_JOURNEY = 'dpt-journey';
export const SRC_DESTINATIONS = 'dpt-destinations';

export const LAYER_DEST_HALO = 'dpt-dest-halo';
export const LAYER_DEST_DOT = 'dpt-dest-dot';
export const LAYER_DEST_LABEL = 'dpt-dest-label';

export const LAYER_LINES_CASING = 'dpt-lines-casing';
export const LAYER_LINES_CORE = 'dpt-lines-core';
export const LAYER_STOPS_CIRCLE = 'dpt-stops-circle';
export const LAYER_STOPS_LABEL = 'dpt-stops-label';
export const LAYER_JOURNEY_WALK = 'dpt-journey-walk';
export const LAYER_JOURNEY_TRANSIT = 'dpt-journey-transit';
export const LAYER_JOURNEY_ENDS = 'dpt-journey-ends';

const EMPTY = { type: 'FeatureCollection', features: [] as unknown[] };

export interface LineData {
  lines: unknown;
  stops: unknown;
  destinations?: unknown;
}

/** Saved destinations as map-ready points. Disabled ones are omitted, not greyed out. */
export function destinationsToGeoJson(
  destinations: Array<{ id: string; label: string; lngLat: [number, number]; color: string; enabled: boolean }>
): unknown {
  return {
    type: 'FeatureCollection',
    features: destinations
      .filter((d) => d.enabled)
      .map((d) => ({
        type: 'Feature',
        properties: { id: d.id, label: d.label, color: d.color },
        geometry: { type: 'Point', coordinates: d.lngLat },
      })),
  };
}

/** Our lines belong above the basemap but below place labels and Daft's own pins. */
function firstSymbolLayerId(map: MapLike): string | undefined {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
}

/**
 * Label glyphs come from Daft's MapTiler key, which only serves the fontstacks their
 * style already references. Inventing a name yields empty labels, so reuse one that is
 * demonstrably in use; if none is found the caller skips the label layer entirely.
 */
function existingFontStack(map: MapLike): string[] | null {
  for (const layer of map.getStyle().layers) {
    const font = layer.layout?.['text-font'];
    if (Array.isArray(font) && font.length && typeof font[0] === 'string') {
      return font as string[];
    }
  }
  return null;
}

const modeFilter = (modes: LineMode[]) => ['in', ['get', 'mode'], ['literal', modes]];

/**
 * Idempotent. Called on every styledata event because setStyle() silently drops every
 * custom source and layer, and Daft re-styles on its own schedule.
 */
export function ensureLayers(map: MapLike, data: LineData, settings: DisplaySettings): void {
  if (!map.isStyleLoaded()) return;

  const before = firstSymbolLayerId(map);

  // Destinations can arrive before the line bundle does, so neither may be assumed
  // present: MapLibre throws on a source with null data.
  const lines = data.lines ?? EMPTY;
  const stops = data.stops ?? EMPTY;

  if (!map.getSource(SRC_LINES)) {
    map.addSource(SRC_LINES, { type: 'geojson', data: lines });
  } else {
    map.getSource(SRC_LINES)?.setData?.(lines);
  }
  if (!map.getSource(SRC_STOPS)) {
    map.addSource(SRC_STOPS, { type: 'geojson', data: stops });
  } else {
    map.getSource(SRC_STOPS)?.setData?.(stops);
  }
  if (!map.getSource(SRC_JOURNEY)) {
    map.addSource(SRC_JOURNEY, { type: 'geojson', data: EMPTY });
  }
  if (!map.getSource(SRC_DESTINATIONS)) {
    map.addSource(SRC_DESTINATIONS, { type: 'geojson', data: data.destinations ?? EMPTY });
  } else {
    map.getSource(SRC_DESTINATIONS)?.setData?.(data.destinations ?? EMPTY);
  }

  if (!map.getLayer(LAYER_LINES_CASING)) {
    map.addLayer(
      {
        id: LAYER_LINES_CASING,
        type: 'line',
        source: SRC_LINES,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-opacity': 0.75,
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            9, 3.5,
            13, 6,
            16, 10,
          ],
        },
      },
      before
    );
  }

  if (!map.getLayer(LAYER_LINES_CORE)) {
    map.addLayer(
      {
        id: LAYER_LINES_CORE,
        type: 'line',
        source: SRC_LINES,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            9, 1.5,
            13, 3,
            16, 6,
          ],
        },
      },
      before
    );
  }

  if (!map.getLayer(LAYER_STOPS_CIRCLE)) {
    map.addLayer(
      {
        id: LAYER_STOPS_CIRCLE,
        type: 'circle',
        source: SRC_STOPS,
        minzoom: 11,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 14, 4.5, 17, 7],
          'circle-color': '#ffffff',
          'circle-stroke-color': '#33333a',
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 16, 2],
        },
      },
      before
    );
  }

  const fontStack = existingFontStack(map);
  if (fontStack && !map.getLayer(LAYER_STOPS_LABEL)) {
    map.addLayer(
      {
        id: LAYER_STOPS_LABEL,
        type: 'symbol',
        source: SRC_STOPS,
        minzoom: 13,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': fontStack,
          'text-size': 11,
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: {
          'text-color': '#2b2b33',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.4,
        },
      },
      before
    );
  }

  // Journey layers sit above the network so the chosen route reads on top of it.
  if (!map.getLayer(LAYER_JOURNEY_WALK)) {
    map.addLayer(
      {
        id: LAYER_JOURNEY_WALK,
        type: 'line',
        source: SRC_JOURNEY,
        filter: ['==', ['get', 'kind'], 'walk'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#4a4a55',
          'line-width': 3,
          'line-dasharray': [1, 1.8],
        },
      },
      before
    );
  }
  if (!map.getLayer(LAYER_JOURNEY_TRANSIT)) {
    map.addLayer(
      {
        id: LAYER_JOURNEY_TRANSIT,
        type: 'line',
        source: SRC_JOURNEY,
        filter: ['==', ['get', 'kind'], 'transit'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 5 },
      },
      before
    );
  }
  if (!map.getLayer(LAYER_JOURNEY_ENDS)) {
    map.addLayer(
      {
        id: LAYER_JOURNEY_ENDS,
        type: 'circle',
        source: SRC_JOURNEY,
        filter: ['==', ['get', 'kind'], 'endpoint'],
        paint: {
          'circle-radius': 6,
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      },
      before
    );
  }

  // Destinations go on last so they sit above the network and the journey line - they
  // are the fixed reference point the whole panel is about, and must never be buried.
  if (!map.getLayer(LAYER_DEST_HALO)) {
    map.addLayer(
      {
        id: LAYER_DEST_HALO,
        type: 'circle',
        source: SRC_DESTINATIONS,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 7, 14, 11, 17, 14],
          'circle-color': '#ffffff',
          'circle-opacity': 0.95,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': 2,
        },
      },
      before
    );
  }
  if (!map.getLayer(LAYER_DEST_DOT)) {
    map.addLayer(
      {
        id: LAYER_DEST_DOT,
        type: 'circle',
        source: SRC_DESTINATIONS,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 14, 5.5, 17, 7],
          'circle-color': ['get', 'color'],
        },
      },
      before
    );
  }
  if (fontStack && !map.getLayer(LAYER_DEST_LABEL)) {
    map.addLayer(
      {
        id: LAYER_DEST_LABEL,
        type: 'symbol',
        source: SRC_DESTINATIONS,
        minzoom: 10,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': fontStack,
          'text-size': 12,
          'text-offset': [0, 1.3],
          'text-anchor': 'top',
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.8,
        },
      },
      before
    );
  }

  applySettings(map, settings);
}

export function setDestinations(map: MapLike, geojson: unknown): void {
  map.getSource(SRC_DESTINATIONS)?.setData?.(geojson);
}

export function applySettings(map: MapLike, settings: DisplaySettings): void {
  const visible = settings.enabled;
  const show = (id: string, on: boolean) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  };

  show(LAYER_LINES_CASING, visible);
  show(LAYER_LINES_CORE, visible);
  show(LAYER_STOPS_CIRCLE, visible && settings.showStops);
  show(LAYER_STOPS_LABEL, visible && settings.showStops);

  if (map.getLayer(LAYER_LINES_CORE)) {
    map.setFilter(LAYER_LINES_CORE, modeFilter(settings.visibleModes));
    map.setPaintProperty(LAYER_LINES_CORE, 'line-opacity', settings.lineOpacity);
  }
  if (map.getLayer(LAYER_LINES_CASING)) {
    map.setFilter(LAYER_LINES_CASING, modeFilter(settings.visibleModes));
    map.setPaintProperty(LAYER_LINES_CASING, 'line-opacity', settings.lineOpacity * 0.8);
  }
  // Stops belong to the rail network as a whole; hide Luas stops when Luas is off.
  if (map.getLayer(LAYER_STOPS_CIRCLE)) {
    const stopModes: string[] = [];
    if (settings.visibleModes.includes('luas')) stopModes.push('luas');
    if (settings.visibleModes.includes('dart') || settings.visibleModes.includes('commuter')) {
      stopModes.push('rail');
    }
    const filter = ['in', ['get', 'mode'], ['literal', stopModes]];
    map.setFilter(LAYER_STOPS_CIRCLE, filter);
    if (map.getLayer(LAYER_STOPS_LABEL)) map.setFilter(LAYER_STOPS_LABEL, filter);
  }
}

/** Converts an itinerary into drawable features: dashed walks, solid coloured transit. */
export function journeyToGeoJson(itinerary: Itinerary | null, accent: string): unknown {
  if (!itinerary) return EMPTY;

  const features: unknown[] = [];
  for (const leg of itinerary.legs) {
    if (leg.coords.length < 2) continue;
    features.push({
      type: 'Feature',
      properties: {
        kind: leg.mode === 'WALK' ? 'walk' : 'transit',
        color: leg.mode === 'WALK' ? '#4a4a55' : accent,
      },
      geometry: { type: 'LineString', coordinates: leg.coords },
    });
  }

  const all = itinerary.legs.flatMap((l) => l.coords);
  const first = all[0];
  const last = all[all.length - 1];
  for (const point of [first, last]) {
    if (!point) continue;
    features.push({
      type: 'Feature',
      properties: { kind: 'endpoint', color: accent },
      geometry: { type: 'Point', coordinates: point },
    });
  }

  return { type: 'FeatureCollection', features };
}

export function setJourney(map: MapLike, itinerary: Itinerary | null, accent: string): void {
  map.getSource(SRC_JOURNEY)?.setData?.(journeyToGeoJson(itinerary, accent));
}
