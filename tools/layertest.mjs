#!/usr/bin/env node
/**
 * Exercises the map-integration logic against a recording stand-in for MapLibre.
 *
 * This cannot prove the extension works on daft.ie - only loading it in Chrome does that
 * (see README "Verifying"). What it does cover is the failure mode the spec calls the
 * real Phase 1 risk: layers being added twice, or not coming back after Daft calls
 * setStyle() and wipes every custom source and layer.
 */
import * as esbuild from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const work = await mkdtemp(path.join(tmpdir(), 'dpt-'));
const entry = path.join(work, 'entry.ts');
await writeFile(
  entry,
  `export * from ${JSON.stringify(path.join(root, 'extension/src/main-world/layers.ts').replace(/\\/g, '/'))};
   export * from ${JSON.stringify(path.join(root, 'extension/src/main-world/map-handle.ts').replace(/\\/g, '/'))};
   export * from ${JSON.stringify(path.join(root, 'extension/src/shared/layout.ts').replace(/\\/g, '/'))};
   export * from ${JSON.stringify(path.join(root, 'extension/src/shared/listing.ts').replace(/\\/g, '/'))};`
);
const outfile = path.join(work, 'bundle.mjs');
await esbuild.build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' });
const mod = await import(pathToFileURL(outfile).href);

/* ------------------------- a stand-in for MapLibre ------------------------ */

function fakeMap({ styleLoaded = true, withSymbolLayer = true } = {}) {
  const baseLayers = [
    { id: 'background', type: 'background' },
    { id: 'water', type: 'fill' },
    ...(withSymbolLayer
      ? [{ id: 'place-label', type: 'symbol', layout: { 'text-font': ['Noto Sans Regular'] } }]
      : []),
  ];
  const state = {
    layers: [...baseLayers],
    sources: new Map(),
    setDataCalls: [],
    filters: new Map(),
    paint: new Map(),
    layout: new Map(),
    insertions: [],
  };

  const map = {
    _state: state,
    isStyleLoaded: () => styleLoaded,
    getStyle: () => ({ layers: state.layers }),
    getSource(id) {
      if (!state.sources.has(id)) return undefined;
      return { setData: (data) => state.setDataCalls.push({ id, data }) };
    },
    addSource(id, spec) {
      if (state.sources.has(id)) throw new Error(`duplicate source: ${id}`);
      state.sources.set(id, spec);
    },
    getLayer: (id) => state.layers.find((l) => l.id === id),
    addLayer(spec, beforeId) {
      if (state.layers.some((l) => l.id === spec.id)) throw new Error(`duplicate layer: ${spec.id}`);
      state.insertions.push({ id: spec.id, beforeId });
      const at = beforeId ? state.layers.findIndex((l) => l.id === beforeId) : -1;
      if (at >= 0) state.layers.splice(at, 0, spec);
      else state.layers.push(spec);
    },
    setFilter: (id, filter) => state.filters.set(id, filter),
    setPaintProperty: (id, key, value) => state.paint.set(`${id}.${key}`, value),
    setLayoutProperty: (id, key, value) => state.layout.set(`${id}.${key}`, value),
    /** What Daft's setStyle() does to us: every custom source and layer disappears. */
    simulateSetStyle() {
      state.layers = [...baseLayers];
      state.sources.clear();
    },
  };
  return map;
}

const DATA = {
  lines: { type: 'FeatureCollection', features: [] },
  stops: { type: 'FeatureCollection', features: [] },
};
const SETTINGS = {
  visibleModes: ['luas', 'dart', 'commuter'],
  showStops: true,
  lineOpacity: 0.9,
  enabled: true,
};

const OURS = (map) => map._state.layers.filter((l) => l.id.startsWith('dpt-')).map((l) => l.id);

/* ---------------------------------- tests --------------------------------- */

console.log('\nLayer lifecycle');
{
  const map = fakeMap();
  mod.ensureLayers(map, DATA, SETTINGS);
  const first = OURS(map);
  check('adds our layers on first call', first.length >= 6, first.join(','));

  // addSource/addLayer throw on duplicates in the fake exactly as MapLibre does, so a
  // non-idempotent ensureLayers fails loudly here instead of silently in the browser.
  let threw = null;
  try {
    mod.ensureLayers(map, DATA, SETTINGS);
    mod.ensureLayers(map, DATA, SETTINGS);
  } catch (err) {
    threw = err.message;
  }
  check('is idempotent across repeated calls', threw === null, threw ?? '');
  check('layer count unchanged after re-calls', OURS(map).length === first.length, OURS(map).join(','));
  check('re-calls refresh data instead of re-adding sources', map._state.setDataCalls.length >= 2,
    `${map._state.setDataCalls.length} setData calls`);
}

