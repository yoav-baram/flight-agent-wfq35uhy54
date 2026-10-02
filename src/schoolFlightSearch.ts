import { setTimeout as delay } from "node:timers/promises";
import {
  RateLimitedError,
  searchFlights,
  type FlightOffer,
} from "./duffel.js";
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

/*
 * Outbound stop counts we report the cheapest flight for.
 */
export const TRACKED_STOP_COUNTS = [0, 1, 2] as const;

export interface VacationFlightResult {
  vacation: string;
  windowStart: string;
  windowEnd: string;
  days: number;
  /*
   * The cheapest offers overall (top 10) - for browsing/ranking.
   */
  offers: FormattedVacationOffer[];
  /*
   * The cheapest offer for each tracked outbound stop count,
   * kept separately because nonstops are usually pricier and would
   * otherwise be cut off by the "cheapest 10" above.
   */
  cheapestByStops: Partial<
    Record<number, FormattedVacationOffer>
  >;
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

/*
 * Above this many days, a window (summer break) is long enough that
 * the short-break sampling strategy below would generate 70-100+
 * searches for a single window - a combinatorial blow-up against an
 * already rate-limit-sensitive scraper, and not even a realistic
 * trip shape (nobody books a 7-9 day trip out of a 10-week break).
 */
const LONG_WINDOW_THRESHOLD_DAYS = 20;

const LONG_WINDOW_DEPARTURE_STRIDE_DAYS = 7;
const LONG_WINDOW_TRIP_LENGTHS = [20, 25, 30];

function listDatesInWindow(
  startDate: string,
  endDate: string
): string[] {
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

  return dates;
}

function sampleCombinations(
  dates: string[],
  end: Date,
  departureStride: number,
  tripLengths: number[]
): Array<{ departureDate: string; returnDate: string }> {
  const combinations: Array<{
    departureDate: string;
    returnDate: string;
  }> = [];

  for (
    let i = 0;
    i < dates.length;
    i += departureStride
  ) {
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

  return combinations;
}

function getDateCombinations(
  startDate: string,
  endDate: string
): Array<{
  departureDate: string;
  returnDate: string;
}> {
  const dates = listDatesInWindow(startDate, endDate);
  const end = new Date(`${endDate}T00:00:00Z`);

  const isLongWindow =
    dates.length > LONG_WINDOW_THRESHOLD_DAYS;

  /*
   * Short breaks (Dec/Feb/April recess): sample every other
   * departure day with two trip lengths, rather than every single
   * day x [5,7,9] - an exhaustive sweep would mean thousands of
   * scraped requests against Google Flights, a much higher risk of
   * getting rate-limited or blocked. This still covers each window
   * well at a fraction of the request volume. The whole window is
   * itself a sensible trip here, so it is always included.
   *
   * Summer break: a ~10-week window. Trips of 20-30 days, departing
   * weekly. The wanted range is 20-40 days, but trips longer than
   * 30 days come back with nothing readable from a plain request
   * (checked live across every departure: 20/25/30 all read, 35/40
   * never do - Google fills those results in with JavaScript, so
   * they show on google.com but not in the data we can fetch), so
   * searching them would only waste requests. The whole 66-day
   * window is skipped for the same reason and because it is far
   * outside the wanted trip length. Return dates past Google's
   * ~330-day booking horizon also come back empty until they come
   * into range; that fills in on its own over time.
   */
  if (isLongWindow) {
    return sampleCombinations(
      dates,
      end,
      LONG_WINDOW_DEPARTURE_STRIDE_DAYS,
      LONG_WINDOW_TRIP_LENGTHS
    );
  }

  const combinations = sampleCombinations(dates, end, 2, [7, 9]);

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
        /*
         * A real block ends this origin's search immediately - the
         * remaining combinations would only be more requests into
         * a service that is refusing us.
         */
        if (error instanceof RateLimitedError) {
          throw error;
        }

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
      /*
       * The searched dates are part of the identity: segment
       * timestamps are often null, so without them the same flight
       * priced identically on two different date pairs would
       * collapse into one entry.
       */
      const key = JSON.stringify({
        departureDate: offer.departureDate,
        returnDate: offer.returnDate,
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

    const sortedOffers = [...uniqueOffers.values()].sort(
      (a, b) =>
        Number(a.totalAmount) - Number(b.totalAmount)
    );

    const cheapestByStops: Partial<
      Record<number, FormattedVacationOffer>
    > = {};

    for (const stops of TRACKED_STOP_COUNTS) {
      const cheapest = sortedOffers.find(
        (offer) => (offer.slices[0]?.stops ?? 0) === stops
      );

      if (cheapest) {
        cheapestByStops[stops] = formatVacationOffer(cheapest);
      }
    }

    results.push({
      vacation: schoolBreak.name,
      windowStart: schoolBreak.tripWindowStart,
      windowEnd: schoolBreak.tripWindowEnd,
      days: getTripWindowDays(schoolBreak),
      offers: sortedOffers
        .slice(0, 10)
        .map(formatVacationOffer),
      cheapestByStops,
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
        `${input.origin} -> ${input.destination} - no network, or ` +
        `Google is refusing requests; not just empty results.`
    );
  }

  return results;
}