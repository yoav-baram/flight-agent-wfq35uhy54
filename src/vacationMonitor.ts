import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  searchSchoolVacationFlights,
  type VacationFlightResult,
} from "./schoolFlightSearch.js";
import { sendNtfyNotification } from "./ntfy.js";
import { PriceHistoryStore } from "./priceHistoryStore.js";
import { RateLimitedError } from "./duffel.js";
import {
  CATEGORIES,
  formatDigest,
  formatMoney,
  pickBestByStops,
  shouldSendDigest,
  type Candidate,
  type DigestPolicy,
  type LastSent,
} from "./digest.js";

const ORIGINS = ["BOS", "JFK", "EWR", "LGA"] as const;
const DESTINATION = "TLV";

const ADULTS = 1;
const CABIN_CLASS = "economy" as const;

const CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;

/*
 * --once: do a single check and exit (what the scheduled GitHub
 * workflow runs - it supplies the schedule itself).
 * --dry-run: search for real and print the digest that WOULD be
 * sent, without sending it or touching the saved state.
 */
const RUN_ONCE = process.argv.includes("--once");
const DRY_RUN = process.argv.includes("--dry-run");

/*
 * One digest notification carrying the cheapest nonstop, 1-stop and
 * 2-stop flight found across every origin and school break. It only
 * goes out when something meaningful changed - never just because a
 * cycle ran - so you get a handful of notifications, not dozens.
 */
const DIGEST_POLICY: DigestPolicy = {
  minDropUsd: 25,
  minDropPct: 0.03,
  cooldownMs: 6 * 60 * 60 * 1000,
  refreshAfterMs: 7 * 24 * 60 * 60 * 1000,
};

/*
 * The cheapest prices come from combining all origins, so a digest
 * built from a cycle where most origins failed (rate limiting) would
 * claim "cheapest" on partial data. Skip those cycles instead.
 */
const MIN_ORIGINS_FOR_DIGEST = 3;

/*
 * The "last digest sent" record. STATE_DIR lets a host with no
 * persistent disk (the GitHub runner) point this at a folder that is
 * saved between runs; locally it defaults to ./data.
 */
const store = new PriceHistoryStore(
  path.join(
    process.env.STATE_DIR ?? "./data",
    "vacation-digest-state.json"
  )
);

function digestKey(stops: number): string {
  return `digest::${stops}stops`;
}

function readLastSent(): Partial<Record<number, LastSent>> {
  const lastSent: Partial<Record<number, LastSent>> = {};

  for (const { stops } of CATEGORIES) {
    const price = store.getLastNotifiedPrice(digestKey(stops));
    const at = store.getLastNotifiedAt(digestKey(stops));

    if (price !== undefined && at !== undefined) {
      lastSent[stops] = { price, at };
    }
  }

  return lastSent;
}

function candidatesFrom(
  results: VacationFlightResult[]
): Candidate[] {
  return results.flatMap((windowResult) =>
    Object.values(windowResult.cheapestByStops).map(
      (offer) => ({ ...offer!, vacation: windowResult.vacation })
    )
  );
}

