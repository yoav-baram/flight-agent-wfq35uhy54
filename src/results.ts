import http from "node:http";
import { URL } from "node:url";
import {
  searchFlights,
  type FlightOffer,
  type FlightSlice,
  type FlightSegment,
} from "./duffel.js";

/*
 * `Number(x) || 3000` would silently override PORT=0 (the standard
 * convention for "let the OS assign a free port") to 3000, since 0
 * is falsy. Only fall back when PORT is unset or not a valid number.
 */
const PORT =
  process.env.PORT !== undefined &&
  Number.isFinite(Number(process.env.PORT))
    ? Number(process.env.PORT)
    : 3000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderSegment(
  segment: FlightSegment
): string {
  const airline = escapeHtml(
    segment.airline ?? "Unknown airline"
  );

  const flightNumber = escapeHtml(
    segment.flightNumber ?? ""
  );

  const departureAirport = escapeHtml(
    segment.departureAirport ?? "?"
  );

  const arrivalAirport = escapeHtml(
    segment.arrivalAirport ?? "?"
  );

  const departureTime = escapeHtml(
    formatDateTime(segment.departureTime)
  );

  const arrivalTime = escapeHtml(
    formatDateTime(segment.arrivalTime)
  );

  const duration = escapeHtml(
    segment.duration ?? "Unknown"
  );

  return [
    '<div class="segment">',
    `<div class="airline">${airline}</div>`,
    `<div class="flight-number">${flightNumber}</div>`,
    `<div class="route">${departureAirport} -> ${arrivalAirport}</div>`,
    `<div class="times">${departureTime} -> ${arrivalTime}</div>`,
    `<div class="duration">Flight duration: ${duration}</div>`,
    "</div>",
  ].join("");
}

function renderSlice(
  slice: FlightSlice,
  label: string
): string {
  const stopsText =
    slice.stops === 0
      ? "NONSTOP"
      : `${slice.stops} STOP${
          slice.stops === 1 ? "" : "S"
        }`;

  const parts: string[] = [];

  parts.push('<div class="slice">');

  parts.push(
    `<div class="slice-header">` +
      `<h3>${escapeHtml(label)}</h3>` +
      `<span class="stops">${escapeHtml(
        stopsText
      )}</span>` +
      `</div>`
  );

  if (slice.duration) {
    parts.push(
      `<div class="slice-duration">` +
        `Total duration: ${escapeHtml(
          slice.duration
        )}` +
        `</div>`
    );
  }

  for (
    let i = 0;
    i < slice.segments.length;
    i++
  ) {
    parts.push(
      renderSegment(slice.segments[i])
    );

    if (i < slice.layovers.length) {
      parts.push(
        `<div class="layover">` +
          `Layover: ${escapeHtml(
            slice.layovers[i]
          )}` +
          `</div>`
      );
    }
  }

  parts.push("</div>");

  return parts.join("");
}

function renderOffer(
  offer: FlightOffer,
  index: number
): string {
  /*
   * google-flights-ts's decoder only ever reads the outbound leg's
   * raw data for a round trip - the return leg's flight details are
   * never decoded (though the total price it reports IS the correct
   * full round-trip fare). When that leaves us with only one slice,
   * say so explicitly rather than silently labeling incomplete data
   * as a normal one-way "Outbound".
   */
  const singleSliceLabel =
    offer.slices.length === 1
      ? "Outbound (return leg details unavailable)"
      : "Outbound";

  const slicesHtml = offer.slices
    .map((slice, sliceIndex) => {
      const label =
        sliceIndex === 0
          ? singleSliceLabel
          : "Return";

      return renderSlice(
        slice,
        label
      );
    })
    .join("");

  /*
   * offer.bookingUrl is already the best available link: an
   * airline's own prefilled search when we have a verified format
   * (currently just Delta), otherwise the verified-working Google
   * Flights results link. See bookingLink.ts - no airline exposes
   * a URL for one specific fare, so this is the honest ceiling.
   */
  const bookingButton = [
    '<a class="booking-button"',
    ` href="${escapeHtml(
      offer.bookingUrl
    )}"`,
    ' target="_blank"',
    ' rel="noopener noreferrer">',
    "Book flight",
    "</a>",
  ].join("");

  return [
    '<div class="offer">',

    '<div class="offer-top">',
    `<h2>${escapeHtml(
      offer.totalAmount
    )} ${escapeHtml(
      offer.totalCurrency
    )}</h2>`,
    `<span class="option">Option ${
      index + 1
    }</span>`,
    "</div>",

    `<div class="offer-id">Offer ID: ${escapeHtml(
      offer.id
    )}</div>`,

    slicesHtml,

    '<div class="booking-area">',
    bookingButton,
    "</div>",

    "</div>",
  ].join("");
}