console.log('\nSurviving setStyle()');
{
  const map = fakeMap();
  mod.ensureLayers(map, DATA, SETTINGS);
  const before = OURS(map).length;

  map.simulateSetStyle();
  check('setStyle wipes our layers (precondition)', OURS(map).length === 0);

  mod.ensureLayers(map, DATA, SETTINGS); // what the styledata handler does
  check('layers are restored after a restyle', OURS(map).length === before, OURS(map).join(','));
  // lines, stops, journey, destinations
  check('sources are restored too', map._state.sources.size === 4, `${map._state.sources.size}`);
}

console.log('\nInsertion order');
{
  const map = fakeMap();
  mod.ensureLayers(map, DATA, SETTINGS);
  const ids = map._state.layers.map((l) => l.id);
  check('lines sit below the first symbol layer (under labels)',
    ids.indexOf('dpt-lines-core') < ids.indexOf('place-label'), ids.join(' '));
  check('every insertion targets the symbol layer',
    map._state.insertions.every((i) => i.beforeId === 'place-label'));

  const noSymbols = fakeMap({ withSymbolLayer: false });
  mod.ensureLayers(noSymbols, DATA, SETTINGS);
  check('a style with no symbol layer still works (appends)', OURS(noSymbols).length >= 5);
  check('label layer is skipped when no fontstack exists',
    !OURS(noSymbols).includes('dpt-stops-label'), OURS(noSymbols).join(','));
}

console.log('\nUnloaded style');
{
  const map = fakeMap({ styleLoaded: false });
  mod.ensureLayers(map, DATA, SETTINGS);
  check('does nothing until the style is loaded', OURS(map).length === 0);
}

console.log('\nSettings');
{
  const map = fakeMap();
  mod.ensureLayers(map, DATA, SETTINGS);
  mod.applySettings(map, { ...SETTINGS, visibleModes: ['luas'] });
  const filter = JSON.stringify(map._state.filters.get('dpt-lines-core'));
  check('mode toggle reaches the line filter', filter.includes('luas') && !filter.includes('dart'), filter);

  const stopFilter = JSON.stringify(map._state.filters.get('dpt-stops-circle'));
  check('rail stops hidden when only Luas is on', stopFilter.includes('luas') && !stopFilter.includes('rail'), stopFilter);

  mod.applySettings(map, { ...SETTINGS, enabled: false });
  check('master switch hides the lines', map._state.layout.get('dpt-lines-core.visibility') === 'none');

  mod.applySettings(map, { ...SETTINGS, showStops: false });
  check('stops toggle hides stop circles', map._state.layout.get('dpt-stops-circle.visibility') === 'none');
}

console.log('\nJourney rendering');
{
  const itinerary = {
    totalMinutes: 39,
    walkMinutes: 18,
    transfers: 0,
    startTime: '2026-08-13T07:13:00Z',
    endTime: '2026-08-13T07:52:00Z',
    legs: [
      { mode: 'WALK', minutes: 10, coords: [[-6.24, 53.287], [-6.245, 53.29]] },
      { mode: 'TRAM', routeName: 'Green', minutes: 21, coords: [[-6.245, 53.29], [-6.26, 53.34]] },
      { mode: 'WALK', minutes: 8, coords: [[-6.26, 53.34], [-6.2546, 53.3438]] },
    ],
  };
  const fc = mod.journeyToGeoJson(itinerary, '#2f6f8f');
  const kinds = fc.features.map((f) => f.properties.kind);
  check('walk legs render as walk', kinds.filter((k) => k === 'walk').length === 2, kinds.join(','));
  check('transit leg renders as transit', kinds.filter((k) => k === 'transit').length === 1);
  check('both endpoints are marked', kinds.filter((k) => k === 'endpoint').length === 2);

  const start = fc.features.find((f) => f.properties.kind === 'endpoint');
  check('start endpoint is at the property', Math.abs(start.geometry.coordinates[1] - 53.287) < 1e-6,
    JSON.stringify(start.geometry.coordinates));

  const empty = mod.journeyToGeoJson(null, '#000');
  check('clearing yields an empty collection', empty.features.length === 0);

  // A leg with no geometry must be skipped, not emitted as a degenerate line.
  const partial = mod.journeyToGeoJson(
    { ...itinerary, legs: [{ mode: 'WALK', minutes: 3, coords: [] }, itinerary.legs[1]] },
    '#000'
  );
  check('legs without geometry are skipped', partial.features.filter((f) => f.properties.kind !== 'endpoint').length === 1);
}

