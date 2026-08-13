/**
 * Where the detail page's listing data actually lives.
 *
 * Two sources, in this order - see shared/listing.ts for why neither is trusted blind:
 *
 * 1. `window.next.router.components[route].props.pageProps.listing` — the props Next.js is
 *    currently rendering. Stays correct across client-side navigation, which is the case
 *    the other source gets wrong.
 * 2. `__NEXT_DATA__` — the server-rendered payload. Correct on a fresh load, stale after
 *    any in-page navigation. Kept as a fallback because it survives router internals
 *    being renamed, which is the more likely way source 1 breaks.
 *
 * Deliberately *not* used: the map's centre or its marker. Both would still produce a
 * coordinate after the user pans, and a wrong-but-plausible commute is worse than none.
 */
import { listingIdFromPath, pickListing, type DetailListing } from '../shared/listing';

/** `__NEXT_DATA__` is written once at load and is ~400 KB; parse each script node once. */
const nextDataCache = new WeakMap<Element, unknown>();

function fromRouter(): unknown {
  const router = (window as { next?: { router?: Record<string, unknown> } }).next?.router;
  const route = router?.['route'];
  if (typeof route !== 'string') return null;
  const components = router?.['components'] as
    | Record<string, { props?: { pageProps?: { listing?: unknown } } } | undefined>
    | undefined;
  return components?.[route]?.props?.pageProps?.listing ?? null;
}

function fromNextData(): unknown {
  const script = document.getElementById('__NEXT_DATA__');
  if (!script) return null;
  if (nextDataCache.has(script)) return nextDataCache.get(script);

  let listing: unknown = null;
  try {
    const data = JSON.parse(script.textContent ?? '') as {
      props?: { pageProps?: { listing?: unknown } };
    };
    listing = data.props?.pageProps?.listing ?? null;
  } catch {
    listing = null; // a truncated or reshaped payload is a miss, not a crash
  }
  nextDataCache.set(script, listing);
  return listing;
}

/**
 * The property this page is about, or null while the page's data has not caught up with
 * the URL - the caller retries rather than settling for whatever is there.
 */
export function resolveDetailListing(pathname: string): DetailListing | null {
  const listingId = listingIdFromPath(pathname);
  if (!listingId) return null;
  return pickListing([fromRouter(), fromNextData()], listingId);
}
