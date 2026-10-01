import type { FlightOffer } from "./duffel.js";

export interface FormattedVacationOffer {
  departureDate: string;
  returnDate: string;
  price: string;
  stops: number;
  type: "Direct" | "Connecting";
  layovers: string[];
  bookingLink: string;
  /*
   * google-flights-ts's decoder only ever reads the outbound leg's
   * raw data for a round trip, so the return leg's own stops are
   * never visible to us (the total PRICE is still the correct full
   * round-trip fare). True when we only have one slice to go on.
   */
  returnLegUnknown: boolean;
}

function extractDate(value: string | null | undefined): string {
  if (!value) {
    return "Unknown";
  }

  return value.slice(0, 10);
}

export function formatVacationOffer(
  offer: FlightOffer
): FormattedVacationOffer {
  const layovers: string[] = [];
  let totalStops = 0;

  for (const slice of offer.slices) {
    totalStops += Math.max(0, slice.segments.length - 1);

    for (let i = 0; i < slice.segments.length - 1; i++) {
      const current = slice.segments[i];
      const next = slice.segments[i + 1];

      if (!current.arrivalTime || !next.departureTime) {
        continue;
      }

      const arrival = new Date(current.arrivalTime);
      const departure = new Date(next.departureTime);

      const minutes = Math.round(
        (departure.getTime() - arrival.getTime()) / (1000 * 60)
      );

      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;

      layovers.push(
        hours > 0
          ? `${hours}h ${remainingMinutes}m`
          : `${remainingMinutes}m`
      );
    }
  }

  const firstSegment = offer.slices[0]?.segments[0];

  const departureDate = extractDate(
    firstSegment?.departureTime
  );

  const returnLegUnknown = offer.returnLegUnknown;

  /*
   * When the return leg was never decoded, offer.slices has only
   * the outbound slice - so "the last slice" IS the outbound one,
   * and its arrival time is just the outbound flight landing, not
   * any real return date. Say so plainly instead of reporting a
   * misleading date.
   */
  let returnDate: string;

  if (returnLegUnknown) {
    returnDate = "Unknown";
  } else {
    const lastSlice = offer.slices[offer.slices.length - 1];
    const lastSegment =
      lastSlice?.segments[lastSlice.segments.length - 1];

    returnDate = extractDate(lastSegment?.arrivalTime);
  }

  /*
   * A nonstop *outbound* leg with an unverified return leg is not
   * confirmed nonstop overall - treat it as Connecting (the
   * stricter alert threshold) rather than risk under-alerting on
   * a "Direct" label we can't actually back up.
   */
  const type: "Direct" | "Connecting" =
    totalStops === 0 && !returnLegUnknown
      ? "Direct"
      : "Connecting";

  return {
    departureDate,
    returnDate,
    price: `${offer.totalCurrency} ${offer.totalAmount}`,
    stops: totalStops,
    type,
    layovers,
    bookingLink: offer.bookingUrl,
    returnLegUnknown,
  };
}
