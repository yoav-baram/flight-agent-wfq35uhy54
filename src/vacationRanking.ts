import type { VacationFlightResult } from "./schoolFlightSearch.js";

export interface RankedVacationFlight {
  vacation: string;
  windowStart: string;
  windowEnd: string;
  days: number;
  departureDate: string;
  returnDate: string;
  price: string;
  stops: number;
  type: "Direct" | "Connecting";
  layovers: string[];
  bookingLink: string;
  returnLegUnknown: boolean;
}

export function rankVacationFlights(
  results: VacationFlightResult[],
  limit = 5
): RankedVacationFlight[] {
  const flattened = results.flatMap((result) =>
    result.offers.map((offer) => ({
      vacation: result.vacation,
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
      days: result.days,
      ...offer,
    }))
  );

  return flattened
    .sort((a, b) => {
      const priceA = Number(a.price.replace(/[^0-9.]/g, ""));
      const priceB = Number(b.price.replace(/[^0-9.]/g, ""));
      return priceA - priceB;
    })
    .slice(0, limit);
}
