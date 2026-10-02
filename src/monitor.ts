import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  searchFlights,
  DuffelApiError,
  type FlightOffer,
} from "./duffel.js";

import {
  loadAlertConfigs,
  type AlertConfig,
} from "./alertConfig.js";

import { PriceHistoryStore } from "./priceHistoryStore.js";

import {
  sendNtfyNotification,
  NtfyApiError,
} from "./ntfy.js";

/*
 * Alert rules
 *
 * Direct round trip:
 *   notify below $1,300 (unless a route sets its own thresholdUsd)
 *
 * Connecting round trip:
 *   notify below $1,000 (unless a route sets its own thresholdUsd)
 *
 * The qualifying bar also adapts over time: once enough price
 * history exists for a route, a price additionally has to fall at
 * or below the 20th percentile of the last 90 days of observed
 * prices - see priceHistoryStore.ts. A fixed "must beat the
 * all-time low forever" rule would eventually stop alerting at all
 * if prices drift upward structurally over time.
 */

const DIRECT_THRESHOLD_USD = 1300;
const CONNECTING_THRESHOLD_USD = 1000;

const BASELINE_PERCENTILE = 20;
const MIN_SAMPLES_FOR_PERCENTILE = 8;

const DEFAULT_POLL_MINUTES = 30;

const ALERTS_CONFIG_PATH = path.join(
  process.cwd(),
  "alerts.config.json"
);

const PRICE_HISTORY_PATH = path.join(
  process.cwd(),
  "data",
  "price-history.json"
);

const store = new PriceHistoryStore(
  PRICE_HISTORY_PATH
);

function getPollIntervalMs(): number {
  const raw =
    process.env.PRICE_ALERT_POLL_MINUTES;

  const parsed = raw
    ? Number(raw)
    : NaN;

  const minutes =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_POLL_MINUTES;

  return minutes * 60 * 1000;
}

function isDirect(offer: FlightOffer): boolean {
  return (
    !offer.returnLegUnknown &&
    offer.slices.every(
      (slice) => slice.stops === 0
    )
  );
}

function getOfferThreshold(
  offer: FlightOffer,
  alert: AlertConfig
): number {
  if (alert.thresholdUsd !== undefined) {
    return alert.thresholdUsd;
  }

  return isDirect(offer)
    ? DIRECT_THRESHOLD_USD
    : CONNECTING_THRESHOLD_USD;
}

function getTotalStops(
  offer: FlightOffer
): number {
  return offer.slices.reduce(
    (total, slice) =>
      total + slice.stops,
    0
  );
}

function alertKey(alert: AlertConfig): string {
  return [
    alert.origin,
    alert.destination,
    alert.departureDate,
    alert.returnDate ?? "",
  ].join("::");
}

function formatAlertMessage(
  alert: AlertConfig,
  offer: FlightOffer
): string {
  const totalStops =
    getTotalStops(offer);

  const routeType =
    offer.returnLegUnknown
      ? `${totalStops} visible stop(s) - return leg unverified`
      : totalStops === 0
        ? "NONSTOP"
        : `${totalStops} total stop(s)`;

  const lines: string[] = [
    `${alert.origin} -> ${alert.destination}`,
    `Price: ${offer.totalAmount} ${offer.totalCurrency}`,
    `Route: ${routeType}`,
    `Dates: ${alert.departureDate}` +
      `${
        alert.returnDate
          ? ` -> ${alert.returnDate}`
          : ""
      }`,
    "",
  ];

  offer.slices.forEach(
    (slice, index) => {
      const legLabel =
        index === 0
          ? offer.returnLegUnknown
            ? "OUTBOUND (return leg details unavailable)"
            : "OUTBOUND"
          : "RETURN";

      const stopsLabel =
        slice.stops === 0
          ? "NONSTOP"
          : `${slice.stops} stop(s)`;

      lines.push(
        `${legLabel}: ${stopsLabel}` +
          `${
            slice.duration
              ? `, ${slice.duration}`
              : ""
          }`
      );

      for (
        let i = 0;
        i < slice.segments.length;
        i++
      ) {
        const segment =
          slice.segments[i];

        lines.push(
          `  ${
            segment.airline ??
            "Unknown airline"
          } ${
            segment.flightNumber ?? ""
          }`
        );

        lines.push(
          `  ${
            segment.departureAirport ??
            "?"
          } ${
            segment.departureTime ??
            "?"
          } -> ${
            segment.arrivalAirport ??
            "?"
          } ${
            segment.arrivalTime ??
            "?"
          }`
        );

        if (
          i < slice.layovers.length
        ) {
          lines.push(
            `  Layover: ${
              slice.layovers[i]
            }`
          );
        }
      }

      lines.push("");
    }
  );

  lines.push(
    `Book: ${offer.bookingUrl}`
  );

  return lines.join("\n");
}

