// Zooming a page or a photo on the projector (Issue #262, phase 2).
//
// A view is { zoom, panX, panY }:
//
//   zoom 1   "fit page": the whole of it, letterboxed in its panel, as always.
//   zoom > 1 the content scaled up that much from fit page, and the panel
//            filled with as much of it as fits - the window the room sees is
//            the PANEL's shape, cut from the content, so a portrait page
//            zoomed in fills a landscape screen instead of staying a narrow
//            column with bars beside it.
//   panX/Y   where the middle of that window sits, as fractions of the
//            content. Along an axis where the scaled content is still
//            narrower than the panel there is nothing to pan: it is centred.
//
// Everything here is plain arithmetic on aspect ratios, shared by the display
// (which draws the window), the controller (which works out presets and
// clamps before it sends) and the tests. Ink lives in fractions of the
// content, so `contentRect` is also where ink goes: draw the content there,
// draw the ink there, and both stay pinned together at any zoom.

export const ZOOM_MAX = 6;

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * How big the content is on screen and where its corner sits, in the panel's
 * own units, for a panel `slotW`×`slotH` showing content of `aspect` at `view`.
 * At zoom 1 this is the letterboxed "contain" box; zoomed, it is bigger than
 * the panel and partly off its edges.
 */
export function contentRect(slotW, slotH, aspect, view = {}) {
  if (!(slotW > 0) || !(slotH > 0) || !(aspect > 0)) return { x: 0, y: 0, w: slotW || 0, h: slotH || 0 };
  const v = clampView(view, aspect, slotW / slotH);
  // Fit page, in panel units, for content 1 unit tall and `aspect` wide.
  const fit = Math.min(slotW / aspect, slotH);
  const w = aspect * fit * v.zoom;
  const h = fit * v.zoom;
  const x = w <= slotW ? (slotW - w) / 2 : slotW / 2 - v.panX * w;
  const y = h <= slotH ? (slotH - h) / 2 : slotH / 2 - v.panY * h;
  return { x, y, w, h };
}

/**
 * The part of the content the room can see, as fractions of it: { x, y, w, h }
 * with w/h of 1 meaning all of it along that axis.
 */
export function visibleWindow(aspect, slotAspect, view = {}) {
  const r = contentRect(slotAspect, 1, aspect, view);
  const x0 = Math.max(0, -r.x / r.w);
  const y0 = Math.max(0, -r.y / r.h);
  const x1 = Math.min(1, (slotAspect - r.x) / r.w);
  const y1 = Math.min(1, (1 - r.y) / r.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * A view made sensible for this content in this panel: zoom from 1 to
 * ZOOM_MAX, and the window kept on the content - or centred, along an axis
 * where the content does not fill the panel.
 */
export function clampView(view = {}, aspect, slotAspect) {
  const zoom = Math.min(ZOOM_MAX, Math.max(1, num(view.zoom, 1)));
  let panX = Math.min(1, Math.max(0, num(view.panX, 0.5)));
  let panY = Math.min(1, Math.max(0, num(view.panY, 0.5)));
  if (aspect > 0 && slotAspect > 0) {
    // In panel units with the panel 1 tall: the content's size at this zoom.
    const fit = Math.min(slotAspect / aspect, 1);
    const w = aspect * fit * zoom;
    const h = fit * zoom;
    // Half the window, as a fraction of the content, along each axis.
    const halfX = slotAspect / w / 2;
    const halfY = 1 / h / 2;
    panX = halfX >= 0.5 ? 0.5 : Math.min(1 - halfX, Math.max(halfX, panX));
    panY = halfY >= 0.5 ? 0.5 : Math.min(1 - halfY, Math.max(halfY, panY));
  }
  return { zoom, panX, panY };
}

/**
 * The three presets:
 *   page    all of it (zoom 1)
 *   width   as wide as the panel, starting at the top - how a portrait page
 *           is read on a landscape screen
 *   height  as tall as the panel, starting at the left
 * A preset the content already meets (a landscape slide's "width" on a
 * landscape screen) is simply fit page.
 */
export function fitView(kind, aspect, slotAspect) {
  if (!(aspect > 0) || !(slotAspect > 0) || kind === 'page') return { zoom: 1, panX: 0.5, panY: 0.5 };
  if (kind === 'width') return clampView({ zoom: Math.max(1, slotAspect / aspect), panX: 0.5, panY: 0 }, aspect, slotAspect);
  if (kind === 'height') return clampView({ zoom: Math.max(1, aspect / slotAspect), panX: 0, panY: 0.5 }, aspect, slotAspect);
  return { zoom: 1, panX: 0.5, panY: 0.5 };
}

/**
 * A new zoom, keeping the point at (`ax`, `ay`) - fractions of the panel,
 * 0.5/0.5 being its middle - where it is on screen, the way a pinch or a
 * mouse wheel anchors to where it happens.
 */
export function zoomAround(view, nextZoom, aspect, slotAspect, ax = 0.5, ay = 0.5) {
  const before = contentRect(slotAspect, 1, aspect, view);
  // The content fraction under the anchor now.
  const fx = (ax * slotAspect - before.x) / before.w;
  const fy = (ay - before.y) / before.h;
  const zoom = Math.min(ZOOM_MAX, Math.max(1, nextZoom));
  const fit = Math.min(slotAspect / aspect, 1);
  const w = aspect * fit * zoom;
  const h = fit * zoom;
  // Put that fraction back under the anchor: panX is the window's middle.
  const panX = fx + (slotAspect / 2 - ax * slotAspect) / w;
  const panY = fy + (0.5 - ay) / h;
  return clampView({ zoom, panX, panY }, aspect, slotAspect);
}

/** Move the window by a fraction of itself (0.5 = half a window). */
export function panBy(view, dx, dy, aspect, slotAspect) {
  const win = visibleWindow(aspect, slotAspect, view);
  const v = clampView(view, aspect, slotAspect);
  return clampView({ zoom: v.zoom, panX: v.panX + dx * win.w, panY: v.panY + dy * win.h }, aspect, slotAspect);
}

/** Whether a view shows anything but the whole content. */
export const isZoomed = (view) => num(view?.zoom, 1) > 1.001;
