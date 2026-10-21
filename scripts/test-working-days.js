import assert from 'assert';
import { addWorkingDays } from '../src/utils/workingDays.js';

console.log('--- Testing addWorkingDays Helper ---');

// Case 1: Payment on Friday (2026-10-23 15:00 IST), Mon-Sat working, 7 working days, no holidays
// Day 1: Sat Oct 24
// Sun Oct 25 skipped
// Day 2: Mon Oct 26
// Day 3: Tue Oct 27
// Day 4: Wed Oct 28
// Day 5: Thu Oct 29
// Day 6: Fri Oct 30
// Day 7: Sat Oct 31 -> Ends at 2026-10-31 23:59:59.999 IST = 2026-10-31 18:29:59.999 UTC
{
  const start = new Date('2026-10-23T09:30:00.000Z'); // Friday 15:00 IST
  const result = addWorkingDays(start, 7, {
    weekdays: '1,2,3,4,5,6',
    holidays: '',
    timeZone: 'Asia/Kolkata'
  });
  console.log('Case 1 (Friday payment):', result.toISOString());
  assert.strictEqual(result.toISOString(), '2026-10-31T18:29:59.999Z');
  console.log('  [PASS] Case 1 passed');
}

// Case 2: Payment on Saturday evening (2026-10-24 21:00 IST), Mon-Sat working, 3 working days
// Day 1: Sun Oct 25 (skipped)
// Day 1: Mon Oct 26
// Day 2: Tue Oct 27
// Day 3: Wed Oct 28 -> Ends at 2026-10-28 23:59:59.999 IST = 2026-10-28 18:29:59.999 UTC
{
  const start = new Date('2026-10-24T15:30:00.000Z'); // Saturday 21:00 IST
  const result = addWorkingDays(start, 3, {
    weekdays: '1,2,3,4,5,6',
    holidays: '',
    timeZone: 'Asia/Kolkata'
  });
  console.log('Case 2 (Saturday evening payment):', result.toISOString());
  assert.strictEqual(result.toISOString(), '2026-10-28T18:29:59.999Z');
  console.log('  [PASS] Case 2 passed');
}

// Case 3: Across a holiday (2026-10-26 is a holiday)
// Start: Friday Oct 23
// Day 1: Sat Oct 24
// Sun Oct 25 (skipped - Sunday)
// Mon Oct 26 (skipped - Holiday)
// Day 2: Tue Oct 27
// Day 3: Wed Oct 28
// Day 4: Thu Oct 29
// Day 5: Fri Oct 30
// Day 6: Sat Oct 31
// Sun Nov 01 (skipped - Sunday)
// Day 7: Mon Nov 02 -> Ends at 2026-11-02 23:59:59.999 IST = 2026-11-02 18:29:59.999 UTC
{
  const start = new Date('2026-10-23T09:30:00.000Z');
  const result = addWorkingDays(start, 7, {
    weekdays: '1,2,3,4,5,6',
    holidays: '2026-10-26',
    timeZone: 'Asia/Kolkata'
  });
  console.log('Case 3 (Across holiday):', result.toISOString());
  assert.strictEqual(result.toISOString(), '2026-11-02T18:29:59.999Z');
  console.log('  [PASS] Case 3 passed');
}

// Case 4: Across month end (Payment on 2026-01-30 Friday, 3 working days)
// Day 1: Sat Jan 31
// Sun Feb 01 (skipped - Sunday)
// Day 2: Mon Feb 02
// Day 3: Tue Feb 03 -> Ends at 2026-02-03 23:59:59.999 IST = 2026-02-03 18:29:59.999 UTC
{
  const start = new Date('2026-01-30T05:00:00.000Z');
  const result = addWorkingDays(start, 3, {
    weekdays: '1,2,3,4,5,6',
    holidays: '',
    timeZone: 'Asia/Kolkata'
  });
  console.log('Case 4 (Across month end):', result.toISOString());
  assert.strictEqual(result.toISOString(), '2026-02-03T18:29:59.999Z');
  console.log('  [PASS] Case 4 passed');
}

console.log('All addWorkingDays tests passed successfully!');
