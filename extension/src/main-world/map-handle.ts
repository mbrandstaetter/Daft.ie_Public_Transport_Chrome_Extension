/**
 * Recovering Daft's MapLibre instance.
 *
 * Daft bundles MapLibre GL JS (no `maplibregl` global) and renders it through React, so
 * the only handle is the one React holds. Walking the fiber from the `.maplibregl-map`
 * container finds it - verified live on 2026-08-12, two hops up, inside a hook's
 * memoizedState. This is the single most fragile assumption in the extension: it is
 * confined to this file so a bundle change has exactly one place to break.
 */

export interface MapLike {
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  addSource(id: string, spec: unknown): void;
  getSource(id: string): { setData?(data: unknown): void } | undefined;
  removeSource(id: string): void;
  addLayer(spec: unknown, beforeId?: string): void;
  getLayer(id: string): unknown;
  removeLayer(id: string): void;
  setPaintProperty(layer: string, name: string, value: unknown): void;
  setLayoutProperty(layer: string, name: string, value: unknown): void;
  setFilter(layer: string, filter: unknown): void;
  getStyle(): { layers: Array<{ id: string; type: string; layout?: Record<string, unknown> }> };
  isStyleLoaded(): boolean;
  on(event: string, layerOrHandler: unknown, handler?: unknown): void;
  off(event: string, layerOrHandler: unknown, handler?: unknown): void;
  unproject(point: [number, number]): { lng: number; lat: number };
  getCanvas(): HTMLCanvasElement;
  getContainer(): HTMLElement;
  transform: unknown;
}

function isMapLike(value: unknown): value is MapLike {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m['getCenter'] === 'function' &&
    typeof m['addSource'] === 'function' &&
    typeof m['unproject'] === 'function' &&
    m['transform'] != null
  );
}

function deepFind(value: unknown, depth: number, seen: WeakSet<object>): MapLike | null {
  if (depth < 0 || value == null) return null;
  const kind = typeof value;
  if (kind !== 'object' && kind !== 'function') return null;

  const obj = value as object;
  if (seen.has(obj)) return null;
  seen.add(obj);

  if (isMapLike(obj)) return obj;

  let keys: string[];
  try {
    keys = Object.keys(obj);
  } catch {
    return null;
  }
  for (const key of keys) {
    let child: unknown;
    try {
      child = (obj as Record<string, unknown>)[key];
    } catch {
      continue; // getters on React internals can throw
    }
    const found = deepFind(child, depth - 1, seen);
    if (found) return found;
  }
  return null;
}

export function findMapInstance(container: HTMLElement): MapLike | null {
  const fiberKey = Object.keys(container).find((k) => k.startsWith('__reactFiber'));
  if (!fiberKey) return null;

  let node = (container as unknown as Record<string, { [k: string]: unknown } | undefined>)[fiberKey];

  for (let hops = 0; node && hops < 60; hops++) {
    // A fresh `seen` per hop: deepFind marks objects visited even when it bailed on
    // depth, so a shared set could skip an object reachable more shallowly higher up.
    const seen = new WeakSet<object>();

    // Hooks are a linked list; the map ref is normally in one of them.
    let hook = node['memoizedState'] as { memoizedState?: unknown; next?: unknown } | undefined;
    for (let i = 0; hook && i < 40; i++) {
      const found = deepFind(hook.memoizedState, 4, seen);
      if (found) return found;
      hook = hook.next as typeof hook;
    }

    const fromState = deepFind(node['stateNode'], 3, seen);
    if (fromState) return fromState;

    const fromProps = deepFind(node['memoizedProps'], 3, seen);
    if (fromProps) return fromProps;

    node = node['return'] as typeof node;
  }
  return null;
}

/**
 * The pixel anchor of a Daft price pin, read off its inline transform.
 *
 * Markers look like:
 *   transform: translate(-50%,-100%) translate(618.039px, 281.703px) rotateX(0deg)...
 *
 * The first translate is the CSS anchor offset; the second is the projected position.
 * Feeding that through map.unproject() gives exact coordinates for any marker, including
 * ones loaded after a pan - which the SSR payload in __NEXT_DATA__ does not contain.
 */
export function markerPixel(marker: HTMLElement): [number, number] | null {
  const transform = marker.style.transform || '';
  const matches = [...transform.matchAll(/translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const x = Number(last[1]);
  const y = Number(last[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}