console.log('\nA drawn route outlives the map it was drawn on');
{
  // Models main-world's refresh() — what runs on attach, 'load' and 'styledata'.
  // The detail page makes this load-bearing: its commute is computed from the page's own
  // data, so the route routinely exists before the lazy-mounted map does, and redrawing on
  // attach is the only thing that ever puts it on screen. ensureLayers re-adds the journey
  // source *empty*, so holding the itinerary and pushing it afterwards is the whole trick.
  const itinerary = {
    totalMinutes: 39, walkMinutes: 18, transfers: 0,
    startTime: '2026-08-13T07:13:00Z', endTime: '2026-08-13T07:52:00Z',
    legs: [
      { mode: 'WALK', minutes: 10, coords: [[-6.24, 53.287], [-6.245, 53.29]] },
      { mode: 'TRAM', routeName: 'Green', minutes: 21, coords: [[-6.245, 53.29], [-6.26, 53.34]] },
    ],
  };

  const map = fakeMap();
  let journey = { itinerary: null, color: '#000000' };
  const refresh = () => {
    mod.ensureLayers(map, DATA, SETTINGS);
    mod.setJourney(map, journey.itinerary, journey.color);
  };
  const drawn = () => {
    const last = map._state.setDataCalls.at(-1);
    return last?.id === 'dpt-journey' && last.data.features.length > 0;
  };

  refresh();
  check('a map that attaches before any route draws nothing', !drawn());

  journey = { itinerary, color: '#2f6f8f' }; // HIGHLIGHT_ROUTE arrives
  mod.setJourney(map, journey.itinerary, journey.color);
  check('the route is drawn when it arrives', drawn());

  map.simulateSetStyle();
  refresh();
  check('and comes back after Daft restyles the map', drawn(),
    'ensureLayers re-adds dpt-journey empty; the held itinerary is what restores it');

  // The other half: a fresh map (detail page scrolled into view) must show it too.
  const late = fakeMap();
  mod.ensureLayers(late, DATA, SETTINGS);
  mod.setJourney(late, journey.itinerary, journey.color);
  const shown = late._state.setDataCalls.at(-1);
  check('a map mounted after the fact shows the route immediately',
    shown.id === 'dpt-journey' && shown.data.features.length > 0);

  // And the reverse order, which the detail page hits routinely: the map attaches, a route
  // is calculated, and only then does the line bundle arrive from the service worker.
  // Nothing exists to draw into until it does, so LINES_DATA has to redraw, not just add.
  const early = fakeMap();
  let bundle = null;
  const earlyRefresh = () => {
    if (bundle) mod.ensureLayers(early, bundle, SETTINGS);
    mod.setJourney(early, journey.itinerary, journey.color);
  };
  earlyRefresh();
  check('with no line bundle yet there is nothing to draw into',
    early._state.setDataCalls.length === 0);

  bundle = DATA; // LINES_DATA arrives
  earlyRefresh();
  const painted = early._state.setDataCalls.at(-1);
  check('the route is painted once the layers exist',
    painted?.id === 'dpt-journey' && painted.data.features.length > 0,
    'LINES_DATA must redraw the journey, not only call ensureLayers');
}

console.log('\nFiber walk');
{
  // Mirrors the shape found on daft.ie: the map hides in a hook's memoizedState, two
  // fiber hops above the container element.
  const map = { getCenter: () => ({ lng: 0, lat: 0 }), addSource() {}, unproject: () => ({ lng: 0, lat: 0 }), transform: {} };
  const container = { style: {} };
  const grandparent = { memoizedState: { memoizedState: null, next: { memoizedState: { current: map }, next: null } }, return: null };
  const parent = { memoizedState: null, stateNode: null, memoizedProps: {}, return: grandparent };
  container['__reactFiber$abc123'] = { memoizedState: null, stateNode: container, memoizedProps: {}, return: parent };

  check('finds the map through the hook chain', mod.findMapInstance(container) === map);

  const noFiber = { style: {} };
  check('returns null with no fiber (not a crash)', mod.findMapInstance(noFiber) === null);

  // Getters that throw are common on React internals and must not abort the search.
  const hostile = { style: {} };
  const trap = {};
  Object.defineProperty(trap, 'boom', { get() { throw new Error('nope'); }, enumerable: true });
  hostile['__reactFiber$x'] = { memoizedState: null, stateNode: trap, memoizedProps: { map }, return: null };
  check('survives throwing getters and still finds the map', mod.findMapInstance(hostile) === map);
}

