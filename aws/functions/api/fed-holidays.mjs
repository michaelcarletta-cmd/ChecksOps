/**
 * US Federal Reserve bank holidays and banking days, computed from rules (no year list).
 *
 * The eleven Federal Reserve holidays: New Year's Day (Jan 1), Martin Luther King Jr. Day
 * (third Monday of January), Presidents Day (third Monday of February), Memorial Day (last
 * Monday of May), Juneteenth (Jun 19), Independence Day (Jul 4), Labor Day (first Monday of
 * September), Columbus Day (second Monday of October), Veterans Day (Nov 11), Thanksgiving
 * (fourth Thursday of November) and Christmas (Dec 25).
 *
 * Observed dates follow the Federal Reserve's rule: a holiday that falls on a Sunday is observed
 * the following Monday; a holiday that falls on a Saturday is not observed (the Friday before is
 * a banking day).
 *
 * Dates are calendar dates as 'YYYY-MM-DD' strings; callers decide the time zone (ACH banking
 * days are New York dates). Pure, no I/O.
 */

const DAY_MS = 86_400_000;

const pad = (n) => String(n).padStart(2, '0');
const ymd = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;
const utcDay = (year, month, day) => new Date(Date.UTC(year, month - 1, day)).getUTCDay();

/** The nth (1-based) weekday (0 = Sunday) of a month. */
function nthWeekday(year, month, weekday, n) {
  const first = utcDay(year, month, 1);
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

/** The last given weekday of a month. */
function lastWeekday(year, month, weekday) {
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = utcDay(year, month, lastDate);
  return lastDate - ((last - weekday + 7) % 7);
}

/** A fixed-date holiday as the Fed observes it: Sunday → Monday; Saturday → not observed (null). */
function observedFixed(year, month, day) {
  const weekday = utcDay(year, month, day);
  if (weekday === 6) return null;
  if (weekday === 0) {
    const next = new Date(Date.UTC(year, month - 1, day) + DAY_MS);
    return ymd(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  }
  return ymd(year, month, day);
}

const cache = new Map();

/** The observed Federal Reserve holidays of a calendar year, as a sorted array of 'YYYY-MM-DD'. */
export function fedHolidays(year) {
  if (!Number.isSafeInteger(year)) throw new TypeError('year must be an integer');
  if (cache.has(year)) return cache.get(year);
  const dates = [
    observedFixed(year, 1, 1),
    ymd(year, 1, nthWeekday(year, 1, 1, 3)),
    ymd(year, 2, nthWeekday(year, 2, 1, 3)),
    ymd(year, 5, lastWeekday(year, 5, 1)),
    observedFixed(year, 6, 19),
    observedFixed(year, 7, 4),
    ymd(year, 9, nthWeekday(year, 9, 1, 1)),
    ymd(year, 10, nthWeekday(year, 10, 1, 2)),
    observedFixed(year, 11, 11),
    ymd(year, 11, nthWeekday(year, 11, 4, 4)),
    observedFixed(year, 12, 25),
  ].filter(Boolean).sort();
  const frozen = Object.freeze(dates);
  cache.set(year, frozen);
  return frozen;
}

const parse = (date) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  if (!match) throw new TypeError(`not a YYYY-MM-DD date: ${date}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** True when the date is an observed Federal Reserve holiday. */
export function isFedHoliday(date) {
  const [year] = parse(date);
  return fedHolidays(year).includes(String(date));
}

/** True on a weekday that is not an observed Federal Reserve holiday. */
export function isBankingDay(date) {
  const [year, month, day] = parse(date);
  const weekday = utcDay(year, month, day);
  return weekday !== 0 && weekday !== 6 && !isFedHoliday(date);
}

/** The first banking day strictly after the date. */
export function nextBankingDay(date) {
  const [year, month, day] = parse(date);
  let t = Date.UTC(year, month - 1, day);
  for (let i = 0; i < 14; i += 1) {
    t += DAY_MS;
    const d = new Date(t);
    const candidate = ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    if (isBankingDay(candidate)) return candidate;
  }
  throw new Error(`no banking day within two weeks of ${date}`);
}
