import type { FlightOffer } from "./duffel.js";

export interface FormattedVacationOffer {
  origin: string;
  destination: string;
  /*
   * The dates that were SEARCHED - always known, and exactly what
   * the price and booking link correspond to. (Segment timestamps
   * from the scraper are frequently null, so they are not used.)
   */
  departureDate: string;
  returnDate: string;
  priceAmount: number;
  currency: string;
  price: string;
  /*
   * Stops on the OUTBOUND flight. Google's round-trip results list
   * outbound flights first (priced with the cheapest return); the
   * return leg's own stops aren't shown until an outbound is
   * picked, so they are not known here.
   */
  stops: number;
  layovers: string[];
  bookingLink: string;
  /*
   * True when only the outbound leg was decoded - i.e. the return
   * leg's routing is unverified (the price is still the full
   * round-trip fare).
   */
  returnLegUnknown: boolean;
}

export function formatVacationOffer(
  offer: FlightOffer
): FormattedVacationOffer {
  return {
    origin: offer.origin,
    destination: offer.destination,
    departureDate: offer.departureDate,
    returnDate: offer.returnDate ?? "",
    priceAmount: Number(offer.totalAmount),
    currency: offer.totalCurrency,
    price: `${offer.totalCurrency} ${offer.totalAmount}`,
    stops: offer.slices[0]?.stops ?? 0,
    layovers: offer.slices.flatMap(
      (slice) => slice.layovers
    ),
    bookingLink: offer.bookingUrl,
    returnLegUnknown: offer.returnLegUnknown,
  };
}