console.log('\nImplausible-itinerary filter');
{
  // Verbatim shape of what the live Luas Green feed returned on 2026-08-13: a tram
  // covering Balally -> city centre in zero minutes, which made an ~39 min journey look
  // like 18. Sorting by duration puts the corrupt one first, so it must be dropped.
  const corrupt = {
    duration: 1080,
    startTime: '2026-08-13T07:05:00Z',
    endTime: '2026-08-13T07:23:00Z',
    legs: [
      { mode: 'WALK', duration: 600, startTime: '2026-08-13T07:05:00Z', endTime: '2026-08-13T07:15:00Z', from: { name: 'START' }, to: { name: 'Balally' } },
      { mode: 'TRAM', routeShortName: 'Green', duration: 0, startTime: '2026-08-13T07:15:00Z', endTime: '2026-08-13T07:15:00Z', from: { name: 'Balally' }, to: { name: 'St Stephen’s Green' } },
      { mode: 'WALK', duration: 480, startTime: '2026-08-13T07:15:00Z', endTime: '2026-08-13T07:23:00Z', from: { name: 'St Stephen’s Green' }, to: { name: 'END' } },
    ],
  };
  const good = {
    duration: 2340,
    startTime: '2026-08-13T07:10:00Z',
    endTime: '2026-08-13T07:49:00Z',
    legs: [
      { mode: 'WALK', duration: 600, startTime: '2026-08-13T07:10:00Z', endTime: '2026-08-13T07:20:00Z', from: { name: 'START' }, to: { name: 'Balally' } },
      { mode: 'TRAM', routeShortName: 'Green', duration: 1260, startTime: '2026-08-13T07:20:00Z', endTime: '2026-08-13T07:41:00Z', from: { name: 'Balally' }, to: { name: 'St Stephen’s Green' } },
      { mode: 'WALK', duration: 480, startTime: '2026-08-13T07:41:00Z', endTime: '2026-08-13T07:49:00Z', from: { name: 'St Stephen’s Green' }, to: { name: 'END' } },
    ],
  };
  // A zero-length transit leg between the *same* named place is a legitimate artefact.
  const sameStop = {
    duration: 600,
    startTime: '2026-08-13T07:10:00Z',
    endTime: '2026-08-13T07:20:00Z',
    legs: [
      { mode: 'TRAM', duration: 0, startTime: '2026-08-13T07:10:00Z', endTime: '2026-08-13T07:10:00Z', from: { name: 'Balally' }, to: { name: 'Balally' } },
      { mode: 'TRAM', duration: 600, startTime: '2026-08-13T07:10:00Z', endTime: '2026-08-13T07:20:00Z', from: { name: 'Balally' }, to: { name: 'Windy Arbour' } },
    ],
  };
  const zeroWalk = {
    duration: 600,
    startTime: '2026-08-13T07:10:00Z',
    endTime: '2026-08-13T07:20:00Z',
    legs: [
      { mode: 'WALK', duration: 0, startTime: '2026-08-13T07:10:00Z', endTime: '2026-08-13T07:10:00Z', from: { name: 'Platform 1' }, to: { name: 'Platform 2' } },
      { mode: 'TRAM', duration: 600, startTime: '2026-08-13T07:10:00Z', endTime: '2026-08-13T07:20:00Z', from: { name: 'Balally' }, to: { name: 'Windy Arbour' } },
    ],
  };

  // Mirrors isPlausible() in transitous.ts (not exported - it is an internal detail).
  const plausible = (it) => !it.legs.some((leg) => {
    if (leg.mode === 'WALK') return false;
    const s = leg.duration ?? (new Date(leg.endTime) - new Date(leg.startTime)) / 1000;
    if (s > 0) return false;
    return !leg.from?.name || !leg.to?.name || leg.from.name !== leg.to.name;
  });

  check('drops the zero-duration tram between different stops', !plausible(corrupt));
  check('keeps the correct 39-minute journey', plausible(good));
  check('keeps a zero-length leg within the same stop', plausible(sameStop));
  check('keeps zero-length walking interchanges', plausible(zeroWalk));

  const survivors = [corrupt, good].filter(plausible);
  check('the surviving journey is the honest one',
    survivors.length === 1 && Math.round(survivors[0].duration / 60) === 39,
    `${survivors.length} kept`);
}

