/**
 * Appendix R seam.
 *
 * M1 always reads the text layer. It is the fallback for every PDF and the
 * ordered paragraph reference a later multimodal pass can align against.
 * This module must not call a model or choose a route other than text-layer.
 */

export const TEXT_LAYER_ROUTE = "text-layer";

export function layoutRouteForPage() {
  return {
    route: TEXT_LAYER_ROUTE,
    reason: "m1-text-layer-fallback"
  };
}
