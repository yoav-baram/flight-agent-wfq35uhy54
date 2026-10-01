import { setTimeout as delay } from "node:timers/promises";
import { searchFlights, type FlightOffer } from "./duffel.js";
import { getSchoolBreaks } from "./schoolCalendar.js";
import {
  getTripWindowDays,
  isTripWindowLongEnough,
} from "./tripWindows.js";
import {
  formatVacationOffer,
  type FormattedVacationOffer,
} from "./vacationFormatter.js";

export interface SchoolVacationFlightSearch {
  origin: string;
  destination: string;
  adults: number;
  cabinClass: "economy" | "premium_economy" | "business" | "first";
}

export interface VacationFlightResult {
  vacation: string;
  windowStart: string;
  windowEnd: string;
  days: number;
  offers: FormattedVacationOffer[];
}

/*
 * Only the OUTBOUND leg (slices[0]) - this is meant to be a
 * representative ONE-WAY duration for window-eligibility checks.
 * Summing every slice double-counts whenever the decoder manages
 * to resolve both legs (outbound + return), making the same route
 * compute a wildly different duration purely by decoder luck.
 */
function getFlightDurationHours(offer: FlightOffer): number {
  let totalMinutes = 0;

  const outbound = offer.slices[0];

  if (!outbound) {
    return 0;
  }

  for (const segment of outbound.segments) {
    /*
     * new Date(null) silently resolves to the 1970 epoch rather
     * than an invalid date, so a missing timestamp here would
     * otherwise poison the total with a huge bogus offset.
     */
    if (!segment.departureTime || !segment.arrivalTime) {
      continue;
    }

    const departure = new Date(segment.departureTime);
    const arrival = new Date(segment.arrivalTime);

    const minutes =
      (arrival.getTime() - departure.getTime()) /
      (1000 * 60);

    if (Number.isFinite(minutes) && minutes > 0) {
      totalMinutes += minutes;
    }
  }

  return totalMinutes / 60;
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getDateCombinations(
  startDate: string,
  endDate: string
): Array<{
  departureDate: string;
  returnDate: string;
}> {
  const dates: string[] = [];

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  for (
    let date = new Date(start);
    date <= end;
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    dates.push(date.toISOString().slice(0, 10));
  }

  const combinations: Array<{
    departureDate: string;
    returnDate: string;
  }> = [];

  /*
   * Sample every other departure day with two trip lengths, rather
   * than every single day x [5,7,9]. This search now runs on a
   * 15-minute cycle across 4 origins, so an exhaustive sweep would
   * mean thousands of scraped requests/day against Google Flights -
   * a much higher risk of the origin IP getting rate-limited or
   * blocked. This still covers each window well at a fraction of
   * the request volume.
   */
  const tripLengths = [7, 9];

  for (let i = 0; i < dates.length; i += 2) {
    const departureDate = dates[i];

    for (const tripLength of tripLengths) {
      const departure = new Date(
        `${departureDate}T00:00:00Z`
      );

      const returnDate = new Date(departure);

      returnDate.setUTCDate(
        returnDate.getUTCDate() + tripLength
      );

      if (returnDate <= end) {
        combinations.push({
          departureDate,
          returnDate: returnDate
            .toISOString()
            .slice(0, 10),
        });
      }
    }
  }

  // Always include the full vacation window.
  combinations.push({
    departureDate: startDate,
    returnDate: endDate,
  });

  return combinations;
}
export async function searchSchoolVacationFlights(
  input: SchoolVacationFlightSearch
): Promise<VacationFlightResult[]> {
  const schoolBreaks = getSchoolBreaks();

  if (schoolBreaks.length === 0) {
    return [];
  }

  const firstBreak = schoolBreaks[0];

  console.log(
    `[vacation-search] Determining route duration using ${firstBreak.name}...`
  );

  const initialOffers = await searchFlights({
    origin: input.origin,
    destination: input.destination,
    departureDate: firstBreak.tripWindowStart,
    returnDate: firstBreak.tripWindowEnd,
    adults: input.adults,
    cabinClass: input.cabinClass,
  });

  if (initialOffers.length === 0) {
    throw new Error(
      `No flights found for ${input.origin} -> ${input.destination}.`
    );
  }

  const flightDurationHours =
    getFlightDurationHours(initialOffers[0]);

  console.log(
    `[vacation-search] Representative flight duration: ` +
      `${flightDurationHours.toFixed(1)} hours`
  );

  const eligibleBreaks = schoolBreaks.filter((schoolBreak) =>
    isTripWindowLongEnough(
      schoolBreak,
      flightDurationHours
    )
  );

  const results: VacationFlightResult[] = [];

  let totalCombinations = 0;
  let failedCombinations = 0;

  for (const schoolBreak of eligibleBreaks) {
   const combinations = getDateCombinations(
  schoolBreak.tripWindowStart,
  schoolBreak.tripWindowEnd
);

    const allOffers: FlightOffer[] = [];

    for (const combination of combinations) {
      console.log(
        `[vacation-search] ${schoolBreak.name}: ` +
          `${combination.departureDate} -> ${combination.returnDate}`
      );

      totalCombinations++;

      try {
        const offers = await searchFlights({
          origin: input.origin,
          destination: input.destination,
          departureDate: combination.departureDate,
          returnDate: combination.returnDate,
          adults: input.adults,
          cabinClass: input.cabinClass,
        });

        allOffers.push(...offers);
      } catch (error) {
        failedCombinations++;

        console.error(
          `[vacation-search] Search failed for ` +
            `${combination.departureDate} -> ${combination.returnDate}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Small gap between requests so we don't hammer Google Flights.
      await delay(500);
    }

    const uniqueOffers = new Map<string, FlightOffer>();

    for (const offer of allOffers) {
      const key = JSON.stringify({
        price: offer.totalAmount,
        currency: offer.totalCurrency,
        slices: offer.slices.map((slice) =>
          slice.segments.map((segment) => ({
            airline: segment.airline,
            flightNumber: segment.flightNumber,
            departureTime: segment.departureTime,
            arrivalTime: segment.arrivalTime,
          }))
        ),
      });

      uniqueOffers.set(key, offer);
    }

    const sortedOffers = [...uniqueOffers.values()]
      .sort(
        (a, b) =>
          Number(a.totalAmount) -
          Number(b.totalAmount)
      )
      .slice(0, 10);

    results.push({
      vacation: schoolBreak.name,
      windowStart: schoolBreak.tripWindowStart,
      windowEnd: schoolBreak.tripWindowEnd,
      days: getTripWindowDays(schoolBreak),
      offers: sortedOffers.map(formatVacationOffer),
    });
  }

  /*
   * If every single combination search failed, that's a fully
   * broken/blocked scraper - not "no flights exist". Without this,
   * the caller sees the same empty `results` either way and logs
   * an identical "no flights found" message for both cases, with
   * no way to notice the monitor has effectively stopped working.
   */
  if (
    totalCombinations > 0 &&
    failedCombinations === totalCombinations
  ) {
    throw new Error(
      `All ${totalCombinations} flight searches failed for ` +
        `${input.origin} -> ${input.destination} - the scraper ` +
        `may be rate-limited or blocked, not just seeing empty results.`
    );
  }

  return results;
}

/*
 * Open-jaw check: depart one origin, return into a DIFFERENT one.
 * Deliberately lightweight (only the full vacation-window date
 * pair per break, no combinatorial sampling) since this runs
 * alongside the regular per-origin search and adds meaningfully to
 * the total request volume against an already rate-limit-sensitive
 * scraper.
 */
export interface OpenJawFlightResult {
  vacation: string;
  windowStart: string;
  windowEnd: string;
  offer: FormattedVacationOffer | null;
}

export async function searchOpenJawFlights(
  origin: string,
  destination: string,
  returnAirport: string,
  adults: number,
  cabinClass:
    | "economy"
    | "premium_economy"
    | "business"
    | "first"
): Promise<OpenJawFlightResult[]> {
  const schoolBreaks = getSchoolBreaks();
  const results: OpenJawFlightResult[] = [];

  for (const schoolBreak of schoolBreaks) {
    try {
      const offers = await searchFlights({
        origin,
        destination,
        departureDate: schoolBreak.tripWindowStart,
        returnDate: schoolBreak.tripWindowEnd,
        adults,
        cabinClass,
        openJawReturnAirport: returnAirport,
      });

      results.push({
        vacation: schoolBreak.name,
        windowStart: schoolBreak.tripWindowStart,
        windowEnd: schoolBreak.tripWindowEnd,
        offer: offers[0]
          ? formatVacationOffer(offers[0])
          : null,
      });
    } catch (error) {
      console.error(
        `[open-jaw-search] Search failed for ` +
          `${origin} -> ${destination} -> ${returnAirport} ` +
          `${schoolBreak.name}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }

    await delay(500);
  }

  return results;
}