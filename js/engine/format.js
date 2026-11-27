// Formatting helpers: currency, numbers, dates, amount in words.
// Pure functions, no DOM access.

export const DEFAULT_FORMAT = {
  locale: 'en-IN',
  currency: 'INR',
  dateFormat: 'DD/MM/YYYY',
  wordsStyle: 'indian', // 'indian' (lakh/crore) or 'international' (million/billion)
};

const fmtCache = new Map();
function getFormatter(key, make) {
  if (!fmtCache.has(key)) fmtCache.set(key, make());
  return fmtCache.get(key);
}

/** Parse user input into a number. Accepts "1,234.50", "₹ 99", "" -> null. */
export function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // Take the first number in the text, so prefixes like "Rs." or "₹" never add a decimal point.
  // (No regex lookbehind: older iOS Safari cannot parse it.)
  const text = String(value);
  const digits = /-?\d[\d,]*(?:\.\d*)?/.exec(text); // 1,234.50
  const dot = /(^|[^\w.])(-?\.\d+)/.exec(text); // .5, but not the dot in "Rs.5"
  let found = digits ? { at: digits.index, text: digits[0] } : null;
  if (dot) {
    const at = dot.index + dot[1].length;
    if (!found || at < found.at) found = { at, text: dot[2] };
  }
  if (!found) return null;
  const n = Number.parseFloat(found.text.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Round to 2 decimals without binary float surprises (1.005 -> 1.01). */
export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function formatCurrency(n, opts = DEFAULT_FORMAT) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  const { locale, currency } = { ...DEFAULT_FORMAT, ...opts };
  try {
    const f = getFormatter(
      `c|${locale}|${currency}`,
      () =>
        new Intl.NumberFormat(locale, {
          style: 'currency',
          currency,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
    );
    return f.format(n);
  } catch {
    return n.toFixed(2);
  }
}

export function formatNumber(n, opts = DEFAULT_FORMAT, maxFractionDigits = 3) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  const { locale } = { ...DEFAULT_FORMAT, ...opts };
  try {
    const f = getFormatter(
      `n|${locale}|${maxFractionDigits}`,
      () => new Intl.NumberFormat(locale, { maximumFractionDigits: maxFractionDigits }),
    );
    return f.format(n);
  } catch {
    return String(n);
  }
}

/**
 * Format an ISO date string (YYYY-MM-DD, as produced by <input type="date">)
 * using tokens DD, MM, YYYY, YY, MMM (short month name), MMMM (long month name).
 * Non-ISO input is returned unchanged.
 */
export function formatDate(iso, opts = DEFAULT_FORMAT) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  if (!m) return String(iso);
  const [, y, mo, d] = m;
  const { dateFormat, locale } = { ...DEFAULT_FORMAT, ...opts };
  const date = new Date(Date.UTC(+y, +mo - 1, +d));
  const monthName = (style) => {
    try {
      return new Intl.DateTimeFormat(locale, { month: style, timeZone: 'UTC' }).format(date);
    } catch {
      return mo;
    }
  };
  return dateFormat.replace(/YYYY|YY|MMMM|MMM|MM|DD/g, (tok) => {
    switch (tok) {
      case 'YYYY':
        return y;
      case 'YY':
        return y.slice(2);
      case 'MMMM':
        return monthName('long');
      case 'MMM':
        return monthName('short');
      case 'MM':
        return mo;
      case 'DD':
        return d;
      default:
        return tok;
    }
  });
}

/** Today's date as YYYY-MM-DD in local time. */
export function todayIso() {
  const now = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// ---------- Number to words ----------

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}

function below1000(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? ONES[h] + ' Hundred' : '', r ? below100(r) : ''].filter(Boolean).join(' ');
}

/** Integer to words. Indian: Lakh/Crore. International: Thousand/Million/Billion. */
export function integerToWords(n, style = 'indian') {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'Zero';
  const parts = [];
  if (style === 'indian') {
    const crore = Math.floor(n / 1e7);
    n %= 1e7;
    const lakh = Math.floor(n / 1e5);
    n %= 1e5;
    const thousand = Math.floor(n / 1000);
    n %= 1000;
    if (crore) parts.push(integerToWords(crore, 'indian') + ' Crore');
    if (lakh) parts.push(below100(lakh) + ' Lakh');
    if (thousand) parts.push(below100(thousand) + ' Thousand');
    if (n) parts.push(below1000(n));
  } else {
    const scales = [
      [1e12, 'Trillion'],
      [1e9, 'Billion'],
      [1e6, 'Million'],
      [1e3, 'Thousand'],
    ];
    for (const [value, name] of scales) {
      if (n >= value) {
        parts.push(below1000(Math.floor(n / value)) + ' ' + name);
        n %= value;
      }
    }
    if (n) parts.push(below1000(n));
  }
  return parts.join(' ');
}

const CURRENCY_WORDS = {
  INR: ['Rupee', 'Rupees', 'Paisa', 'Paise'],
  USD: ['Dollar', 'Dollars', 'Cent', 'Cents'],
  EUR: ['Euro', 'Euros', 'Cent', 'Cents'],
  GBP: ['Pound', 'Pounds', 'Penny', 'Pence'],
  AED: ['Dirham', 'Dirhams', 'Fils', 'Fils'],
  NPR: ['Rupee', 'Rupees', 'Paisa', 'Paise'],
  LKR: ['Rupee', 'Rupees', 'Cent', 'Cents'],
  PKR: ['Rupee', 'Rupees', 'Paisa', 'Paise'],
  BDT: ['Taka', 'Taka', 'Poisha', 'Poisha'],
};

/** Amount in words, e.g. 296500.5 -> "Two Lakh Ninety Six Thousand Five Hundred Rupees and Fifty Paise Only". */
export function amountToWords(amount, opts = DEFAULT_FORMAT) {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '';
  const { currency, wordsStyle } = { ...DEFAULT_FORMAT, ...opts };
  const negative = amount < 0;
  const total = Math.round(Math.abs(amount) * 100);
  const whole = Math.floor(total / 100);
  const fraction = total % 100;
  const names = CURRENCY_WORDS[currency] || [currency, currency, 'Cent', 'Cents'];
  let words = `${integerToWords(whole, wordsStyle)} ${whole === 1 ? names[0] : names[1]}`;
  if (fraction) words += ` and ${below100(fraction)} ${fraction === 1 ? names[2] : names[3]}`;
  return (negative ? 'Minus ' : '') + words + ' Only';
}
