/**
 * ISOLATED-world content script.
 *
 * Two jobs: bridge window.postMessage (the only channel MAIN can use, since MAIN has no
 * chrome.* APIs) to chrome.runtime, and render the panel.
 */
import { PANEL_CSS } from './panel.css';
import { clampToViewport } from '../shared/layout';
import { listingIdFromPath } from '../shared/listing';
import {
  onMainMessage,
  postToMain,
  type MainToIsolated,
  type PanelToWorker,
  type WorkerReply,
} from '../shared/messages';
import {
  ALL_MODES,
  DEFAULT_COMMUTE_OPTIONS,
  DEFAULT_DISPLAY_SETTINGS,
  MODE_LABELS,
  TRAVEL_MODES,
  TRAVEL_MODE_LABELS,
  TRAVEL_MODE_SHORT,
  type CommuteError,
  type CommuteOptions,
  type CommuteResult,
  type Destination,
  type DisplaySettings,
  type GeocodeHit,
  type Itinerary,
  type LineMode,
} from '../shared/types';
import {
  dublinToday,
  formatDublinDate,
  formatDublinTime,
  formatDuration,
  resolveTarget,
} from '../shared/time';

const MODE_COLORS: Record<LineMode, string> = {
  luas: '#00A94F',
  dart: '#0F8C3B',
  commuter: '#4B2E83',
};

const DEST_PALETTE = ['#2f6f8f', '#b4531f', '#6b3fa0', '#1f7a5c', '#a03050'];

type PlanEntry = CommuteResult | ({ destId: string } & { error: CommuteError });

interface State {
  destinations: Destination[];
  settings: DisplaySettings;
  commuteOptions: CommuteOptions;
  mapReady: boolean;
  attachError: string | null;
  /** `auto` marks a detail page that selected itself, rather than a pin the user clicked. */
  selection: { listingId: string; lng: number; lat: number; priceLabel?: string; auto: boolean } | null;
  /** A detail page whose coordinates could not be read - see LISTING_CLEARED. */
  listingUnresolved: boolean;
  /** A detail page whose listing is still being resolved: an answer is coming, so wait. */
  listingPending: boolean;
  /** Settings are loaded. Until then an automatic selection cannot honour `autoPlan`. */
  booted: boolean;
  results: PlanEntry[] | null;
  loading: boolean;
  geocodeHits: GeocodeHit[];
  geocodeBusy: boolean;
  pendingAddress: string;
  activeItinerary: string | null;
  collapsed: boolean;
  lineInfo: { name: string; detail: string } | null;
  /** Set when the next render should scroll the commute answer into view. */
  revealResults: boolean;
}

const state: State = {
  destinations: [],
  settings: DEFAULT_DISPLAY_SETTINGS,
  commuteOptions: DEFAULT_COMMUTE_OPTIONS,
  mapReady: false,
  attachError: null,
  selection: null,
  listingUnresolved: false,
  // A detail page is going to select itself, so the panel starts out waiting rather than
  // telling the user to click a pin that this page does not have.
  listingPending: listingIdFromPath(location.pathname) !== null,
  booted: false,
  results: null,
  loading: false,
  geocodeHits: [],
  geocodeBusy: false,
  pendingAddress: '',
  activeItinerary: null,
  collapsed: false,
  lineInfo: null,
  revealResults: false,
};

const send = <T extends WorkerReply>(message: PanelToWorker): Promise<T> =>
  chrome.runtime.sendMessage(message) as Promise<T>;

/* ------------------------------- panel shell ------------------------------ */

const host = document.createElement('div');
host.id = 'dpt-root';
const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = PANEL_CSS;
const root = document.createElement('div');
root.className = 'panel';
shadow.append(style, root);

function mount(): void {
  if (!document.body.contains(host)) document.body.appendChild(host);
}

/* --------------------------------- dragging ------------------------------- */

function clampPosition(left: number, top: number): { left: number; top: number } {
  const rect = root.getBoundingClientRect();
  return clampToViewport(
    left,
    top,
    { width: rect.width, height: rect.height },
    { width: window.innerWidth, height: window.innerHeight }
  );
}

