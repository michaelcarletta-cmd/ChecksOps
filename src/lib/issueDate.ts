/**
 * Safe calendar-date helpers for check issue_date values.
 *
 * Postgres date columns often serialize as ISO timestamps
 * (`2026-08-20T00:00:00.000Z`). Splitting that string on "-" and calling
 * date-fns `format()` throws RangeError: Invalid time value and crashes the SPA.
 *
 * Display uses local midnight of the calendar date so YYYY-MM-DD does not
 * shift back a day in US timezones.
 */

import { format } from "date-fns";

const DISPLAY_FORMAT = "MMM d, yyyy";
const CALENDAR_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

export type IssueDateInput = string | Date | null | undefined;

const isValidDate = (value: Date): boolean => !Number.isNaN(value.getTime());

const localCalendarDate = (year: number, month: number, day: number): Date | null => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const local = new Date(year, month - 1, day);
  if (
    !isValidDate(local) ||
    local.getFullYear() !== year ||
    local.getMonth() !== month - 1 ||
    local.getDate() !== day
  ) {
    return null;
  }
  return local;
};

/** Parse an issue_date. Never throws. Returns null when missing or unusable. */
export function parseIssueDate(value: IssueDateInput): Date | null {
  try {
    if (value == null) return null;
    if (value instanceof Date) return isValidDate(value) ? value : null;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    const calendar = trimmed.match(CALENDAR_PREFIX);
    if (calendar) {
      return localCalendarDate(
        Number(calendar[1]),
        Number(calendar[2]),
        Number(calendar[3]),
      );
    }

    const fallback = new Date(trimmed);
    return isValidDate(fallback) ? fallback : null;
  } catch {
    return null;
  }
}

/**
 * Format an issue_date for Review / CCC / deposit UI.
 * Never throws. Returns `fallback` (default "—") when the value is missing or invalid.
 */
export function formatIssueDateDisplay(value: IssueDateInput, fallback = "—"): string {
  try {
    const parsed = parseIssueDate(value);
    if (!parsed) return fallback;
    return format(parsed, DISPLAY_FORMAT);
  } catch {
    return fallback;
  }
}