function renderPage(
  origin: string,
  destination: string,
  departureDate: string,
  returnDate: string,
  adults: number,
  cabinClass: string,
  offers: FlightOffer[]
): string {
  const title =
    `${origin} -> ${destination} -> ${origin}`;

  const offerHtml =
    offers.length === 0
      ? [
          '<div class="empty">',
          "<h2>No flights found</h2>",
          "<p>Try different dates or another search.</p>",
          "</div>",
        ].join("")
      : offers
          .map((offer, index) =>
            renderOffer(offer, index)
          )
          .join("");

  return [
    "<!DOCTYPE html>",
    '<html lang="en">',

    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<title>${escapeHtml(title)}</title>`,

    "<style>",

    "* {",
    "  box-sizing: border-box;",
    "}",

    "body {",
    "  margin: 0;",
    "  padding: 30px;",
    "  font-family: Arial, Helvetica, sans-serif;",
    "  background: #f3f4f6;",
    "  color: #222;",
    "}",

    ".container {",
    "  max-width: 1000px;",
    "  margin: 0 auto;",
    "}",

    ".header {",
    "  background: white;",
    "  padding: 28px;",
    "  border-radius: 14px;",
    "  margin-bottom: 22px;",
    "  box-shadow: 0 2px 8px rgba(0,0,0,0.08);",
    "}",

    ".header h1 {",
    "  margin: 0 0 12px 0;",
    "  font-size: 28px;",
    "}",

    ".search-info {",
    "  color: #555;",
    "  margin: 6px 0;",
    "}",

    ".offer {",
    "  background: white;",
    "  padding: 24px;",
    "  border-radius: 14px;",
    "  margin-bottom: 20px;",
    "  box-shadow: 0 2px 8px rgba(0,0,0,0.08);",
    "}",

    ".offer-top {",
    "  display: flex;",
    "  justify-content: space-between;",
    "  align-items: center;",
    "  gap: 20px;",
    "}",

    ".offer h2 {",
    "  margin: 0;",
    "  font-size: 28px;",
    "}",

    ".option {",
    "  background: #eee;",
    "  padding: 7px 12px;",
    "  border-radius: 20px;",
    "  font-size: 13px;",
    "}",

    ".offer-id {",
    "  color: #888;",
    "  font-size: 11px;",
    "  margin-top: 8px;",
    "  word-break: break-all;",
    "}",

    ".slice {",
    "  border-top: 1px solid #ddd;",
    "  margin-top: 22px;",
    "  padding-top: 18px;",
    "}",

    ".slice-header {",
    "  display: flex;",
    "  justify-content: space-between;",
    "  align-items: center;",
    "}",

    ".slice-header h3 {",
    "  margin: 0;",
    "  font-size: 20px;",
    "}",

    ".stops {",
    "  font-size: 12px;",
    "  font-weight: bold;",
    "}",

    ".slice-duration {",
    "  color: #666;",
    "  margin-top: 7px;",
    "}",

    ".segment {",
    "  background: #f7f7f7;",
    "  border-radius: 10px;",
    "  padding: 15px;",
    "  margin-top: 12px;",
    "}",

    ".airline {",
    "  font-weight: bold;",
    "  font-size: 17px;",
    "}",

    ".flight-number {",
    "  color: #666;",
    "  margin-top: 3px;",
    "}",

    ".route {",
    "  font-size: 19px;",
    "  font-weight: bold;",
    "  margin-top: 12px;",
    "}",

    ".times {",
    "  margin-top: 5px;",
    "}",

    ".duration {",
    "  color: #666;",
    "  margin-top: 5px;",
    "}",

    ".layover {",
    "  background: #fff3cd;",
    "  border-radius: 8px;",
    "  padding: 10px 14px;",
    "  margin: 8px 0;",
    "  font-weight: bold;",
    "}",

    ".booking-area {",
    "  display: flex;",
    "  flex-wrap: wrap;",
    "  gap: 10px;",
    "  margin-top: 22px;",
    "}",

    ".booking-button {",
    "  display: inline-block;",
    "  padding: 13px 18px;",
    "  color: white;",
    "  text-decoration: none;",
    "  border-radius: 8px;",
    "  font-weight: bold;",
    "  background: #222;",
    "}",

    ".booking-button:hover {",
    "  opacity: 0.8;",
    "}",

    ".empty {",
    "  background: white;",
    "  padding: 30px;",
    "  border-radius: 14px;",
    "}",

    "@media (max-width: 600px) {",

    "  body {",
    "    padding: 15px;",
    "  }",

    "  .offer-top {",
    "    align-items: flex-start;",
    "  }",

    "  .offer h2 {",
    "    font-size: 23px;",
    "  }",

    "  .booking-area {",
    "    flex-direction: column;",
    "  }",

    "}",

    "</style>",
    "</head>",

    "<body>",
    '<div class="container">',

    '<div class="header">',

    `<h1>${escapeHtml(title)}</h1>`,

    `<div class="search-info">` +
      `Outbound: ${escapeHtml(
        departureDate
      )}` +
      `</div>`,

    `<div class="search-info">` +
      `Return: ${escapeHtml(
        returnDate
      )}` +
      `</div>`,

    `<div class="search-info">` +
      `Passengers: ${adults} | Cabin: ` +
      `${escapeHtml(cabinClass)}` +
      `</div>`,

    `<div class="search-info">` +
      `${offers.length} flight offers found` +
      `</div>`,

    "</div>",

    offerHtml,

    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}

function sendHtml(
  response: http.ServerResponse,
  statusCode: number,
  html: string
): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
  });

  response.end(html);
}

async function handleSearch(
  requestUrl: URL,
  response: http.ServerResponse
): Promise<void> {
  const origin =
    requestUrl.searchParams.get("origin");

  const destination =
    requestUrl.searchParams.get(
      "destination"
    );

  const departureDate =
    requestUrl.searchParams.get(
      "departureDate"
    );

  const returnDate =
    requestUrl.searchParams.get(
      "returnDate"
    );

  if (
    !origin ||
    !destination ||
    !departureDate ||
    !returnDate
  ) {
    sendHtml(
      response,
      400,
      [
        "<h1>Missing search parameters</h1>",
        "<p>Required parameters:</p>",
        "<ul>",
        "<li>origin</li>",
        "<li>destination</li>",
        "<li>departureDate</li>",
        "<li>returnDate</li>",
        "</ul>",
      ].join("")
    );

    return;
  }

  try {
    const adultsParam =
      requestUrl.searchParams.get(
        "adults"
      );

    const parsedAdults =
      adultsParam
        ? Number.parseInt(
            adultsParam,
            10
          )
        : 1;

    const adults =
      Number.isFinite(parsedAdults) &&
      parsedAdults > 0
        ? parsedAdults
        : 1;

    const cabinClass =
      requestUrl.searchParams.get(
        "cabinClass"
      ) ?? "economy";

    const offers = (
      await searchFlights({
        origin,
        destination,
        departureDate,
        returnDate,
        adults,
        cabinClass:
          cabinClass as
            | "economy"
            | "premium_economy"
            | "business"
            | "first",
      })
    ).slice(0, 20);

    const html = renderPage(
      origin,
      destination,
      departureDate,
      returnDate,
      adults,
      cabinClass,
      offers
    );

    sendHtml(
      response,
      200,
      html
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    sendHtml(
      response,
      500,
      [
        "<!DOCTYPE html>",
        "<html>",
        "<body>",
        "<h1>Flight search failed</h1>",
        `<p>${escapeHtml(
          message
        )}</p>`,
        "</body>",
        "</html>",
      ].join("")
    );
  }
}

const server = http.createServer(
  async (
    request,
    response
  ) => {
    try {
      const requestUrl =
        new URL(
          request.url ?? "/",
          `http://${
            request.headers.host ??
            "localhost"
          }`
        );

      if (
        requestUrl.pathname === "/"
      ) {
        sendHtml(
          response,
          200,
          [
            "<!DOCTYPE html>",
            "<html>",
            "<head>",
            "<title>Flight Search</title>",
            "</head>",
            "<body>",
            "<h1>Flight Search</h1>",
            "<p>" +
              "Use /search with origin, " +
              "destination, departureDate " +
              "and returnDate." +
              "</p>",
            "</body>",
            "</html>",
          ].join("")
        );

        return;
      }

      if (
        requestUrl.pathname ===
        "/search"
      ) {
        await handleSearch(
          requestUrl,
          response
        );

        return;
      }

      sendHtml(
        response,
        404,
        "<h1>404 - Not Found</h1>"
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      sendHtml(
        response,
        500,
        `<h1>Server error</h1>` +
          `<p>${escapeHtml(
            message
          )}</p>`
      );
    }
  }
);

server.listen(
  PORT,
  () => {
    console.error(
      `Flight results page running at ` +
        `http://localhost:${PORT}`
    );
  }
);