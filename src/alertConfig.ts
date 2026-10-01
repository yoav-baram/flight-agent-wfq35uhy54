import { readFileSync } from "node:fs";
import * as z from "zod/v4";

const alertSchema = z.object({
  origin: z.string(),
  destination: z.string(),
  departureDate: z.string(),
  returnDate: z.string().optional(),
  adults: z.number().int().min(1).default(1),
  cabinClass: z
    .enum(["economy", "premium_economy", "business", "first"])
    .default("economy"),
  thresholdUsd: z.number().positive().optional(),
});

const alertsFileSchema = z.array(alertSchema);

export type AlertConfig = z.infer<typeof alertSchema>;

export function loadAlertConfigs(path: string): AlertConfig[] {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  return alertsFileSchema.parse(parsed);
}
