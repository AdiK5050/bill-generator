// Field naming rules. Pure functions.

export const RESERVED = new Set([
  'item.total',
  'item.index',
  'subtotal',
  'tax_amount',
  'grand_total',
  'total_in_words',
  'balance_due',
]);

/** tax_<name>_amount is reserved when tax_<name>_rate exists; tested separately. */
export const TAX_PART_RATE = /^tax_([a-z0-9]+(?:_[a-z0-9]+)*)_rate$/;
export const TAX_PART_AMOUNT = /^tax_([a-z0-9]+(?:_[a-z0-9]+)*)_amount$/;

export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)\s*\}\}/g;
export const PLACEHOLDER_ONLY_RE = /^\s*\{\{\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)\s*\}\}\s*$/;

export const STANDARD_ITEM_FIELDS = ['description', 'hsn', 'qty', 'unit', 'price'];

export const SECTIONS = [
  { id: 'business', title: 'Business details' },
  { id: 'customer', title: 'Customer / Bill to' },
  { id: 'invoice', title: 'Invoice details' },
  { id: 'items', title: 'Items' },
  { id: 'tax', title: 'Tax' },
  { id: 'other', title: 'Other' },
];

export const FIELD_TYPES = ['text', 'textarea', 'date', 'tel', 'email', 'image', 'currency', 'number', 'percent'];

export function isReserved(name, allNames) {
  if (RESERVED.has(name)) return true;
  const m = TAX_PART_AMOUNT.exec(name);
  if (m && allNames && allNames.has(`tax_${m[1]}_rate`)) return true;
  return false;
}

export function inferSection(name) {
  if (name.startsWith('item.')) return 'items';
  if (name.startsWith('business_')) return 'business';
  if (name.startsWith('customer_')) return 'customer';
  if (name.startsWith('invoice_')) return 'invoice';
  if (name.startsWith('tax_')) return 'tax';
  return 'other';
}

export function inferType(name) {
  // A trailing number only tells similar fields apart: business_phone_2 is still a phone.
  const base = (name.startsWith('item.') ? name.slice(5) : name).replace(/_\d+$/, '');
  if (base === 'qty' || base === 'quantity') return 'number';
  if (base.endsWith('_date') || base === 'date') return 'date';
  if (/(^|_)(address|notes|terms)$/.test(base)) return 'textarea';
  if (/(^|_)phone$/.test(base)) return 'tel';
  if (/(^|_)email$/.test(base)) return 'email';
  if (/(^|_)(logo|image|signature)$/.test(base)) return 'image';
  if (base === 'tax_rate' || TAX_PART_RATE.test(base) || base.endsWith('_percent')) return 'percent';
  if (/price|amount|charge|rate|discount/.test(base) || /(^|_)paid$/.test(base)) return 'currency';
  return 'text';
}

/** customer_name -> "Customer name"; item.price -> "Price". */
export function makeLabel(name) {
  const base = name.startsWith('item.') ? name.slice(5) : name;
  const special = { qty: 'Qty', hsn: 'HSN/SAC', gstin: 'GSTIN' };
  if (special[base]) return special[base];
  const words = base
    .split('_')
    .filter(Boolean)
    .map((w) => special[w] || w.toLowerCase());
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Levenshtein distance, small strings only. */
export function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** Names that look like a typo of a reserved field, e.g. grand_totl. */
export function looksLikeReservedTypo(name) {
  if (RESERVED.has(name)) return null;
  for (const r of RESERVED) {
    const d = editDistance(name, r);
    if (d > 0 && d <= 2 && Math.abs(name.length - r.length) <= 2) return r;
  }
  return null;
}
