/**
 * Working days calculation utility.
 *
 * Rules:
 * - Working days start from the NEXT day after the given date.
 * - Weekdays are checked in the specified timeZone (default: Asia/Kolkata).
 * - Default working days: 1,2,3,4,5,6 (Monday to Saturday; 0 = Sunday).
 * - Holidays: array or comma-separated string of 'YYYY-MM-DD' dates to skip.
 * - Result is the end of the N-th working day (23:59:59.999 in the specified timeZone).
 */

/**
 * Returns formatted { year, month, day, weekday } in the target timeZone.
 * Weekday: 0 (Sun) to 6 (Sat).
 */
const getPartsInTimeZone = (date, timeZone) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    weekday: weekdayMap[map.weekday],
    isoDateString: `${map.year}-${map.month}-${map.day}`
  };
};

const getTimezoneOffsetMinutes = (date, timeZone) => {
  const isoInTz = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).format(date);

  const [d, t] = isoInTz.split(', ');
  const [y, m, day] = d.split('-').map(Number);
  const [h, min, s] = t.split(':').map(Number);
  const asUtc = Date.UTC(y, m - 1, day, h, min, s);
  return (asUtc - date.getTime()) / 60000;
};

/**
 * Converts a specific date (year, month, day, 23, 59, 59, 999) in a timeZone to UTC Date.
 */
const getEndOfDayUtc = (year, month, day, timeZone) => {
  // Approximate noon UTC on that day to safely calculate the timezone offset
  const approxDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const offsetMinutes = getTimezoneOffsetMinutes(approxDate, timeZone);

  // 23:59:59.999 local in that timezone converted to UTC
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999) - offsetMinutes * 60000);
};

/**
 * Parses weekdays configuration.
 * e.g., '1,2,3,4,5,6' -> Set([1, 2, 3, 4, 5, 6])
 */
const parseWeekdays = (weekdaysConfig) => {
  if (Array.isArray(weekdaysConfig)) {
    return new Set(weekdaysConfig.map(Number));
  }
  if (typeof weekdaysConfig === 'string') {
    return new Set(
      weekdaysConfig
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(Number)
    );
  }
  return new Set([1, 2, 3, 4, 5, 6]); // Default Mon-Sat
};

/**
 * Parses holidays configuration.
 * e.g., '2026-10-24,2026-11-01' -> Set(['2026-10-24', '2026-11-01'])
 */
const parseHolidays = (holidaysConfig) => {
  if (Array.isArray(holidaysConfig)) {
    return new Set(holidaysConfig.map(h => String(h).trim()));
  }
  if (typeof holidaysConfig === 'string') {
    return new Set(
      holidaysConfig
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    );
  }
  return new Set();
};

/**
 * Adds N working days to date.
 *
 * @param {Date|string|number} startDate - Starting date
 * @param {number} n - Number of working days (e.g. 7)
 * @param {object} options
 * @param {string|number[]} [options.weekdays] - Working weekday numbers (0=Sun, 6=Sat)
 * @param {string|string[]} [options.holidays] - Array or comma-delimited list of YYYY-MM-DD
 * @param {string} [options.timeZone] - Timezone (default: Asia/Kolkata)
 * @returns {Date} End of the Nth working day in UTC Date
 */
export const addWorkingDays = (startDate, n = 7, options = {}) => {
  if (!startDate) {
    throw new Error('startDate is required for addWorkingDays');
  }

  const timeZone = options.timeZone || process.env.PAYMENT_TIMEZONE || 'Asia/Kolkata';
  const weekdays = parseWeekdays(options.weekdays !== undefined ? options.weekdays : (process.env.COMPANY_WORKING_WEEKDAYS || '1,2,3,4,5,6'));
  const holidays = parseHolidays(options.holidays !== undefined ? options.holidays : (process.env.COMPANY_HOLIDAYS || ''));

  const initialDate = new Date(startDate);
  if (isNaN(initialDate.getTime())) {
    throw new Error('Invalid startDate provided to addWorkingDays');
  }

  // Get start date in the target timezone
  let parts = getPartsInTimeZone(initialDate, timeZone);
  let currentYear = parts.year;
  let currentMonth = parts.month;
  let currentDay = parts.day;

  let workingDaysFound = 0;

  // We iterate day by day starting from the NEXT day
  while (workingDaysFound < n) {
    // Advance 1 day in calendar
    const nextCalDate = new Date(Date.UTC(currentYear, currentMonth - 1, currentDay + 1, 12, 0, 0));
    currentYear = nextCalDate.getUTCFullYear();
    currentMonth = nextCalDate.getUTCMonth() + 1;
    currentDay = nextCalDate.getUTCDate();

    // Check timezone parts for this next day
    const checkDate = new Date(Date.UTC(currentYear, currentMonth - 1, currentDay, 12, 0, 0));
    const dayParts = getPartsInTimeZone(checkDate, timeZone);

    const isWorkingWeekday = weekdays.has(dayParts.weekday);
    const isHoliday = holidays.has(dayParts.isoDateString);

    if (isWorkingWeekday && !isHoliday) {
      workingDaysFound++;
      if (workingDaysFound === n) {
        return getEndOfDayUtc(dayParts.year, dayParts.month, dayParts.day, timeZone);
      }
    }
  }

  return getEndOfDayUtc(currentYear, currentMonth, currentDay, timeZone);
};
