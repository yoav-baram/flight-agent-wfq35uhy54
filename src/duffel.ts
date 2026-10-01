import {
  FlightData,
  Passengers,
  TFSData,
  getFlightsFromFilter,
} from "google-flights-ts";

import { getBookingUrl } from "./bookingLink.js";

export type CabinClass =
  | "economy"
  | "premium_economy"
  | "business"
  | "first";

export interface SearchFlightsInput {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults: number;
  cabinClass: CabinClass;
  /*
   * Open-jaw support: where the return leg lands. Defaults to
   * `origin` (a normal round trip) when omitted.
   */
  openJawReturnAirport?: string;
  /*
   * ISO 4217 currency code (e.g. "EUR"). Google Flights can price
   * the same route differently by currency/point-of-sale - this
   * lets a caller compare. Defaults to the library's own default
   * (USD) when omitted.
   */
  currency?: string;
}

export interface FlightSegment {
  airline: string | null;
  flightNumber: string | null;
  departureAirport: string | null;
  departureTime: string | null;
  arrivalAirport: string | null;
  arrivalTime: string | null;
  duration: string | null;
}

export interface FlightSlice {
  origin: string | null;
  destination: string | null;
  duration: string | null;
  stops: number;
  segments: FlightSegment[];
  layovers: string[];
}

export interface FlightOffer {
  id: string;
  totalAmount: string;
  totalCurrency: string;
  bookingUrl: string;
  slices: FlightSlice[];
  /*
   * google-flights-ts's decoder only ever reads the outbound leg's
   * raw itinerary data for a round trip - the return leg's flight
   * details are frequently never decoded at all, even though the
   * total PRICE above is still the correct full round-trip fare.
   * True whenever a round-trip search came back with fewer than 2
   * slices. Every consumer of `slices` for stop-count/direct-vs-
   * connecting classification should treat this as "unverified",
   * not "confirmed single leg".
   */
  returnLegUnknown: boolean;
}

/*
 * Kept with the old name temporarily so the rest of the project
 * does not need to be changed yet.
 */
export class DuffelApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "FlightSearchError";
    this.status = status;
  }
}

interface GoogleFlight {
  airline?: string;
  airline_name?: string;
  flight_number?: string;
  operator?: string;

  departure_airport?: string;
  arrival_airport?: string;

  departure_date?: [number, number, number];
  arrival_date?: [number, number, number];

  departure_time?: [number, number];
  arrival_time?: [number, number];

  travel_time?: number;
}

interface GoogleLayover {
  minutes?: number;
  departure_airport?: string;
}

interface GoogleItinerary {
  airline_code?: string;
  airline_names?: string[];

  flights?: GoogleFlight[];

  layovers?: GoogleLayover[];

  travel_time?: number;

  departure_airport?: string;
  arrival_airport?: string;

  departure_date?: [number, number, number];
  arrival_date?: [number, number, number];

  departure_time?: [number, number];
  arrival_time?: [number, number];

  itinerary_summary?: {
    flights?: string;
    price?: number;
    currency?: string;
  };
}

interface GoogleDecodedResult {
  best?: GoogleItinerary[];
  other?: GoogleItinerary[];
}

function mapCabinClass(
  cabinClass: CabinClass
): "economy" | "premium-economy" | "business" | "first" {
  switch (cabinClass) {
    case "premium_economy":
      return "premium-economy";

    case "business":
      return "business";

    case "first":
      return "first";

    case "economy":
    default:
      return "economy";
  }
}

