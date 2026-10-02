import { getBookingUrl } from "./bookingLink.js";
import type { CabinClass } from "./duffel.js";
import type { NtfyViewAction } from "./ntfy.js";
import type { FormattedVacationOffer } from "./vacationFormatter.js";

export interface Candidate extends FormattedVacationOffer {
  /* Which school break (window) this offer was found for. */
  vacation: string;
}

export const CATEGORIES = [
  { stops: 0, label: "Nonstop" },
  { stops: 1, label: "1 stop" },
  { stops: 2, label: "2 stops" },
] as const;

export type BestByStops = Partial<Record<number, Candidate>>;

export interface LastSent {
  price: number;
  at: number;
}

export interface DigestPolicy {
  /* A category must be cheaper than last time by at least the larger of these. */
  minDropUsd: number;
  minDropPct: number;
  /* Never send two digests closer together than this. */
  cooldownMs: number;
  /* Send an "FYI, here's where things stand" digest at least this often. */
  refreshAfterMs: number;
}

export interface SendDecision {
  send: boolean;
  reason: string;
}

/*
 * The single cheapest candidate for each tracked outbound stop
 * count, across everything searched (every origin and every break).
 */
export function pickBestByStops(
  candidates: Candidate[]
): BestByStops {
  const best: BestByStops = {};

  for (const { stops } of CATEGORIES) {
    for (const candidate of candidates) {
      if (candidate.stops !== stops) {
        continue;
      }

      if (!Number.isFinite(candidate.priceAmount)) {
        continue;
      }

      const current = best[stops];

      if (!current || candidate.priceAmount < current.priceAmount) {
        best[stops] = candidate;
      }
    }
  }

  return best;
}

/*
 * Deliberately conservative: a digest goes out only when something
 * actually changed in a way worth interrupting for (or as an
 * occasional status refresh), never just because a cycle ran.
 */
export function shouldSendDigest(
  best: BestByStops,
  lastSent: Partial<Record<number, LastSent>>,
  now: number,
  policy: DigestPolicy
): SendDecision {
  const present = CATEGORIES.filter(
    ({ stops }) => best[stops] !== undefined
  );

  if (present.length === 0) {
    return { send: false, reason: "no flights found this cycle" };
  }

  const sentTimes = CATEGORIES.map(
    ({ stops }) => lastSent[stops]?.at
  ).filter((at): at is number => at !== undefined);

  if (sentTimes.length === 0) {
    return { send: true, reason: "first digest" };
  }

  const lastSentAt = Math.max(...sentTimes);

  if (now - lastSentAt < policy.cooldownMs) {
    return { send: false, reason: "within cooldown of the last digest" };
  }

  const drops: string[] = [];

  for (const { stops, label } of present) {
    const candidate = best[stops]!;
    const previous = lastSent[stops];

    if (!previous) {
      drops.push(`${label} newly available`);
      continue;
    }

    const drop = previous.price - candidate.priceAmount;
    const needed = Math.max(
      policy.minDropUsd,
      previous.price * policy.minDropPct
    );

    if (drop >= needed) {
      drops.push(`${label} down $${Math.round(drop)}`);
    }
  }

  if (drops.length > 0) {
    return { send: true, reason: drops.join(", ") };
  }

  if (now - lastSentAt >= policy.refreshAfterMs) {
    return { send: true, reason: "periodic status refresh" };
  }

  return { send: false, reason: "no meaningful change" };
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function shortDate(iso: string, withYear: boolean): string {
  const [year, month, day] = iso.split("-").map(Number);
  const base = `${MONTHS[month - 1]} ${day}`;
  return withYear ? `${base}, ${year}` : base;
}

export function formatDateRange(
  departure: string,
  ret: string
): string {
  const sameYear =
    departure.slice(0, 4) === ret.slice(0, 4);

  return sameYear
    ? `${shortDate(departure, false)} – ${shortDate(ret, true)}`
    : `${shortDate(departure, true)} – ${shortDate(ret, true)}`;
}

export function formatMoney(
  amount: number,
  currency: string
): string {
  const rounded = Math.round(amount).toLocaleString("en-US");
  return currency === "USD" ? `$${rounded}` : `${currency} ${rounded}`;
}

export interface FormattedDigest {
  title: string;
  message: string;
  click?: string;
  actions: NtfyViewAction[];
}

export function formatDigest(
  best: BestByStops,
  search: { adults: number; cabinClass: CabinClass }
): FormattedDigest {
  const titleParts: string[] = [];
  const blocks: string[] = [];
  const actions: NtfyViewAction[] = [];
  let click: string | undefined;
  let destination = "";

  for (const { stops, label } of CATEGORIES) {
    const candidate = best[stops];

    if (!candidate) {
      continue;
    }

    destination = candidate.destination;

    const money = formatMoney(
      candidate.priceAmount,
      candidate.currency
    );

    /*
     * Link to this exact trip, restricted to outbound flights with
     * at most this many stops - so the page opens on the kind of
     * flight the line above is quoting, at the same price.
     */
    const url = getBookingUrl(
      {
        origin: candidate.origin,
        destination: candidate.destination,
        departureDate: candidate.departureDate,
        returnDate: candidate.returnDate,
        adults: search.adults,
        cabinClass: search.cabinClass,
      },
      stops
    );

    titleParts.push(`${label} ${money}`);
    actions.push({ label: `${label} ${money}`, url });

    if (!click) {
      click = url;
    }

    const lines = [
      `${label.toUpperCase()}: ${money} round trip`,
      `${candidate.origin} ⇄ ${candidate.destination} · ${candidate.vacation}`,
      formatDateRange(candidate.departureDate, candidate.returnDate),
    ];

    if (candidate.layovers.length > 0) {
      lines.push(`Layover: ${candidate.layovers.join(", ")}`);
    }

    blocks.push(lines.join("\n"));
  }

  const footer =
    `Prices are per adult, round trip. Stops are for the outbound ` +
    `flight - Google doesn't show return-flight details until you ` +
    `pick an outbound. Tap a button to open that search.`;

  return {
    title: `Cheapest to ${destination}: ${titleParts.join(" · ")}`,
    message: `${blocks.join("\n\n")}\n\n${footer}`,
    click,
    actions,
  };
}
