import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fedHolidays, isBankingDay, isFedHoliday, nextBankingDay } from '../functions/api/fed-holidays.mjs';

test('2026 observed Federal Reserve holidays, from the rules (Independence Day is a Saturday: not observed)', () => {
  assert.deepEqual([...fedHolidays(2026)], [
    '2026-01-01', // New Year's Day (Thursday)
    '2026-01-19', // MLK Day, third Monday of January
    '2026-02-16', // Presidents Day, third Monday of February
    '2026-05-25', // Memorial Day, last Monday of May
    '2026-06-19', // Juneteenth (Friday)
    '2026-09-07', // Labor Day, first Monday of September
    '2026-10-12', // Columbus Day, second Monday of October
    '2026-11-11', // Veterans Day (Wednesday)
    '2026-11-26', // Thanksgiving, fourth Thursday of November
    '2026-12-25', // Christmas (Friday)
  ]);
  assert.equal(isFedHoliday('2026-07-04'), false);
  assert.equal(isFedHoliday('2026-07-03'), false);
  assert.equal(isBankingDay('2026-07-03'), true);
});

test('2027: Sunday holidays move to Monday; Saturday holidays are not observed', () => {
  const h = fedHolidays(2027);
  assert.ok(h.includes('2027-07-05'), 'Independence Day (Sunday) observed Monday');
  assert.ok(!h.includes('2027-07-04'));
  assert.ok(!h.includes('2027-06-19') && !h.includes('2027-06-18'), 'Juneteenth (Saturday) not observed');
  assert.ok(!h.includes('2027-12-25') && !h.includes('2027-12-24'), 'Christmas (Saturday) not observed');
  assert.equal(h.length, 9);
  // New Year's Day 2028 is a Saturday: not observed, and 2027-12-31 stays a banking day.
  assert.ok(!fedHolidays(2028).includes('2028-01-01'));
  assert.equal(isBankingDay('2027-12-31'), true);
  // 2023: New Year's Day on a Sunday → Monday 2023-01-02.
  assert.ok(fedHolidays(2023).includes('2023-01-02'));
  // Leap-year February and a May with five Mondays.
  assert.equal(fedHolidays(2028).find((d) => d.startsWith('2028-05')), '2028-05-29');
  assert.equal(fedHolidays(2028).find((d) => d.startsWith('2028-02')), '2028-02-21');
});

test('banking days skip weekends and observed holidays', () => {
  assert.equal(isBankingDay('2026-11-14'), false); // Saturday
  assert.equal(isBankingDay('2026-11-15'), false); // Sunday
  assert.equal(isBankingDay('2026-11-26'), false); // Thanksgiving
  assert.equal(isBankingDay('2026-11-27'), true);
  assert.equal(nextBankingDay('2026-11-25'), '2026-11-27');
  assert.equal(nextBankingDay('2026-11-27'), '2026-11-30');
  assert.equal(nextBankingDay('2026-10-09'), '2026-10-13');
  assert.equal(nextBankingDay('2027-07-02'), '2027-07-06');
  assert.equal(nextBankingDay('2026-12-31'), '2027-01-04'); // Jan 1 Friday, then the weekend
  assert.throws(() => isBankingDay('11/26/2026'), TypeError);
});