console.log('\nDestination pins');
{
  const DESTS = [
    { id: 'a', label: 'Work', lngLat: [-6.2546, 53.3438], color: '#2f6f8f', enabled: true },
    { id: 'b', label: 'Gym', lngLat: [-6.26, 53.35], color: '#b4531f', enabled: false },
  ];

  const fc = mod.destinationsToGeoJson(DESTS);
  check('enabled destinations become points', fc.features.length === 1, `${fc.features.length}`);
  check('disabled destinations are omitted', !fc.features.some((f) => f.properties.id === 'b'));
  check('coordinates are lng,lat ordered', fc.features[0].geometry.coordinates[0] === -6.2546);
  check('label and colour ride along',
    fc.features[0].properties.label === 'Work' && fc.features[0].properties.color === '#2f6f8f');

  const map = fakeMap();
  mod.ensureLayers(map, { ...DATA, destinations: fc }, SETTINGS);
  const ours = OURS(map);
  check('destination layers are created', ours.includes('dpt-dest-dot') && ours.includes('dpt-dest-halo'),
    ours.join(','));

  // The reported bug was the dot never appearing; ordering is why it would be invisible.
  check('destination dot draws above the journey line',
    ours.indexOf('dpt-dest-dot') > ours.indexOf('dpt-journey-transit'), ours.join(','));
  check('dot draws above its own halo',
    ours.indexOf('dpt-dest-dot') > ours.indexOf('dpt-dest-halo'));

  // Destinations are user data, not part of the transport overlay: the master switch
  // and the mode chips must not make them disappear.
  mod.applySettings(map, { ...SETTINGS, enabled: false, visibleModes: [] });
  check('master switch does not hide destinations',
    map._state.layout.get('dpt-dest-dot.visibility') === undefined,
    String(map._state.layout.get('dpt-dest-dot.visibility')));

  // Destinations can arrive before the line bundle; a null source would throw.
  const early = fakeMap();
  let threw = null;
  try {
    mod.ensureLayers(early, { lines: null, stops: null, destinations: fc }, SETTINGS);
  } catch (err) {
    threw = err.message;
  }
  check('destinations before the line bundle do not throw', threw === null, threw ?? '');
  check('pins still render in that case', OURS(early).includes('dpt-dest-dot'));

  mod.setDestinations(map, mod.destinationsToGeoJson([]));
  const last = map._state.setDataCalls.at(-1);
  check('clearing destinations pushes an empty collection',
    last.id === 'dpt-destinations' && last.data.features.length === 0);
}

console.log('\nMap-swap recovery (the search <-> detail navigation case)');
{
  // Regression test for a stranding bug: Next.js can remove the old map container and
  // insert the new one in a single commit. A check keyed only on "do we hold a map?"
  // sees a non-null (but dead) map plus a live container and never retries, so lines
  // never reappear after navigating. Keying on container identity is what fixes it.
  //
  // This models the decision, not the DOM - findMapInstance against a real Next.js
  // remount is only verifiable in a browser (see README "Verifying").
  const decide = (container, currentContainer, current) => {
    if (!container) return current ? 'lost' : 'idle';
    if (container !== currentContainer) return 'reattach';
    return current ? 'stay' : 'reattach';
  };

  const a = { id: 'container-a' };
  const b = { id: 'container-b' };
  const deadMap = { id: 'dead' };

  check('same container with a live map: no churn', decide(a, a, deadMap) === 'stay');
  check('container swapped under us: re-attach', decide(b, a, deadMap) === 'reattach',
    'this is the case the old code got wrong');
  check('container gone: report lost', decide(null, a, deadMap) === 'lost');
  check('no container and nothing held: idle', decide(null, null, null) === 'idle');
  check('first sight of a container: attach', decide(a, null, null) === 'reattach');
}