async function runCheck(): Promise<void> {
  const candidates: Candidate[] = [];
  let originsWithResults = 0;

  for (const origin of ORIGINS) {
    console.log(
      `[vacation-monitor] Checking ${origin} -> ${DESTINATION} school vacations...`
    );

    try {
      const results = await searchSchoolVacationFlights({
        origin,
        destination: DESTINATION,
        adults: ADULTS,
        cabinClass: CABIN_CLASS,
      });

      const found = candidatesFrom(results);

      if (found.length > 0) {
        originsWithResults++;
        candidates.push(...found);
      } else {
        console.log(
          `[vacation-monitor] No flights found for ${origin} -> ${DESTINATION}.`
        );
      }
    } catch (error) {
      console.error(
        `[vacation-monitor] Search failed for ${origin} -> ${DESTINATION}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );

      /*
       * Google is refusing us: stop the whole cycle now rather
       * than try the remaining origins into the same wall. The
       * breaker in duffel.ts keeps requests off the wire until
       * its backoff expires.
       */
      if (error instanceof RateLimitedError) {
        break;
      }
    }

    /*
     * Brief pause between origins - each origin is dozens of
     * requests, so don't fire them back to back.
     */
    await delay(2000);
  }

  if (originsWithResults < MIN_ORIGINS_FOR_DIGEST) {
    console.log(
      `[vacation-monitor] Only ${originsWithResults}/${ORIGINS.length} ` +
        `origins returned results - too incomplete to call anything ` +
        `"cheapest". No digest this cycle.`
    );

    return;
  }

  const best = pickBestByStops(candidates);

  for (const { stops, label } of CATEGORIES) {
    const candidate = best[stops];

    console.log(
      candidate
        ? `[vacation-monitor] Cheapest ${label}: ` +
            `${formatMoney(candidate.priceAmount, candidate.currency)} ` +
            `${candidate.origin}-${candidate.destination} ` +
            `(${candidate.vacation}, ${candidate.departureDate} to ${candidate.returnDate})`
        : `[vacation-monitor] Cheapest ${label}: none found`
    );
  }

  const now = Date.now();

  const decision = shouldSendDigest(
    best,
    readLastSent(),
    now,
    DIGEST_POLICY
  );

  console.log(
    `[vacation-monitor] Digest: ${
      decision.send ? "SENDING" : "not sending"
    } (${decision.reason})`
  );

  if (!decision.send) {
    return;
  }

  const digest = formatDigest(best, {
    adults: ADULTS,
    cabinClass: CABIN_CLASS,
  });

  if (DRY_RUN) {
    console.log(
      `\n===== DRY RUN - would send this notification =====\n` +
        `TITLE: ${digest.title}\n\n${digest.message}\n\n` +
        digest.actions
          .map((a) => `BUTTON "${a.label}": ${a.url}`)
          .join("\n") +
        `\n=================================================`
    );

    return;
  }

  await sendNtfyNotification(digest.title, digest.message, {
    click: digest.click,
    actions: digest.actions,
  });

  /*
   * Only record what was sent AFTER the notification succeeded, so
   * a failed send is retried next cycle instead of being silently
   * treated as delivered.
   */
  for (const { stops } of CATEGORIES) {
    const candidate = best[stops];

    if (candidate) {
      store.setLastNotifiedPrice(
        digestKey(stops),
        candidate.priceAmount,
        now
      );
    }
  }
}

async function main(): Promise<void> {
  /*
   * Fail immediately if the notification topic is missing, instead
   * of spending minutes searching and only then discovering there is
   * nowhere to send the result.
   */
  if (!DRY_RUN && !process.env.NTFY_TOPIC) {
    throw new Error(
      "NTFY_TOPIC is not set (add it to .env locally, or as a " +
        "repository secret on GitHub)."
    );
  }

  if (RUN_ONCE) {
    console.log(
      `Vacation flight monitor: single check (origins: ${ORIGINS.join(", ")})` +
        (DRY_RUN ? " [dry run]" : "")
    );

    await runCheck();
    return;
  }

  console.log(
    `Vacation flight monitor running ` +
      `(origins: ${ORIGINS.join(", ")}; ` +
      `poll interval: ${CHECK_INTERVAL_MS / 60000} min)`
  );

  /*
   * A plain sequential loop rather than setInterval: setInterval
   * fires on a fixed clock regardless of whether the previous
   * cycle's scraping finished, so a slow cycle could overlap the
   * next one. Awaiting each cycle before scheduling the next makes
   * that impossible.
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

main()
  .then(() => {
    if (RUN_ONCE) {
      process.exit(0);
    }
  })
  .catch((error) => {
    console.error("[vacation-monitor] Fatal error:", error);
    process.exit(1);
  });
