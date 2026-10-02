import type { SearchFlightsInput } from "./duffel.js";
import { buildTfs } from "./tfs.js";

/*
 * Link to the Google Flights results page for exactly this search.
 * Verified in a live browser: it opens the right route/dates and
 * shows the quoted price. It is a SEARCH page, not one specific
 * fare - neither Google nor any airline exposes a stable per-fare
 * URL (booking flows are session-based), so this is the honest
 * ceiling for "click through and book".
 *
 * maxOutboundStops narrows the page to outbound flights with at
 * most that many stops (0 = nonstop only), so a "cheapest nonstop"
 * link lands on nonstop flights instead of a mixed list.
 *
 * The encoded filter is URL-encoded: standard base64 can contain
 * '+', which a URL parser would silently turn into a space and
 * corrupt the link.
 */
export function getBookingUrl(
  input: SearchFlightsInput,
  maxOutboundStops?: number
): string {
  const encoded = buildTfs(
    input,
    maxOutboundStops
  ).toBase64();

  return (
    "https://www.google.com/travel/flights?tfs=" +
    encodeURIComponent(encoded)
  );
}
