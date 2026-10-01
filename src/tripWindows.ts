import type { SchoolBreak } from "./schoolCalendar.js";

function daysBetweenInclusive(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  return Math.round(
    (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
  ) + 1;
}

export function getTripWindowDays(schoolBreak: SchoolBreak): number {
  return daysBetweenInclusive(
    schoolBreak.tripWindowStart,
    schoolBreak.tripWindowEnd
  );
}

export function isTripWindowLongEnough(
  schoolBreak: SchoolBreak,
  flightDurationHours: number
): boolean {
  const windowDays = getTripWindowDays(schoolBreak);

  if (flightDurationHours <= 6) {
    return windowDays > 4;
  }

  return windowDays > 8;
}