function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) {
    return "unknown";
  }

  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const remainingMinutes = rounded % 60;

  if (hours === 0) {
    return `${remainingMinutes}m`;
  }

  if (remainingMinutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${remainingMinutes}m`;
}

function formatDateTime(
  date: [number, number, number] | undefined,
  time: [number, number] | undefined
): string | null {
  if (!date || !time) {
    return null;
  }

  const [year, month, day] = date;
  const [hour, minute] = time;

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null;
  }

  const pad = (value: number): string =>
    String(value).padStart(2, "0");

  /*
   * These are intentionally represented without a timezone.
   * Google Flights gives us local airport times, not UTC timestamps.
   */
  return (
    `${year}-${pad(month)}-${pad(day)}` +
    `T${pad(hour)}:${pad(minute)}`
  );
}

function mapSegment(
  flight: GoogleFlight
): FlightSegment {
  return {
    airline:
      flight.airline_name ??
      flight.airline ??
      null,

    flightNumber:
      flight.flight_number ?? null,

    departureAirport:
      flight.departure_airport ?? null,

    departureTime:
      formatDateTime(
        flight.departure_date,
        flight.departure_time
      ),

    arrivalAirport:
      flight.arrival_airport ?? null,

    arrivalTime:
      formatDateTime(
        flight.arrival_date,
        flight.arrival_time
      ),

    duration:
      typeof flight.travel_time === "number"
        ? formatDuration(flight.travel_time)
        : null,
  };
}

function calculateSliceDuration(
  flights: GoogleFlight[],
  layovers: GoogleLayover[]
): string {
  let totalMinutes = 0;

  for (const flight of flights) {
    if (
      typeof flight.travel_time === "number" &&
      Number.isFinite(flight.travel_time)
    ) {
      totalMinutes += flight.travel_time;
    }
  }

  for (const layover of layovers) {
    if (
      typeof layover.minutes === "number" &&
      Number.isFinite(layover.minutes)
    ) {
      totalMinutes += layover.minutes;
    }
  }

  return formatDuration(totalMinutes);
}

function mapSlice(
  flights: GoogleFlight[],
  layovers: GoogleLayover[]
): FlightSlice {
  const segments = flights.map(mapSegment);

  const firstSegment = segments[0];
  const lastSegment =
    segments[segments.length - 1];

  const mappedLayovers = layovers.map(
    (layover) =>
      typeof layover.minutes === "number"
        ? formatDuration(layover.minutes)
        : "unknown"
  );

  return {
    origin:
      firstSegment?.departureAirport ?? null,

    destination:
      lastSegment?.arrivalAirport ?? null,

    duration: calculateSliceDuration(
      flights,
      layovers
    ),

    stops: Math.max(flights.length - 1, 0),

    segments,

    layovers: mappedLayovers,
  };
}

function splitItineraryIntoSlices(
  itinerary: GoogleItinerary,
  input: SearchFlightsInput
): FlightSlice[] {
  const flights = itinerary.flights ?? [];
  const allLayovers = itinerary.layovers ?? [];

  if (flights.length === 0) {
    return [];
  }

  /*
   * One-way search is simple.
   */
  if (!input.returnDate) {
    return [
      mapSlice(
        flights,
        allLayovers
      ),
    ];
  }

  /*
   * Round-trip:
   *
   * Example:
   * BOS -> LHR -> TLV
   * TLV -> FRA -> BOS
   *
   * The return journey starts at the requested destination.
   */
  let returnStartIndex = -1;

  for (let i = 1; i < flights.length; i++) {
    if (
      flights[i]?.departure_airport ===
      input.destination
    ) {
      returnStartIndex = i;
      break;
    }
  }

  /*
   * If we cannot identify the return leg,
   * return the itinerary as one slice rather than
   * producing incorrect data.
   */
  if (returnStartIndex === -1) {
    return [
      mapSlice(
        flights,
        allLayovers
      ),
    ];
  }

  const outboundFlights = flights.slice(
    0,
    returnStartIndex
  );

  const returnFlights = flights.slice(
    returnStartIndex
  );

  /*
   * Layovers belong between flights within each slice.
   *
   * Outbound with N flights has N-1 layovers.
   */
  const outboundLayoverCount = Math.max(
    outboundFlights.length - 1,
    0
  );

  const outboundLayovers =
    allLayovers.slice(
      0,
      outboundLayoverCount
    );

  const returnLayovers =
    allLayovers.slice(
      outboundLayoverCount
    );

  const slices: FlightSlice[] = [];

  if (outboundFlights.length > 0) {
    slices.push(
      mapSlice(
        outboundFlights,
        outboundLayovers
      )
    );
  }

  if (returnFlights.length > 0) {
    slices.push(
      mapSlice(
        returnFlights,
        returnLayovers
      )
    );
  }

  return slices;
}

function makeOffer(
  itinerary: GoogleItinerary,
  index: number,
  input: SearchFlightsInput
): FlightOffer | null {
  const summary =
    itinerary.itinerary_summary;

  if (!summary) {
    return null;
  }

  if (
    typeof summary.price !== "number" ||
    !Number.isFinite(summary.price) ||
    summary.price <= 0
  ) {
    return null;
  }

  const slices =
    splitItineraryIntoSlices(
      itinerary,
      input
    );

  if (slices.length === 0) {
    return null;
  }

  const offerId = [
    "google",
    input.origin,
    input.destination,
    input.departureDate,
    input.returnDate ?? "one-way",
    String(index),
  ].join("-");

  return {
    id: offerId,

    totalAmount:
      summary.price.toFixed(2),

    totalCurrency:
      summary.currency ?? "USD",

    /*
     * Prefers a verified airline-specific search link (currently
     * just Delta) and falls back to the verified-working Google
     * Flights link. See bookingLink.ts for why nothing stronger
     * than a prefilled search is possible.
     */
    bookingUrl: getBookingUrl(
      { slices },
      input
    ),

    slices,

    returnLegUnknown:
      Boolean(input.returnDate) &&
      slices.length < 2,
  };
}

export async function searchFlights(
  input: SearchFlightsInput
): Promise<FlightOffer[]> {
  if (!input.origin) {
    throw new DuffelApiError(
      "Origin is required."
    );
  }

  if (!input.destination) {
    throw new DuffelApiError(
      "Destination is required."
    );
  }

  if (!input.departureDate) {
    throw new DuffelApiError(
      "Departure date is required."
    );
  }

  const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

  if (!DATE_FORMAT.test(input.departureDate)) {
    throw new DuffelApiError(
      "departureDate must be in YYYY-MM-DD format."
    );
  }

  if (
    input.returnDate &&
    !DATE_FORMAT.test(input.returnDate)
  ) {
    throw new DuffelApiError(
      "returnDate must be in YYYY-MM-DD format."
    );
  }

  /*
   * Compare as real dates, not strings - a plain string comparison
   * only happens to work for zero-padded YYYY-MM-DD input, which
   * isn't guaranteed for dates coming from an MCP client or the
   * results.ts HTTP query params (now validated above, but the
   * chronological check itself should not silently rely on string
   * ordering either).
   */
  if (
    input.returnDate &&
    new Date(input.returnDate).getTime() <
      new Date(input.departureDate).getTime()
  ) {
    throw new DuffelApiError(
      "Return date cannot be before departure date."
    );
  }

  if (
    !Number.isInteger(input.adults) ||
    input.adults < 1
  ) {
    throw new DuffelApiError(
      "Adults must be at least 1."
    );
  }

  const flightData = [
    new FlightData({
      date: input.departureDate,
      from_airport: input.origin,
      to_airport: input.destination,
    }),
  ];

  if (input.returnDate) {
    flightData.push(
      new FlightData({
        date: input.returnDate,
        from_airport: input.destination,
        to_airport:
          input.openJawReturnAirport ??
          input.origin,
      })
    );
  }

 const tfs = TFSData.fromInterface({
   flight_data: flightData,

   trip: input.returnDate
     ? "round-trip"
     : "one-way",

   passengers: new Passengers({
     adults: input.adults,
   }),

   seat: mapCabinClass(
     input.cabinClass
   ),
 });

 let result: unknown;

try {
  /*
   * Calling getFlightsFromFilter directly (rather than the
   * higher-level getFlights) because getFlights does not forward
   * a `currency` option through to the request at all - confirmed
   * against this library's own compiled source, not assumed.
   */
  result = await getFlightsFromFilter(tfs, {
      currency: input.currency,

      /*
       * Fallback gives the library a backup
       * fetching method if the normal request fails.
       */
mode: "fallback",

      /*
       * JS mode gives us the detailed structured
       * itinerary data we need:
       * flights, flight numbers, airports,
       * times, prices, and layovers.
       */
data_source: "js",
    });
  } catch (error) {
    throw new DuffelApiError(
      `Google Flights search failed: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
  }

  if (!result) {
    return [];
  }

  const decoded =
    result as GoogleDecodedResult;

  const itineraries = [
    ...(decoded.best ?? []),
    ...(decoded.other ?? []),
  ];

  const offers = itineraries
    .map(
      (itinerary, index) =>
        makeOffer(
          itinerary,
          index,
          input
        )
    )
    .filter(
      (
        offer
      ): offer is FlightOffer =>
        offer !== null
    );

  /*
   * Cheapest first.
   *
   * We only keep the cheapest 20 so the MCP
   * does not dump hundreds of results into Claude.
   */
  offers.sort(
    (a, b) =>
      parseFloat(a.totalAmount) -
      parseFloat(b.totalAmount)
  );

  return offers.slice(0, 20);
}