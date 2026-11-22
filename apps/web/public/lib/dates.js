const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value) {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function addDays(date, amount) {
  if (!isValidIsoDate(date) || !Number.isInteger(amount)) {
    throw new TypeError('日期或天数无效');
  }
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}

export function businessDate(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function weekDates(startDate, count = 7) {
  if (!isValidIsoDate(startDate) || !Number.isInteger(count) || count < 1 || count > 7) {
    throw new TypeError('七天日期范围无效');
  }
  return Array.from({ length: count }, (_, index) => addDays(startDate, index));
}

export function formatChineseDate(date, options = {}) {
  if (!isValidIsoDate(date)) {
    return date;
  }
  const { weekday, ...otherOptions } = options;
  const normalizedWeekday = weekday === true ? 'long' : weekday;
  return new Intl.DateTimeFormat('zh-CN', {
    ...otherOptions,
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    ...(normalizedWeekday ? { weekday: normalizedWeekday } : {}),
  }).format(new Date(`${date}T12:00:00.000Z`));
}

export function formatChineseWeekday(date) {
  if (!isValidIsoDate(date)) {
    return '';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'UTC',
    weekday: 'short',
  }).format(new Date(`${date}T12:00:00.000Z`));
}

export function describeChildAge(child) {
  if (Number.isInteger(child?.ageMonths)) {
    return `${child.ageMonths} 月龄`;
  }
  return '月龄未记录';
}
