import type { VacationFlightResult } from "./schoolFlightSearch.js";
import type { FormattedVacationOffer } from "./vacationFormatter.js";

export interface RankedVacationFlight
  extends FormattedVacationOffer {
  vacation: string;
  windowStart: string;
  windowEnd: string;
  days: number;
}

export function rankVacationFlights(
  results: VacationFlightResult[],
  limit = 5
): RankedVacationFlight[] {
  return results
    .flatMap((result) =>
      result.offers.map((offer) => ({
        vacation: result.vacation,
        windowStart: result.windowStart,
        windowEnd: result.windowEnd,
        days: result.days,
        ...offer,
      }))
    )
    .sort((a, b) => a.priceAmount - b.priceAmount)
    .slice(0, limit);
}
