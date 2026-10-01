import { setTimeout as delay } from "node:timers/promises";
import {
  searchSchoolVacationFlights,
  searchOpenJawFlights,
  type VacationFlightResult,
} from "./schoolFlightSearch.js";
import { searchFlights } from "./duffel.js";
import { sendNtfyNotification } from "./ntfy.js";
import { PriceHistoryStore } from "./priceHistoryStore.js";
import type { FormattedVacationOffer } from "./vacationFormatter.js";

const ORIGINS = ["BOS", "JFK", "EWR", "LGA"] as const;
const DESTINATION = "TLV";

const ADULTS = 1;
const CABIN_CLASS = "economy" as const;

const DIRECT_THRESHOLD_USD = 1300;
const CONNECTING_THRESHOLD_USD = 1000;

/*
 * The qualifying bar adapts over time instead of being pinned
 * forever to whatever price happened to be seen first: once
 * enough price history exists for a route+window, a price also has
 * to fall at or below this percentile of the last 90 days of
 * observed prices (see priceHistoryStore.ts).
 */
const BASELINE_PERCENTILE = 20;
const MIN_SAMPLES_FOR_PERCENTILE = 8;

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

const store = new PriceHistoryStore(
  "./data/vacation-price-history.json"
);

/*
 * Ordered origin pairs for open-jaw checks: depart one of the 4
 * origins, return into a DIFFERENT one. Kept as a supplementary,
 * lower-volume check (only the full vacation-window date pair per
 * break, no combinatorial date sampling - see
 * schoolFlightSearch.ts's searchOpenJawFlights).
 */
const OPEN_JAW_PAIRS: Array<{
  origin: string;
  returnAirport: string;
}> = [];

for (const origin of ORIGINS) {
  for (const returnAirport of ORIGINS) {
    if (origin !== returnAirport) {
      OPEN_JAW_PAIRS.push({ origin, returnAirport });
    }
  }
}

function getPrice(price: string): number {
  return Number(price.replace(/[^0-9.]/g, ""));
}

function formatDate(date: string): string {
  if (date === "Unknown") {
    return "Unknown";
  }

  const parsed = new Date(`${date}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    return date;
  }

  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function getCeiling(
  offer: Pick<FormattedVacationOffer, "type">
): number {
  return offer.type === "Direct"
    ? DIRECT_THRESHOLD_USD
    : CONNECTING_THRESHOLD_USD;
}

interface QueryParams {
  origin: string;
  departureDate: string;
  returnDate: string;
  openJawReturnAirport?: string;
}

/*
 * Real, working lever: google-flights-ts can price the same route
 * in a different currency (confirmed against its actual source -
 * the higher-level getFlights() silently drops this option, so
 * duffel.ts now calls the lower-level getFlightsFromFilter
 * directly to make it actually take effect). True point-of-sale
 * arbitrage (Google's `gl` country param) isn't reachable through
 * this library without patching it, so this is the smaller,
 * currency-only version of that idea - informational only, never
 * automated into the alert decision itself.
 *
 * Only called right before sending a notification (not on every
 * routine check) to avoid adding search volume to an already
 * rate-limit-sensitive scraper.
 */
async function getCheaperCurrencyNote(
  query: QueryParams,
  usdPrice: number
): Promise<string | null> {
  try {
    const eurOffers = await searchFlights({
      origin: query.origin,
      destination: DESTINATION,
      departureDate: query.departureDate,
      returnDate: query.returnDate,
      adults: ADULTS,
      cabinClass: CABIN_CLASS,
      openJawReturnAirport: query.openJawReturnAirport,
      currency: "EUR",
    });

    const cheapestEur = eurOffers[0];

    if (!cheapestEur) {
      return null;
    }

    const eurPrice = Number(cheapestEur.totalAmount);

    if (!Number.isFinite(eurPrice)) {
      return null;
    }

    return (
      `FYI - priced in EUR instead: ` +
      `${cheapestEur.totalCurrency} ${cheapestEur.totalAmount} ` +
      `(this alert used USD: $${usdPrice.toFixed(2)}). Currency ` +
      `pricing can differ - worth a manual check before booking.`
    );
  } catch (error) {
    /*
     * A failed currency check should never block the real
     * notification - this is a nice-to-have add-on, not a
     * dependency of the alert itself.
     */
    console.error(
      `[vacation-monitor] Currency comparison check failed: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );

    return null;
  }
}

/*
 * Shared qualify/notify decision, used by both the same-origin and
 * open-jaw checks. Records every observed price into the rolling
 * history (regardless of whether it qualifies) so the percentile
 * baseline reflects the true market, not just an already-cheap
 * sample.
 */