async function checkAlert(
  alert: AlertConfig
): Promise<void> {
  let offers: FlightOffer[];

  try {
    offers =
      await searchFlights(alert);
  } catch (error) {
    const message =
      error instanceof DuffelApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);

    console.error(
      `[monitor] Search failed for ` +
        `${alert.origin}->${alert.destination}: ` +
        `${message}`
    );

    return;
  }

  if (offers.length === 0) {
    console.error(
      `[monitor] No flight results found for ` +
        `${alert.origin}->${alert.destination}.`
    );

    return;
  }

  /*
   * Find the cheapest offer that satisfies its appropriate
   * absolute ceiling. The rolling-percentile check happens
   * afterward, against price history keyed on the route/dates
   * only (not on a decode-flaky direct/connecting classification).
   */
  let cheapestQualifyingOffer:
    FlightOffer | undefined;

  let cheapestQualifyingPrice =
    Infinity;

  for (const offer of offers) {
    if (
      offer.totalCurrency !== "USD"
    ) {
      continue;
    }

    const price =
      Number(offer.totalAmount);

    if (
      !Number.isFinite(price)
    ) {
      continue;
    }

    const threshold =
      getOfferThreshold(offer, alert);

    if (price >= threshold) {
      continue;
    }

    if (
      price <
      cheapestQualifyingPrice
    ) {
      cheapestQualifyingPrice =
        price;

      cheapestQualifyingOffer =
        offer;
    }
  }

  if (!cheapestQualifyingOffer) {
    const cheapestOverall =
      offers[0];

    console.error(
      `[monitor] No qualifying price found ` +
        `for ${alert.origin}->${alert.destination}. ` +
        `Cheapest result: ` +
        `${cheapestOverall.totalAmount} ` +
        `${cheapestOverall.totalCurrency}, ` +
        `${
          getTotalStops(
            cheapestOverall
          )
        } stop(s).`
    );

    return;
  }

  const currentPrice =
    cheapestQualifyingPrice;

  const key = alertKey(alert);

  store.recordObservation(key, currentPrice);

  const percentile = store.getPercentile(
    key,
    BASELINE_PERCENTILE,
    MIN_SAMPLES_FOR_PERCENTILE
  );

  if (
    percentile !== undefined &&
    currentPrice > percentile
  ) {
    console.error(
      `[monitor] ${alert.origin}->${alert.destination}: ` +
        `$${currentPrice.toFixed(2)} is above the rolling ` +
        `${BASELINE_PERCENTILE}th percentile ` +
        `($${percentile.toFixed(2)}) - not a notable deal yet.`
    );

    return;
  }

  const lastNotified =
    store.getLastNotifiedPrice(key);

  const isBootstrap =
    percentile === undefined &&
    lastNotified === undefined;

  if (isBootstrap) {
    console.error(
      `[monitor] Baseline established for ` +
        `${alert.origin}->${alert.destination}: ` +
        `$${currentPrice.toFixed(2)} USD ` +
        `(${
          getTotalStops(
            cheapestQualifyingOffer
          )
        } stop(s)). Not enough history yet to judge - no ` +
        `notification sent.`
    );

    return;
  }

  if (
    lastNotified !== undefined &&
    currentPrice >= lastNotified
  ) {
    console.error(
      `[monitor] No new low for ` +
        `${alert.origin}->${alert.destination}: ` +
        `$${currentPrice.toFixed(2)} ` +
        `(last notified: $${lastNotified.toFixed(2)})`
    );

    return;
  }

  try {
    await sendNtfyNotification(
      `Price drop: ` +
        `${alert.origin} -> ` +
        `${alert.destination} - ` +
        `$${currentPrice.toFixed(2)}`,
      formatAlertMessage(
        alert,
        cheapestQualifyingOffer
      ),
      {
        click: cheapestQualifyingOffer.bookingUrl,
        actions: [
          {
            label: "Open flights",
            url: cheapestQualifyingOffer.bookingUrl,
          },
        ],
      }
    );

    store.setLastNotifiedPrice(
      key,
      currentPrice
    );

    console.error(
      `[monitor] PRICE DROP! ` +
        `${alert.origin}->${alert.destination}: ` +
        `$${currentPrice.toFixed(2)}` +
        `${
          lastNotified !== undefined
            ? ` (previous: $${lastNotified.toFixed(2)})`
            : ""
        }`
    );
  } catch (error) {
    const message =
      error instanceof NtfyApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);

    console.error(
      `[monitor] Notification failed: ${message}`
    );

    /*
     * Important:
     * We do NOT update the last-notified price here.
     *
     * That means if the notification failed,
     * the next poll can try again.
     */
  }
}

export async function runOnce(): Promise<void> {
  const alerts =
    loadAlertConfigs(
      ALERTS_CONFIG_PATH
    );

  for (const alert of alerts) {
    await checkAlert(alert);
  }
}

async function main(): Promise<void> {
  const pollIntervalMs =
    getPollIntervalMs();

  console.error(
    `Flight price monitor running ` +
      `(poll interval: ` +
      `${pollIntervalMs / 60000} min)`
  );

  while (true) {
    try {
      await runOnce();
    } catch (error) {
      /*
       * A single bad cycle (malformed config, a store write
       * failure, etc.) should not silently kill this otherwise
       * long-running process with no diagnostic at all.
       */
      console.error(
        "[monitor] Cycle failed:",
        error
      );
    }

    await delay(
      pollIntervalMs
    );
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) ===
    process.argv[1];

if (isMainModule) {
  main().catch((error) => {
    console.error(
      "[monitor] Fatal error:",
      error
    );

    process.exit(1);
  });
}
