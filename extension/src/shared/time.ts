/**
 * Dublin-local time handling.
 *
 * Ireland is UTC+1 in summer and UTC+0 in winter. Building the target instant naively
 * in UTC routes the wrong hour for half the year *and* silently splits the plan cache
 * across the DST boundary, so the target is always constructed in Europe/Dublin and
 * only then converted to an absolute instant.
 */
export const TZ = 'Europe/Dublin';

/** Milliseconds Europe/Dublin is ahead of UTC at a given instant. */
function tzOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour'), get('minute'), get('second')
  );
  // Sub-second precision is irrelevant here and would add spurious drift.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant at which Dublin's wall clock reads the given local date and time. */
function dublinLocalToInstant(y: number, m: number, d: number, h: number, min: number): Date {
  const naive = Date.UTC(y, m - 1, d, h, min);
  // One correction pass resolves the offset; a second settles the rare case where the
  // first guess landed on the other side of a DST transition.
  let utc = naive - tzOffsetMs(new Date(naive));
  utc = naive - tzOffsetMs(new Date(utc));
  return new Date(utc);
}

function dublinParts(instant: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: get('weekday'),
  };
}

const WEEKEND = new Set(['Sat', 'Sun']);

/**
 * The next weekday at the configured local time, strictly in the future. Stable for a
 * whole session, which is what makes it usable as a cache-key component.
 */
export function nextWeekdayTarget(hour: number, minute: number, now = new Date()): Date {
  const today = dublinParts(now);
  let candidate = dublinLocalToInstant(today.year, today.month, today.day, hour, minute);

  for (let i = 0; i < 8; i++) {
    const p = dublinParts(candidate);
    if (candidate.getTime() > now.getTime() && !WEEKEND.has(p.weekday)) return candidate;
    candidate = new Date(candidate.getTime() + 24 * 3600 * 1000);
    const next = dublinParts(candidate);
    candidate = dublinLocalToInstant(next.year, next.month, next.day, hour, minute);
  }
  return candidate;
}

/** Today in Europe/Dublin as `YYYY-MM-DD`, for seeding and validating date inputs. */
export function dublinToday(now = new Date()): string {
  const p = dublinParts(now);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * The instant a commute is planned for: a pinned date if the user chose one, otherwise
 * the next weekday. Either way the wall clock is interpreted in Europe/Dublin, so the
 * summer/winter offset never shifts the result by an hour.
 */
export function resolveTarget(
  options: { targetDate: string | null; targetHour: number; targetMinute: number },
  now = new Date()
): Date {
  if (options.targetDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(options.targetDate);
    if (match) {
      return dublinLocalToInstant(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        options.targetHour,
        options.targetMinute
      );
    }
  }
  return nextWeekdayTarget(options.targetHour, options.targetMinute, now);
}

export function formatDublinDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-IE', {
    timeZone: TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(instant);
}

export function formatDublinTime(iso: string): string {
  return new Intl.DateTimeFormat('en-IE', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

export function formatDublinDay(instant: Date): string {
  return new Intl.DateTimeFormat('en-IE', {
    timeZone: TZ,
    weekday: 'long',
  }).format(instant);
}

export function formatDuration(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} h` : `${h} h ${String(rest).padStart(2, '0')}`;
}