async function evaluateOffer(
  label: string,
  key: string,
  offer: FormattedVacationOffer,
  query: QueryParams
): Promise<void> {
  const price = getPrice(offer.price);

  store.recordObservation(key, price);

  const ceiling = getCeiling(offer);

  if (price > ceiling) {
    console.log(
      `[vacation-monitor] ${label}: ${offer.price} | ` +
        `${offer.type} | above the $${ceiling} ceiling`
    );

    return;
  }

  const percentile = store.getPercentile(
    key,
    BASELINE_PERCENTILE,
    MIN_SAMPLES_FOR_PERCENTILE
  );

  if (percentile !== undefined && price > percentile) {
    console.log(
      `[vacation-monitor] ${label}: ${offer.price} is under the ` +
        `$${ceiling} ceiling but above the rolling ` +
        `${BASELINE_PERCENTILE}th percentile ` +
        `($${percentile.toFixed(2)}) - not a notable deal yet.`
    );

    return;
  }

  const lastNotified = store.getLastNotifiedPrice(key);

  const isBootstrap =
    percentile === undefined && lastNotified === undefined;

  if (isBootstrap) {
    console.log(
      `[vacation-monitor] ${label}: ${offer.price} is the initial ` +
        `qualifying price. Not enough history yet to judge - no ` +
        `notification sent.`
    );

    return;
  }

  if (lastNotified !== undefined && price >= lastNotified) {
    console.log(
      `[vacation-monitor] ${label}: ${offer.price} is not lower ` +
        `than the last notified price ` +
        `($${lastNotified.toFixed(2)}).`
    );

    return;
  }

  const currencyNote = await getCheaperCurrencyNote(
    query,
    price
  );

  await sendNtfyNotification(
    `New low: ${label}`,
    [
      label,
      `${formatDate(offer.departureDate)} - ${formatDate(offer.returnDate)}`,
      `${offer.price}`,
      lastNotified !== undefined
        ? `Previous notified price: $${lastNotified.toFixed(2)}`
        : "First notification for this route",
      `${offer.type} (${offer.stops} stop(s))` +
        (offer.returnLegUnknown
          ? " - return leg details unavailable"
          : ""),
      offer.layovers.length > 0
        ? `Layovers: ${offer.layovers.join(", ")}`
        : "No layovers",
      `Book: ${offer.bookingLink}`,
      ...(currencyNote ? [currencyNote] : []),
    ].join("\n")
  );

  store.setLastNotifiedPrice(key, price);

  console.log(
    `[vacation-monitor] NEW LOW for ${label}: ${offer.price}`
  );
}

async function checkOrigin(origin: string): Promise<void> {
  console.log(
    `[vacation-monitor] Checking ${origin} -> ${DESTINATION} school vacations...`
  );

  let results: VacationFlightResult[];

  try {
    results = await searchSchoolVacationFlights({
      origin,
      destination: DESTINATION,
      adults: ADULTS,
      cabinClass: CABIN_CLASS,
    });
  } catch (error) {
    console.error(
      `[vacation-monitor] Search failed for ${origin} -> ${DESTINATION}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );

    return;
  }

  if (results.every((result) => result.offers.length === 0)) {
    console.log(
      `[vacation-monitor] No flights found for ${origin} -> ${DESTINATION}.`
    );

    return;
  }

  for (const windowResult of results) {
    const cheapest = windowResult.offers[0];

    if (!cheapest) {
      continue;
    }

    const key = [
      origin,
      DESTINATION,
      windowResult.vacation,
    ].join("::");

    await evaluateOffer(
      `${origin} -> ${DESTINATION} (${windowResult.vacation})`,
      key,
      cheapest,
      {
        origin,
        departureDate: cheapest.departureDate,
        returnDate:
          cheapest.returnDate !== "Unknown"
            ? cheapest.returnDate
            : windowResult.windowEnd,
      }
    );
  }
}

async function checkOpenJawPair(
  origin: string,
  returnAirport: string
): Promise<void> {
  let results;

  try {
    results = await searchOpenJawFlights(
      origin,
      DESTINATION,
      returnAirport,
      ADULTS,
      CABIN_CLASS
    );
  } catch (error) {
    console.error(
      `[vacation-monitor] Open-jaw search failed for ` +
        `${origin} -> ${DESTINATION} -> ${returnAirport}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );

    return;
  }

  for (const windowResult of results) {
    if (!windowResult.offer) {
      continue;
    }

    const key = [
      "openjaw",
      origin,
      DESTINATION,
      returnAirport,
      windowResult.vacation,
    ].join("::");

    await evaluateOffer(
      `${origin} -> ${DESTINATION} -> ${returnAirport} ` +
        `(${windowResult.vacation}, open-jaw)`,
      key,
      windowResult.offer,
      {
        origin,
        departureDate: windowResult.windowStart,
        returnDate: windowResult.windowEnd,
        openJawReturnAirport: returnAirport,
      }
    );
  }
}

async function runCheck(): Promise<void> {
  for (const origin of ORIGINS) {
    await checkOrigin(origin);

    /*
     * Brief pause between origins - four back-to-back origin
     * sweeps is already a lot of requests per cycle without
     * making it worse by firing them as fast as possible.
     */
    await delay(2000);
  }

  for (const pair of OPEN_JAW_PAIRS) {
    await checkOpenJawPair(pair.origin, pair.returnAirport);
    await delay(2000);
  }

  console.log("[vacation-monitor] Check complete.");
}

async function main(): Promise<void> {
  console.log(
    `Vacation flight monitor running ` +
      `(origins: ${ORIGINS.join(", ")}; ` +
      `open-jaw pairs: ${OPEN_JAW_PAIRS.length}; ` +
      `poll interval: ${CHECK_INTERVAL_MS / 60000} min)`
  );

  /*
   * A plain sequential loop rather than setInterval: setInterval
   * fires on a fixed clock regardless of whether the previous
   * cycle's scraping finished, so if one cycle runs long (very
   * plausible with live scraping across 4 origins + 12 open-jaw
   * pairs), two cycles could run concurrently against the same
   * shared store. Awaiting each cycle before scheduling the next
   * makes that impossible.
   */
  while (true) {
    try {
      await runCheck();
    } catch (error) {
      console.error(
        "[vacation-monitor] Check failed:",
        error
      );
    }

    console.log(
      `[vacation-monitor] Next check in ${CHECK_INTERVAL_MS / 60000} minutes.`
    );

    await delay(CHECK_INTERVAL_MS);
  }
}

main().catch((error) => {
  console.error("[vacation-monitor] Fatal error:", error);
  process.exit(1);
});
