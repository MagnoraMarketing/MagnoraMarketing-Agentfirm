export type PeriodKey = "today" | "yesterday" | "7d" | "30d" | "this_month";
export const PERIOD_KEYS: PeriodKey[] = ["today", "yesterday", "7d", "30d", "this_month"];

export interface DateRange {
  /** Inclusive, YYYY-MM-DD in the report timezone. */
  startDate: string;
  /** Inclusive, YYYY-MM-DD in the report timezone. */
  endDate: string;
}

/** Calendar date (YYYY-MM-DD) of `now` in an IANA timezone. */
export function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000) + 1;
}

export function resolvePeriod(period: PeriodKey, now: Date, timeZone: string): DateRange {
  const today = localDate(now, timeZone);
  switch (period) {
    case "today":
      return { startDate: today, endDate: today };
    case "yesterday": {
      const y = shift(today, -1);
      return { startDate: y, endDate: y };
    }
    case "7d":
      return { startDate: shift(today, -6), endDate: today };
    case "30d":
      return { startDate: shift(today, -29), endDate: today };
    case "this_month":
      return { startDate: `${today.slice(0, 7)}-01`, endDate: today };
  }
}

/** The equally long range immediately before `range` (for period-over-period comparison). */
export function previousRange(range: DateRange): DateRange {
  const length = daysBetween(range.startDate, range.endDate);
  const endDate = shift(range.startDate, -1);
  return { startDate: shift(endDate, -(length - 1)), endDate };
}

export function isPeriodKey(value: unknown): value is PeriodKey {
  return typeof value === "string" && (PERIOD_KEYS as string[]).includes(value);
}
