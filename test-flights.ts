import { searchFlights } from "./src/duffel.js";

async function main() {
  const results = await searchFlights({
    origin: "BOS",
    destination: "TLV",
    departureDate: "2026-11-20",
    returnDate: "2026-11-29",
    adults: 1,
    cabinClass: "economy",
  });

  console.dir(results.slice(0, 5), {
    depth: null,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
