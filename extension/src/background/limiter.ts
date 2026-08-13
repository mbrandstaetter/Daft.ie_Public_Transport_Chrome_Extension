/**
 * Politeness limits for the public Transitous instance.
 *
 * It is volunteer-run and asks to be contacted before heavy use, so this caps
 * concurrency, spaces requests, coalesces duplicates, and backs off hard on 429/503.
 * Nothing here is a performance optimisation - it is the condition of using the service.
 */
const MAX_CONCURRENT = 2;
const MIN_SPACING_MS = 250;
const SESSION_CAP = 200;

const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60_000;

export class RateLimitedError extends Error {}
export class SessionCapError extends Error {}

let active = 0;
let lastStart = 0;
let sessionCount = 0;
let backoffUntil = 0;
let consecutiveFailures = 0;

const queue: Array<() => void> = [];
const inFlight = new Map<string, Promise<unknown>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function release(): void {
  active--;
  const next = queue.shift();
  if (next) next();
}

async function acquire(): Promise<void> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  active++;
  const wait = lastStart + MIN_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastStart = Date.now();
}

export function sessionUsage(): { used: number; cap: number } {
  return { used: sessionCount, cap: SESSION_CAP };
}

/**
 * Runs `task` under the limits. Identical concurrent calls (same key) share one
 * request rather than racing - double-clicking a pin must not double the traffic.
 */
export async function schedule<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  if (Date.now() < backoffUntil) throw new RateLimitedError('backing off');
  if (sessionCount >= SESSION_CAP) throw new SessionCapError('session request cap reached');

  const run = (async () => {
    await acquire();
    try {
      sessionCount++;
      const result = await task();
      consecutiveFailures = 0;
      return result;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 429 || status === 503 || status === 502) {
        consecutiveFailures++;
        const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1));
        backoffUntil = Date.now() + delay + Math.random() * 500;
      }
      throw err;
    } finally {
      release();
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  return run;
}
