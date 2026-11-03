// Date math for recurring tasks.
//
// All dates are plain 'YYYY-MM-DD' strings and all arithmetic is done in UTC,
// so daylight saving time can never shift a date.
//
// A "schedule" rule looks like:
//   { freq: 'daily',   every: 2,                  anchor: '2026-11-02' }  every 2nd day
//   { freq: 'weekly',  every: 1, weekdays: [1,4], anchor: '2026-11-02' }  Mon + Thu every week
//   { freq: 'monthly', every: 1, month_day: 15,   anchor: '2026-11-02' }  15th of each month
// `anchor` is the first date the rule can fire. weekdays: 0 = Sunday ... 6 = Saturday.
// month_day above a month's length (e.g. 31 in February) falls on the month's last day.

const DAY = 86400000;
const toMs = (ymd) => Date.parse(ymd + 'T00:00:00Z');
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);

export const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(toMs(s));
export const addDays = (ymd, n) => fromMs(toMs(ymd) + n * DAY);
export const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY); // b - a
export const weekday = (ymd) => new Date(toMs(ymd)).getUTCDay();
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

export function todayIn(timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

// First date the rule fires that is strictly after `after` (and not before the anchor).
export function nextOccurrence(rule, after) {
  const every = Math.max(1, rule.every | 0);
  const anchor = rule.anchor;
  const from = after < anchor ? addDays(anchor, -1) : after; // search starts the day after `from`

  if (rule.freq === 'daily') {
    const k = Math.floor(diffDays(anchor, from) / every) + 1;
    return addDays(anchor, Math.max(0, k) * every);
  }

  if (rule.freq === 'weekly') {
    const days = rule.weekdays || [];
    if (!days.length) return null;
    const weekStart = addDays(anchor, -weekday(anchor)); // Sunday of the anchor's week
    let d = addDays(from, 1);
    for (let i = 0; i < 7 * every + 7; i++, d = addDays(d, 1)) {
      const weekIdx = Math.floor(diffDays(weekStart, d) / 7);
      if (weekIdx % every === 0 && days.includes(weekday(d))) return d;
    }
    return null;
  }

  if (rule.freq === 'monthly') {
    const ay = +anchor.slice(0, 4), am = +anchor.slice(5, 7);
    for (let k = 0; k < 2400; k += every) {
      const total = am - 1 + k;
      const y = ay + Math.floor(total / 12), m = (total % 12) + 1;
      const dd = Math.min(rule.month_day || 1, daysInMonth(y, m));
      const cand = `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      if (cand > from && cand >= anchor) return cand;
    }
    return null;
  }
  return null;
}

// Human-readable description, e.g. "Every week on Mon, Thu".
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function describe(r) {
  if (r.mode === 'after_done') return `${r.interval_days} day${r.interval_days == 1 ? '' : 's'} after last done`;
  const n = r.every | 0;
  if (r.freq === 'daily') return n === 1 ? 'Every day' : `Every ${n} days`;
  if (r.freq === 'weekly') {
    const days = r.weekdays.map((d) => WD[d]).join(', ');
    return (n === 1 ? 'Every week' : `Every ${n} weeks`) + ' on ' + days;
  }
  if (r.freq === 'monthly') {
    const s = ordinal(r.month_day) + (r.month_day >= 29 ? ' (or the last day)' : '');
    return (n === 1 ? 'Every month' : `Every ${n} months`) + ' on the ' + s;
  }
  return '';
}
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
