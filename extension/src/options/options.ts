import { DEFAULT_COMMUTE_OPTIONS, type CommuteOptions } from '../shared/types';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const hour = $<HTMLInputElement>('hour');
const walk = $<HTMLInputElement>('walk');
const transfers = $<HTMLInputElement>('transfers');
const maxTime = $<HTMLInputElement>('maxTime');

async function current(): Promise<CommuteOptions> {
  const { commuteOptions } = await chrome.storage.sync.get('commuteOptions');
  return { ...DEFAULT_COMMUTE_OPTIONS, ...((commuteOptions as Partial<CommuteOptions>) ?? {}) };
}

async function load(): Promise<void> {
  const options = await current();
  hour.value = String(options.targetHour);
  walk.value = String(options.maxWalkMeters);
  transfers.value = String(options.maxTransfers);
  maxTime.value = String(options.maxTravelMinutes);
}

function flash(id: string): void {
  const node = $(id);
  node.hidden = false;
  setTimeout(() => {
    node.hidden = true;
  }, 1800);
}

const clamp = (value: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

$('save').addEventListener('click', async () => {
  // Merge onto what is stored, not onto the defaults: travel mode and the pinned date
  // are set from the panel, and spreading defaults here would silently reset them.
  const options: CommuteOptions = {
    ...(await current()),
    targetHour: clamp(Number(hour.value), 0, 23, 9),
    maxWalkMeters: clamp(Number(walk.value), 200, 3000, 1000),
    maxTransfers: clamp(Number(transfers.value), 0, 6, 3),
    maxTravelMinutes: clamp(Number(maxTime.value), 15, 240, 120),
  };
  await chrome.storage.sync.set({ commuteOptions: options });
  flash('savedMsg');
});

$('wipe').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'WIPE_ALL' });
  await load();
  flash('wipedMsg');
});

void load();
