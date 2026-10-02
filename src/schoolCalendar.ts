export interface SchoolBreak {
  name: string;
  startDate: string;
  endDate: string;
  tripWindowStart: string;
  tripWindowEnd: string;
}

export const SCHOOL_BREAKS: SchoolBreak[] = [
  {
    name: "December Recess",
    startDate: "2026-12-24",
    endDate: "2026-12-31",
    tripWindowStart: "2026-12-19",
    tripWindowEnd: "2027-01-03",
  },
  {
    name: "Winter Recess",
    startDate: "2027-02-15",
    endDate: "2027-02-19",
    tripWindowStart: "2027-02-13",
    tripWindowEnd: "2027-02-21",
  },
  {
    name: "Spring Recess",
    startDate: "2027-04-19",
    endDate: "2027-04-23",
    tripWindowStart: "2027-04-17",
    tripWindowEnd: "2027-04-25",
  },
  {
    name: "Summer Break",
    startDate: "2027-06-28",
    endDate: "2027-09-01",
    tripWindowStart: "2027-06-28",
    tripWindowEnd: "2027-09-01",
  },
 ];

export function getSchoolBreaks(): SchoolBreak[] {
  return SCHOOL_BREAKS;
}
