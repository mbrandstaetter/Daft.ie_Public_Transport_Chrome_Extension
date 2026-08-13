/** Keep at least this much of the panel on screen in each axis. */
export const KEEP_VISIBLE_PX = 56;

export interface Point {
  left: number;
  top: number;
}

/**
 * Constrains a dragged panel so it always remains grabbable.
 *
 * Horizontally the panel may hang off either edge, but never so far that less than
 * `keep` pixels remain: dragging it fully off-screen would leave no way to retrieve it
 * short of clearing storage. Vertically the top edge is pinned at zero, because the drag
 * handle is the header - allowing a negative top would put the only grabbable part of
 * the panel above the viewport.
 */
export function clampToViewport(
  left: number,
  top: number,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  keep = KEEP_VISIBLE_PX
): Point {
  const minLeft = keep - size.width;
  const maxLeft = viewport.width - keep;
  const maxTop = viewport.height - keep;
  return {
    left: Math.round(Math.max(minLeft, Math.min(left, maxLeft))),
    top: Math.round(Math.max(0, Math.min(top, maxTop))),
  };
}