console.log('\nDetail-page listing detection');
{
  const id = mod.listingIdFromPath;

  check('a rental detail URL yields its id', id('/for-rent/flat-1-69-grove-park-rathmines-dublin-6/6640128') === '6640128');
  check('a sale detail URL yields its id', id('/for-sale/12-main-street-dublin-1/1234567') === '1234567');
  check('sharing and new-home sections count too',
    id('/share/a-room-dublin-2/7654321') === '7654321' && id('/new-home-for-sale/the-grange-dublin/999') === '999');
  check('a trailing slash is tolerated', id('/for-rent/somewhere-dublin/6640128/') === '6640128');
  check('a search page is not a detail page', id('/property-for-rent/dublin-city') === null);
  check('a section index is not a detail page', id('/for-rent/dublin') === null);

  // The gate. Both page-supplied sources go stale after a client-side navigation between
  // listings, and a stale one looks perfectly well-formed - only its id gives it away.
  const grovePark = { id: 6640128, title: 'Flat 1, 69 Grove Park', point: { type: 'Point', coordinates: [-6.267262, 53.329047] } };
  const castlewood = { id: 6634811, title: 'Castlewood Avenue', point: { type: 'Point', coordinates: [-6.263337, 53.322603] } };

  const hit = mod.readListing(grovePark, '6640128');
  check('a matching listing is accepted', hit !== null && hit.lng === -6.267262 && hit.lat === 53.329047,
    JSON.stringify(hit));
  check('its title comes through as the label', hit?.label === 'Flat 1, 69 Grove Park');
  check('the numeric id is compared as a string', mod.readListing({ ...grovePark, id: '6640128' }, '6640128') !== null);

  check('a stale payload for another listing is refused',
    mod.readListing(grovePark, '6634811') === null,
    'this is the wrong-property-commute bug the gate exists to prevent');

  check('nothing at all is refused', mod.readListing(null, '6640128') === null);
  check('a listing with no point is refused', mod.readListing({ id: 6640128 }, '6640128') === null);
  check('a half-built point is refused', mod.readListing({ id: 6640128, point: { coordinates: [-6.26] } }, '6640128') === null);
  check('string coordinates are refused',
    mod.readListing({ id: 6640128, point: { coordinates: ['-6.26', '53.32'] } }, '6640128') === null);
  check('out-of-range coordinates are refused',
    mod.readListing({ id: 6640128, point: { coordinates: [-6.26, 953.32] } }, '6640128') === null);
  check('a listing with no title still resolves, without a label',
    mod.readListing({ id: 6640128, point: { coordinates: [-6.26, 53.32] } }, '6640128')?.label === undefined);

  // Source order: router props first, __NEXT_DATA__ second. After an in-page navigation
  // the second is the stale one, and must not be allowed to answer for the first.
  check('the fresh source wins when the fallback is stale',
    mod.pickListing([castlewood, grovePark], '6634811')?.lng === -6.263337);
  check('a stale first source falls through to the fallback',
    mod.pickListing([grovePark, castlewood], '6634811')?.lng === -6.263337);
  check('both sources stale means no answer, not a guess',
    mod.pickListing([grovePark, grovePark], '6634811') === null);
  check('an empty candidate list is a miss', mod.pickListing([], '6634811') === null);
}

console.log('\nPanel drag bounds');
{
  const PANEL = { width: 330, height: 500 };
  const SCREEN = { width: 1280, height: 800 };
  const at = (l, t, panel = PANEL, screen = SCREEN) => mod.clampToViewport(l, t, panel, screen);

  check('an ordinary position is left alone', at(400, 200).left === 400 && at(400, 200).top === 200);

  // The failure that matters: dragging it off-screen with no way to get it back.
  const farRight = at(5000, 300);
  check('cannot be dragged off the right edge', farRight.left <= SCREEN.width - 56, `left=${farRight.left}`);
  const farLeft = at(-5000, 300);
  check('cannot be dragged off the left edge', farLeft.left >= 56 - PANEL.width, `left=${farLeft.left}`);
  check('at least 56px stays visible on the left', farLeft.left + PANEL.width >= 56);

  const farDown = at(300, 5000);
  check('cannot be dragged below the viewport', farDown.top <= SCREEN.height - 56, `top=${farDown.top}`);

  // The header is the only drag handle, so it must never go above the viewport.
  check('header cannot go above the top', at(300, -400).top === 0);

  // Resizing the window must pull a now-stranded panel back into reach.
  const stranded = at(1200, 700, PANEL, { width: 600, height: 400 });
  check('shrinking the window re-clamps into view',
    stranded.left <= 600 - 56 && stranded.top <= 400 - 56, JSON.stringify(stranded));

  check('results are whole pixels', Number.isInteger(at(300.4, 200.6).left));

  // A panel wider than the screen still has to be grabbable.
  const wide = at(-100, 10, { width: 2000, height: 400 }, { width: 500, height: 400 });
  check('a panel wider than the screen stays reachable', wide.left + 2000 >= 56 && wide.left <= 500 - 56,
    JSON.stringify(wide));
}

await rm(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
