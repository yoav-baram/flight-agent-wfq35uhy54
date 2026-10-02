import {
  FlightData,
  Passengers,
  TFSData,
} from "google-flights-ts";

import type {
  CabinClass,
  SearchFlightsInput,
} from "./duffel.js";

export function mapCabinClass(
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

/*
 * Single place that turns a search into Google Flights' encoded
 * filter, used by BOTH the actual search (duffel.ts) and the
 * booking link (bookingLink.ts) so the two can never describe
 * different trips.
 *
 * maxOutboundStops restricts ONLY the outbound leg (confirmed in a
 * live browser: per-leg max_stops: 0 returns nonstop-only outbound
 * flights at the same round-trip prices as the unfiltered page).
 * The return leg is deliberately left unrestricted - the prices we
 * record are "outbound flight + cheapest return of any kind", so a
 * both-legs filter would show different (higher) prices than the
 * ones quoted in a notification.
 */
export function buildTfs(
  input: SearchFlightsInput,
  maxOutboundStops?: number
): TFSData {
  const flightData = [
    new FlightData({
      date: input.departureDate,
      from_airport: input.origin,
      to_airport: input.destination,
      max_stops: maxOutboundStops,
    }),
  ];

  if (input.returnDate) {
    flightData.push(
      new FlightData({
        date: input.returnDate,
        from_airport: input.destination,
        to_airport: input.origin,
      })
    );
  }

  return TFSData.fromInterface({
    flight_data: flightData,
    trip: input.returnDate ? "round-trip" : "one-way",
    passengers: new Passengers({ adults: input.adults }),
    seat: mapCabinClass(input.cabinClass),
  });
}
