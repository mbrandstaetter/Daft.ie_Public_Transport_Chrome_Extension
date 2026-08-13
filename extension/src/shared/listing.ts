/**
 * Reading which property a detail page is about.
 *
 * The page hands us the answer twice - Next.js router props and the `__NEXT_DATA__`
 * script - and both can be *wrong*: after a client-side navigation between listings the
 * `__NEXT_DATA__` payload still describes the listing that was server-rendered, while the
 * URL has moved on. Verified live on 2026-08-13: after routing from listing 6640128 to
 * 6634811, `__NEXT_DATA__` (and the JSON-LD block, for the same reason) still carried
 * 6640128's address and coordinates.
 *
 * So no candidate is trusted on its own. Each one must carry the id that is in the URL,
 * and a candidate that doesn't is discarded rather than used as an approximation. The
 * failure this guards against is not "no commute shown" - it is a confident, plausible
 * commute drawn for a different property than the one on screen.
 */

export interface DetailListing {
  listingId: string;
  lng: number;
  lat: number;
  /** The listing's own title, shown in the panel so the answer names what it measured. */
  label?: string;
}

/**
 * Detail URLs are `/<section>/<slug>/<id>`. The id is the part that matters: it is the
 * only field a page-supplied candidate can be checked against.
 */
const DETAIL_PATH = /\/(?:for-rent|for-sale|share|new-home-for-sale)\/[^/]+\/(\d+)(?:\/|$)/;

export function listingIdFromPath(pathname: string): string | null {
  return DETAIL_PATH.exec(pathname)?.[1] ?? null;
}

/** Dublin is nowhere near either limit; this only rejects transposed or garbage values. */
const inRange = (lng: number, lat: number) =>
  Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/**
 * A candidate is `pageProps.listing` from either source. Everything about it is untrusted:
 * it may be stale, half-built during a route transition, or shaped differently on a
 * section we have not seen. Anything that fails a check yields null, never a guess.
 */
export function readListing(candidate: unknown, expectedId: string): DetailListing | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const listing = candidate as { id?: unknown; title?: unknown; point?: { coordinates?: unknown } };

  // The gate. `id` is a number in the payload and a string in the URL.
  if (String(listing.id ?? '') !== expectedId) return null;

  const coords = listing.point?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lng, lat] = coords as unknown[];
  if (typeof lng !== 'number' || typeof lat !== 'number' || !inRange(lng, lat)) return null;

  const title = typeof listing.title === 'string' ? listing.title.trim() : '';
  return title
    ? { listingId: expectedId, lng, lat, label: title }
    : { listingId: expectedId, lng, lat };
}

/** First candidate that survives the gate wins; order the callers pass them is the priority. */
export function pickListing(candidates: unknown[], expectedId: string): DetailListing | null {
  for (const candidate of candidates) {
    const listing = readListing(candidate, expectedId);
    if (listing) return listing;
  }
  return null;
}
