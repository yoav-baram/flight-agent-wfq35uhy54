import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { DuffelApiError, searchFlights } from "./duffel.js";
import { searchSchoolVacationFlights } from "./schoolFlightSearch.js";
import { rankVacationFlights } from "./vacationRanking.js";

const server = new McpServer({
  name: "flight-price-tracker",
  version: "1.0.0",
});

server.registerTool(
  "search_flights",
  {
    description:
      "Search for flights and return current prices for a route and date range.",
    inputSchema: z.object({
      origin: z.string(),
      destination: z.string(),
      departureDate: z.string(),
      returnDate: z.string().optional(),
      adults: z.number().int().min(1).default(1),
      cabinClass: z
        .enum(["economy", "premium_economy", "business", "first"])
        .default("economy"),
    }),
  },
  async (input) => {
    try {
      const offers = (await searchFlights(input)).slice(0, 20);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ offers }, null, 2),
          },
        ],
      };
    } catch (error) {
      const message =
        error instanceof DuffelApiError
          ? `Flight search error: ${error.message}`
          : `Unexpected error searching flights: ${
              error instanceof Error ? error.message : String(error)
            }`;

      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "search_school_vacations",
  {
    description:
      "Search round-trip flights during eligible Newton Public Schools vacation windows. Automatically determines flight duration, applies the trip-length rule, searches multiple date combinations, and returns the five cheapest options with prices, stops, layovers, and Google Flights booking links.",
    inputSchema: z.object({
      origin: z.string(),
      destination: z.string(),
      adults: z.number().int().min(1).default(1),
      cabinClass: z
        .enum(["economy", "premium_economy", "business", "first"])
        .default("economy"),
    }),
  },
  async (input) => {
    try {
      const results = await searchSchoolVacationFlights(input);
      const ranked = rankVacationFlights(results, 5);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                route: `${input.origin} -> ${input.destination}`,
                results: ranked,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? `Vacation flight search error: ${error.message}`
          : `Unexpected error: ${String(error)}`;

      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  }
);

serveStdio(() => server).catch((error) => {
  console.error("Flight MCP server crashed:", error);
  process.exit(1);
});

console.error("Flight MCP server running");