function applyPanelPosition(): void {
  const pos = state.settings.panelPos;
  if (!pos) {
    // Fall back to the CSS-defined corner rather than pinning equivalent coordinates.
    root.style.left = root.style.top = root.style.right = root.style.bottom = '';
    root.style.maxHeight = '';
    return;
  }
  root.style.left = `${pos.left}px`;
  root.style.top = `${pos.top}px`;
  root.style.right = 'auto';
  root.style.bottom = 'auto';

  // The stylesheet caps height against the viewport, which is correct only while the
  // panel is anchored to the bottom corner. Once it has a top, the same cap lets the
  // lower part - including the footer and the newest results - hang off the screen
  // where it cannot be reached. Fit it to the space actually below its top edge.
  const available = window.innerHeight - pos.top - 16;
  const cap = Math.min(640, window.innerHeight * 0.72);
  root.style.maxHeight = `${Math.max(220, Math.min(cap, available))}px`;
}

/**
 * Drag by the header. The same header still toggles collapse on click, so the two are
 * separated by distance travelled rather than by target: anything under a few pixels is
 * a click, anything beyond it is a drag. Without that, every drag would also collapse
 * the panel on release.
 */
const DRAG_THRESHOLD_PX = 4;

function bindDrag(header: HTMLElement): void {
  let origin: { x: number; y: number; left: number; top: number } | null = null;
  let moved = false;

  header.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = root.getBoundingClientRect();
    origin = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    moved = false;
    header.setPointerCapture(event.pointerId);
  });

  header.addEventListener('pointermove', (event) => {
    if (!origin) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;

    if (!moved) {
      moved = true;
      header.classList.add('dragging');
      root.classList.add('dragging');
    }
    // Positioned directly rather than through render(), so dragging stays smooth and
    // does not rebuild the DOM on every pointer event.
    const next = clampPosition(origin.left + dx, origin.top + dy);
    root.style.left = `${next.left}px`;
    root.style.top = `${next.top}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    event.preventDefault();
  });

  const finish = (event: PointerEvent) => {
    if (!origin) return;
    origin = null;
    header.classList.remove('dragging');
    root.classList.remove('dragging');
    if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId);

    if (moved) {
      const rect = root.getBoundingClientRect();
      void updateSettings({ panelPos: clampPosition(rect.left, rect.top) });
    } else {
      state.collapsed = !state.collapsed;
      render();
    }
  };

  header.addEventListener('pointerup', finish);
  header.addEventListener('pointercancel', finish);
}

// A window that shrinks below the panel's saved position must not strand it off-screen.
window.addEventListener('resize', () => {
  const pos = state.settings.panelPos;
  if (!pos) return;
  const clamped = clampPosition(pos.left, pos.top);
  if (clamped.left !== pos.left || clamped.top !== pos.top) {
    void updateSettings({ panelPos: clamped });
  } else {
    applyPanelPosition(); // height cap still depends on the viewport
  }
});

/* -------------------------------- rendering ------------------------------- */

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) node.className = className;
  Object.assign(node, rest);
  node.append(...children);
  return node;
};

/** Street modes have no route to name, so they read as plain verbs rather than badges. */
const STREET_VERB: Record<string, string> = {
  WALK: 'walk',
  BIKE: 'cycle',
  CAR: 'drive',
};

function legLine(itinerary: Itinerary): HTMLElement {
  const wrap = el('div', { class: 'legs' });
  const parts: Array<Node | string> = [];
  itinerary.legs.forEach((leg, i) => {
    if (i > 0) parts.push(' → ');
    const verb = STREET_VERB[leg.mode];
    if (verb) {
      parts.push(el('span', { class: 'seg' }, `${verb} ${leg.minutes} min`));
    } else {
      const badge = el('span', { class: 'route' }, leg.routeName ?? leg.mode);
      badge.style.background = transitColor(leg);
      parts.push(el('span', { class: 'seg' }, badge, ` ${leg.minutes} min`));
    }
  });
  wrap.append(...parts);
  return wrap;
}

function transitColor(leg: { mode: string; routeName?: string }): string {
  const name = (leg.routeName ?? '').toLowerCase();
  if (name.includes('green')) return MODE_COLORS.luas;
  if (name.includes('red')) return '#E5292A';
  if (name === 'dart') return MODE_COLORS.dart;
  if (leg.mode === 'TRAM' || leg.mode === 'SUBWAY') return MODE_COLORS.luas;
  if (leg.mode === 'BUS') return '#1d5fa8';
  return MODE_COLORS.commuter;
}

function errorText(error: CommuteError): string {
  const mode = TRAVEL_MODE_SHORT[state.commuteOptions.travelMode].toLowerCase();
  switch (error.kind) {
    case 'no-route':
      return state.commuteOptions.travelMode === 'transit'
        ? 'No public transport serves this property — there is no stop within reasonable walking distance.'
        : `No ${mode} route exists between these points.`;
    case 'outside-limits': {
      const { minutes, walkMinutes } = error;
      const detail =
        state.commuteOptions.travelMode === 'transit' && walkMinutes > state.commuteOptions.maxWalkMeters / 80
          ? `about ${formatDuration(minutes)}, including ${Math.round(walkMinutes)} min walking`
          : `about ${formatDuration(minutes)}`;
      return `Outside your limits — it would take ${detail}. Raise the walking distance or journey time in options.`;
    }
    case 'rate-limited':
      return 'Routing service is busy — pausing briefly. Try again in a moment.';
    case 'session-cap':
      return 'Reached this session’s lookup limit, to stay within the free service’s fair use.';
    case 'blocked':
      return 'The routing service rejected this client. The extension’s User-Agent rule is not being applied — see the README.';
    case 'network':
      return `Could not reach the routing service (${error.detail}).`;
  }
}

function renderModes(): HTMLElement {
  const wrap = el('div', { class: 'modes' });
  for (const mode of ALL_MODES) {
    const on = state.settings.visibleModes.includes(mode);
    const chip = el('button', { class: `chip${on ? ' on' : ''}` });
    if (on) chip.style.background = MODE_COLORS[mode];
    const dot = el('span', { class: 'dot' });
    if (!on) dot.style.background = MODE_COLORS[mode];
    chip.append(dot, MODE_LABELS[mode]);
    chip.onclick = () => {
      const modes = on
        ? state.settings.visibleModes.filter((m) => m !== mode)
        : [...state.settings.visibleModes, mode];
      updateSettings({ visibleModes: modes });
    };
    wrap.append(chip);
  }
  return wrap;
}

function renderDestinations(): HTMLElement {
  const section = el('section');
  section.append(el('h2', {}, 'Destinations'));

  if (!state.destinations.length) {
    section.append(el('div', { class: 'muted' }, 'Add a place you commute to, then click any property pin.'));
  }

  for (const dest of state.destinations) {
    const row = el('div', { class: 'dest' });
    const swatch = el('span', { class: 'swatch' });
    swatch.style.background = dest.color;

    const meta = el('div', { class: 'meta' }, el('b', {}, dest.label), el('span', {}, dest.address));

    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = dest.enabled;
    toggle.title = 'Include in commute lookups';
    toggle.onchange = async () => {
      await send({ type: 'UPDATE_DESTINATION', id: dest.id, patch: { enabled: toggle.checked } });
      await refreshState();
      pushDestinations();
      if (state.selection && state.settings.autoPlan) requestPlan();
      else render();
    };

    const remove = el('button', { class: 'x', title: 'Remove' }, '×');
    remove.onclick = async () => {
      await send({ type: 'REMOVE_DESTINATION', id: dest.id });
      await refreshState();
      pushDestinations();
      render();
    };

    row.append(swatch, meta, toggle, remove);
    section.append(row);
  }

  const input = el('input');
  input.type = 'text';
  input.placeholder = 'Add an address or station…';
  input.value = state.pendingAddress;
  input.oninput = () => {
    state.pendingAddress = input.value;
  };
  input.onkeydown = (event) => {
    if ((event as KeyboardEvent).key === 'Enter') void runGeocode();
  };

  const search = el('button', { class: 'btn ghost' }, state.geocodeBusy ? 'Searching…' : 'Search');
  search.disabled = state.geocodeBusy;
  search.onclick = () => void runGeocode();

  section.append(input, el('div', { class: 'row' }, search));

  if (state.geocodeHits.length) {
    const hits = el('div', { class: 'hits' });
    for (const hit of state.geocodeHits) {
      const button = el('button', {}, hit.label);
      button.onclick = () => void addDestination(hit);
      hits.append(button);
    }
    section.append(hits);
  }
  return section;
}

/**
 * When and how the commute is measured. This lives in the panel rather than the options
 * page because it is what you change while comparing properties, not once at setup.
 */
function renderCommuteControls(): HTMLElement {
  const section = el('section');
  section.append(el('h2', {}, 'How you travel'));

  const modes = el('div', { class: 'modes' });
  for (const mode of TRAVEL_MODES) {
    const on = state.commuteOptions.travelMode === mode;
    const chip = el('button', { class: `chip${on ? ' on' : ''}`, title: TRAVEL_MODE_LABELS[mode] });
    if (on) chip.style.background = '#12303f';
    chip.append(TRAVEL_MODE_SHORT[mode]);
    chip.onclick = () => void updateCommuteOptions({ travelMode: mode });
    modes.append(chip);
  }
  section.append(modes);

  section.append(el('h2', {}, 'When'));

  const when = el('div', { class: 'row' });

  const direction = el('select');
  for (const [value, label] of [['true', 'Arrive by'], ['false', 'Depart at']] as const) {
    const option = el('option', { value }, label);
    option.selected = String(state.commuteOptions.arriveBy) === value;
    direction.append(option);
  }
  direction.onchange = () => void updateCommuteOptions({ arriveBy: direction.value === 'true' });

  const time = el('input');
  time.type = 'time';
  time.step = '300';
  time.value = `${String(state.commuteOptions.targetHour).padStart(2, '0')}:${String(
    state.commuteOptions.targetMinute
  ).padStart(2, '0')}`;
  time.onchange = () => {
    const [h, m] = time.value.split(':').map(Number);
    if (Number.isFinite(h) && Number.isFinite(m)) {
      void updateCommuteOptions({ targetHour: h as number, targetMinute: m as number });
    }
  };

  when.append(direction, time);
  section.append(when);

  const dateRow = el('div', { class: 'row' });
  const date = el('input');
  date.type = 'date';
  date.min = dublinToday();
  date.value = state.commuteOptions.targetDate ?? '';
  date.onchange = () => void updateCommuteOptions({ targetDate: date.value || null });

  const auto = el('button', { class: 'btn ghost', title: 'Track the next weekday automatically' }, 'Next weekday');
  auto.disabled = state.commuteOptions.targetDate === null;
  auto.onclick = () => void updateCommuteOptions({ targetDate: null });

  dateRow.append(date, auto);
  section.append(dateRow);

  if (!state.commuteOptions.targetDate) {
    section.append(
      el('div', { class: 'muted' }, `Using the next weekday: ${formatDublinDate(resolveTarget(state.commuteOptions))}.`)
    );
  }

  const autoRow = el('div', { class: 'row' });
  const autoPlan = el('input');
  autoPlan.type = 'checkbox';
  autoPlan.checked = state.settings.autoPlan;
  autoPlan.onchange = () => void updateSettings({ autoPlan: autoPlan.checked });
  autoRow.append(el('label', {}, 'Calculate automatically on click'), autoPlan);
  section.append(autoRow);

  return section;
}

function renderResults(): HTMLElement {
  const section = el('section');
  const { targetHour, targetMinute, arriveBy, travelMode } = state.commuteOptions;
  const target = resolveTarget(state.commuteOptions);
  const clock = `${String(targetHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')}`;
  section.append(
    el(
      'h2',
      {},
      `${TRAVEL_MODE_SHORT[travelMode]} — ${arriveBy ? 'arrive by' : 'depart'} ${clock}, ${formatDublinDate(target)}`
    )
  );

  if (!state.selection) {
    section.append(
      el(
        'div',
        { class: 'muted' },
        state.listingUnresolved
          ? 'Couldn’t read this listing’s location from the page — Daft’s page data may have changed shape.'
          : state.listingPending
            ? 'Reading this listing…'
            : 'Click a property pin on the map to see its commute.'
      )
    );
    return section;
  }
  if (!state.destinations.some((d) => d.enabled)) {
    section.append(el('div', { class: 'muted' }, 'Enable at least one destination above.'));
    return section;
  }

  // With auto-calculate off, selecting a property does not start the lookup - on a detail
  // page that means the button is simply waiting, with nothing to click on the map first.
  if (!state.loading && state.results === null) {
    const what = state.selection.priceLabel ?? 'this property';
    const button = el('button', { class: 'btn' }, 'Calculate commute');
    button.onclick = () => requestPlan();
    section.append(
      el('div', { class: 'muted' }, state.selection.auto ? `This listing: ${what}.` : `Selected ${what}.`),
      button
    );
    return section;
  }

  if (state.loading) {
    section.append(el('div', { class: 'spinner' }, 'Planning journeys…'));
    return section;
  }

  for (const entry of state.results ?? []) {
    const dest = state.destinations.find((d) => d.id === entry.destId);
    if (!dest) continue;

    if ('error' in entry) {
      section.append(el('div', { class: 'err' }, `${dest.label}: ${errorText(entry.error)}`));
      continue;
    }

    const best = entry.itineraries[0];
    if (!best) continue;

    const card = el('div', { class: `result${state.activeItinerary === dest.id ? ' active' : ''}` });
    const time = el('span', { class: 'time' }, formatDuration(best.totalMinutes));
    time.style.color = dest.color;

    card.append(
      el(
        'div',
        { class: 'head' },
        el('b', {}, dest.label),
        time,
        el('span', { class: 'arrive' }, `arr ${formatDublinTime(best.endTime)}`)
      ),
      legLine(best)
    );
    card.onclick = () => {
      const next = state.activeItinerary === dest.id ? null : dest.id;
      state.activeItinerary = next;
      postToMain({
        type: 'HIGHLIGHT_ROUTE',
        itinerary: next ? best : null,
        color: dest.color,
      });
      render();
    };
    section.append(card);
  }
  return section;
}

function render(): void {
  mount();

  // render() rebuilds the whole subtree, which destroys the scrolling element - a fresh
  // one starts at scrollTop 0. Without carrying it over, every re-render (including the
  // one when commute results arrive) yanks the panel back to the top.
  const previousScroll = shadow.querySelector('.body')?.scrollTop ?? 0;

  root.className = `panel${state.collapsed ? ' collapsed' : ''}`;
  root.replaceChildren();

  const header = el('header');
  header.append(
    el('span', { class: 'grip', title: 'Drag to move' }, '⠿'),
    el('h1', {}, 'Dublin Commute Overlay'),
    el('span', { class: 'chev' }, state.collapsed ? '▲' : '▼')
  );
  bindDrag(header);

  const body = el('div', { class: 'body' });

  if (state.attachError) {
    body.append(el('div', { class: 'warn' }, `Couldn’t attach to Daft’s map. ${state.attachError}`));
  } else if (!state.mapReady) {
    // A detail page's commute is computed from the page's own data, so the answer below
    // is already valid; only the drawing of it is waiting on the lazy-mounted map.
    body.append(
      el(
        'div',
        { class: 'muted' },
        state.selection?.auto
          ? 'Scroll down to Daft’s map to see this journey drawn on it.'
          : 'Waiting for the map… open the map view or scroll to it.'
      )
    );
  }

  const linesSection = el('section');
  linesSection.append(el('h2', {}, 'Transport lines'), renderModes());

  const stopsRow = el('div', { class: 'row' });
  const stopsToggle = el('input');
  stopsToggle.type = 'checkbox';
  stopsToggle.checked = state.settings.showStops;
  stopsToggle.onchange = () => updateSettings({ showStops: stopsToggle.checked });
  stopsRow.append(el('label', {}, 'Show stops and stations'), stopsToggle);
  linesSection.append(stopsRow);

  if (state.lineInfo) {
    linesSection.append(
      el('div', { class: 'muted' }, `${state.lineInfo.name} — ${state.lineInfo.detail}`)
    );
  }

  const resultsSection = renderResults();
  body.append(linesSection, renderDestinations(), renderCommuteControls(), resultsSection);

  const footer = el('footer');
  footer.append(
    'Routing by ',
    el('a', { href: 'https://transitous.org/', target: '_blank', rel: 'noreferrer' }, 'Transitous'),
    ' (',
    el('a', { href: 'https://transitous.org/sources/', target: '_blank', rel: 'noreferrer' }, 'sources'),
    '). Lines from NTA/TFI GTFS via ',
    el('a', { href: 'https://data.gov.ie/', target: '_blank', rel: 'noreferrer' }, 'data.gov.ie'),
    ' (CC-BY 4.0). Map data © ',
    el('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noreferrer' }, 'OpenStreetMap'),
    ' contributors.'
  );

  root.append(header, body, footer);
  applyPanelPosition();

  // Scroll positions can only be set once the element is laid out in the document.
  if (state.revealResults) {
    state.revealResults = false;
    // Bring the answer into view instead of making the user hunt for it below the
    // lines and destination sections. offsetTop is relative to the scrolling parent.
    body.scrollTop = Math.max(0, resultsSection.offsetTop - 8);
  } else {
    body.scrollTop = previousScroll;
  }
}

/* --------------------------------- actions -------------------------------- */

async function updateSettings(patch: Partial<DisplaySettings>): Promise<void> {
  state.settings = { ...state.settings, ...patch };
  await send({ type: 'SAVE_SETTINGS', settings: state.settings });
  postToMain({ type: 'SETTINGS_CHANGED', settings: state.settings });
  render();
}

/**
 * Commute settings change the answer, so any result on screen is now stale. Re-plan when
 * a property is selected rather than leaving numbers that no longer match the controls.
 */
async function updateCommuteOptions(patch: Partial<CommuteOptions>): Promise<void> {
  state.commuteOptions = { ...state.commuteOptions, ...patch };
  await send({ type: 'SAVE_COMMUTE_OPTIONS', options: state.commuteOptions });
  state.results = null;
  state.activeItinerary = null;
  postToMain({ type: 'CLEAR_SELECTION' });
  render();
  if (state.selection && state.settings.autoPlan) requestPlan();
}

function pushDestinations(): void {
  postToMain({
    type: 'DESTINATIONS',
    destinations: state.destinations.map(({ id, label, lngLat, color, enabled }) => ({
      id,
      label,
      lngLat,
      color,
      enabled,
    })),
  });
}

async function runGeocode(): Promise<void> {
  const text = state.pendingAddress.trim();
  if (text.length < 3) return;
  state.geocodeBusy = true;
  render();

  const reply = await send({ type: 'GEOCODE', text });
  state.geocodeBusy = false;
  state.geocodeHits = reply.ok && reply.kind === 'geocode' ? reply.hits : [];
  render();
}

async function addDestination(hit: GeocodeHit): Promise<void> {
  const destination: Destination = {
    id: crypto.randomUUID(),
    label: hit.label.split(',')[0]?.trim() || 'Destination',
    address: hit.label,
    lngLat: hit.lngLat,
    color: DEST_PALETTE[state.destinations.length % DEST_PALETTE.length] ?? '#2f6f8f',
    enabled: true,
  };
  await send({ type: 'ADD_DESTINATION', destination });
  state.geocodeHits = [];
  state.pendingAddress = '';
  await refreshState();
  render();
  if (state.selection) requestPlan();
}

/**
 * One property becomes the subject of the panel. Shared by the two ways that happens: a
 * pin click on the search map, and a detail page naming its own listing.
 */
function selectProperty(selection: NonNullable<State['selection']>): void {
  state.selection = selection;
  state.listingUnresolved = false;
  state.listingPending = false;
  state.lineInfo = null;
  state.results = null;
  state.activeItinerary = null;
  state.revealResults = true;
  // A click is a request to look; a page load is not, so an automatic selection must not
  // re-open a panel the user chose to collapse.
  if (!selection.auto) state.collapsed = false;
  postToMain({ type: 'CLEAR_SELECTION' });

  if (state.settings.autoPlan) requestPlan();
  else render(); // offer the explicit "Calculate commute" button instead
}

function clearSelection(): void {
  state.selection = null;
  state.results = null;
  state.activeItinerary = null;
  state.loading = false;
  postToMain({ type: 'CLEAR_SELECTION' });
}

function requestPlan(): void {
  const selection = state.selection;
  if (!selection) return;
  state.loading = true;
  state.results = null;
  state.activeItinerary = null;
  postToMain({ type: 'CLEAR_SELECTION' });
  render();

  void send({
    type: 'PLAN',
    listingId: selection.listingId,
    lng: selection.lng,
    lat: selection.lat,
  }).then((reply) => {
    // A newer click may have landed while this was in flight.
    if (state.selection?.listingId !== selection.listingId) return;
    state.loading = false;
    state.results = reply.ok && reply.kind === 'plan' ? reply.results : [];
    if (!selection.auto) state.collapsed = false;
    // Reveal again: the intervening "planning…" render already consumed the flag, and
    // the results are taller than the spinner they replace.
    state.revealResults = true;

    // Draw the best journey straight away, so a click gives a route on the map rather
    // than only a number that then needs a second click to visualise.
    const first = state.results.find((r) => !('error' in r) && r.itineraries.length);
    if (state.settings.autoPlan && first && !('error' in first)) {
      const dest = state.destinations.find((d) => d.id === first.destId);
      const best = first.itineraries[0];
      if (dest && best) {
        state.activeItinerary = dest.id;
        postToMain({ type: 'HIGHLIGHT_ROUTE', itinerary: best, color: dest.color });
      }
    }
    render();
  });
}

async function refreshState(): Promise<void> {
  const reply = await send({ type: 'GET_STATE' });
  if (reply.ok && reply.kind === 'state') {
    state.destinations = reply.destinations;
    state.settings = reply.settings;
    state.commuteOptions = reply.commuteOptions;
  }
}

let lineData: { lines: unknown; stops: unknown } | null = null;

async function sendLineData(): Promise<void> {
  lineData ??= await (async () => {
    const reply = await send({ type: 'GET_LINES' });
    return reply.ok && reply.kind === 'lines' ? { lines: reply.lines, stops: reply.stops } : null;
  })();

  if (lineData) postToMain({ type: 'LINES_DATA', ...lineData });
  postToMain({ type: 'SETTINGS_CHANGED', settings: state.settings });
  pushDestinations();
}

/* -------------------------------- inbound --------------------------------- */

onMainMessage((message: MainToIsolated) => {
  switch (message.type) {
    case 'REQUEST_INIT':
    case 'MAP_READY':
      state.mapReady = message.type === 'MAP_READY' ? true : state.mapReady;
      state.attachError = null;
      void sendLineData();
      render();
      break;

    case 'MAP_LOST':
      state.mapReady = false;
      render();
      break;

    case 'MAP_ATTACH_FAILED':
      state.attachError = message.detail;
      render();
      break;

    case 'PROPERTY_CLICKED':
      selectProperty({
        listingId: message.listingId,
        lng: message.lng,
        lat: message.lat,
        priceLabel: message.priceLabel,
        auto: false,
      });
      break;

    case 'LISTING_DETECTED':
      // MAIN resolves the listing synchronously at load, which can beat this side's
      // settings round-trip - and acting on defaults would run lookups for someone who
      // turned auto-calculate off. Dropping it is safe: PANEL_READY, sent once settings
      // are in, asks MAIN to say it again.
      if (!state.booted) break;
      // MAIN re-announces on panel boot and on remount, so the same listing can arrive
      // more than once; re-planning it would be a wasted lookup against a shared service.
      if (state.selection?.listingId === message.listingId && state.selection.auto) break;
      selectProperty({
        listingId: message.listingId,
        lng: message.lng,
        lat: message.lat,
        priceLabel: message.label,
        auto: true,
      });
      break;

    case 'LISTING_CLEARED':
      state.listingUnresolved = message.reason === 'unresolved';
      state.listingPending = message.pending;
      // A pin the user clicked is theirs to dismiss; only the automatic one is dropped.
      if (state.selection?.auto) clearSelection();
      render();
      break;

    case 'LINE_CLICKED':
      state.lineInfo = { name: message.name, detail: message.detail };
      render();
      break;
  }
});

/* ---------------------------------- boot ---------------------------------- */

void (async () => {
  await refreshState();
  state.booted = true;
  render();
  await sendLineData();
  // Ask MAIN for anything it announced while this side was still loading - on a detail
  // page the listing is usually resolved before the panel exists.
  postToMain({ type: 'PANEL_READY' });
})();
