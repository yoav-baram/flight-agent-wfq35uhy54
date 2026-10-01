import { FlightData, Passengers, createFilter } from "google-flights-ts";
import type { CabinClass, FlightOffer, SearchFlightsInput } from "./duffel.js";

function mapCabinClass(
  cabinClass: CabinClass
): "economy" | "premium-economy" | "business" | "first" {
  switch (cabinClass) {
    case "premium_economy":
      return "premium-economy";
    case "business":
      return "business";
    case "first":
      return "first";
    case "economy":
    default:
      return "economy";
  }
}

/*
 * Verified working: this loads the real Google Flights results page
 * for the exact route/dates/cabin/passenger count (manually tested).
 * It is a search link, not a link to one specific fare - Google does
 * not expose a stable per-offer URL, so this is the honest ceiling
 * for "click through and book" via Google Flights.
 */
function buildGoogleFlightsUrl(input: SearchFlightsInput): string {
  const flightData = [
    new FlightData({
      date: input.departureDate,
      from_airport: input.origin,
      to_airport: input.destination,
    }),
  ];

  if (input.returnDate) {
    flightData.push(
      new FlightData({
        date: input.returnDate,
        from_airport: input.destination,
        to_airport: input.origin,
      })
    );
  }

  const filter = createFilter({
    flight_data: flightData,
    trip: input.returnDate ? "round-trip" : "one-way",
    passengers: new Passengers({ adults: input.adults }),
    seat: mapCabinClass(input.cabinClass),
  });

  return `https://www.google.com/travel/flights?tfs=${filter.toBase64()}`;
}

function formatDateForDelta(date: string): string {
  const [year, month, day] = date.split("-");
  return `${month}/${day}/${year}`;
}

/*
 * Delta is the only carrier on this route with a verified, working
 * query-string search format - manually confirmed it prefills Delta's
 * own search form with the exact route, dates, and passenger count.
 *
 * No airline (including Delta) exposes a URL for one specific
 * flight/fare: booking flows are session-based single-page apps, not
 * shareable links. This can only ever point at a prefilled SEARCH on
 * Delta's own site, never "buy this exact seat" - one click closer to
 * the airline than a generic search engine, not a final booking link.
 *
 * Other carriers relevant to this route were checked and rejected:
 * El Al actively blocks automated requests entirely, and United has no
 * stable public query-string format (confirmed with a live request).
 * Rather than guess and risk sending a broken link, everything else
 * falls back to the verified Google Flights link below.
 */
function buildDeltaSearchUrl(input: SearchFlightsInput): string | null {
  if (!input.returnDate) {
    return null;
  }

  const cabinFareClass =
    input.cabinClass === "business"
      ? "JB"
      : input.cabinClass === "first"
      ? "FA"
      : input.cabinClass === "premium_economy"
      ? "PE"
      : "BE";

  const params = new URLSearchParams({
    originCity: input.origin,
    destinationCity: input.destination,
    departureDate: formatDateForDelta(input.departureDate),
    returnDate: formatDateForDelta(input.returnDate),
    paxCount: String(input.adults),
    tripType: "ROUND_TRIP",
    cabinFareClass,
    searchByCabin: "true",
    priceSchedule: "price",
    deltaOnlySearch: "false",
  });

  return `https://www.delta.com/flightsearch/book-a-flight?${params.toString()}`;
}

export function getBookingUrl(
  offer: Pick<FlightOffer, "slices">,
  input: SearchFlightsInput
): string {
  const firstSegment = offer.slices[0]?.segments[0];

  /*
   * `segment.airline` (see duffel.ts's mapSegment) is already the
   * best available carrier identifier: the human-readable name
   * ("Delta") when the decoder resolved it, otherwise the raw
   * carrier code ("DL") as a fallback. There's no separate raw
   * flight-number-based code to extract here - flight numbers are
   * purely numeric ("1234"), so a previous version of this function
   * that derived a "code" from flightNumber could never match
   * anything and was silently dead.
   */
  const airline = (firstSegment?.airline ?? "").toLowerCase();

  if (airline.includes("delta") || airline === "dl") {
    const deltaUrl = buildDeltaSearchUrl(input);
    if (deltaUrl) {
      return deltaUrl;
    }
  }

  return buildGoogleFlightsUrl(input);
}
