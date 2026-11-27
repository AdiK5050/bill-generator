// Totals and reserved fields. Pure functions, no DOM.
import { toNumber, round2, formatCurrency, formatNumber, formatDate, amountToWords, DEFAULT_FORMAT } from './format.js';
import { inferType, TAX_PART_RATE } from './fields.js';

/**
 * Compute totals from raw form input.
 * @param {{values: Object<string,string>, items: Array<Object<string,string>>}} input raw values
 * @returns numeric results
 */
export function computeTotals(input) {
  const values = input.values || {};
  const items = (input.items || []).map((row, i) => {
    const price = toNumber(row.price);
    const qty = toNumber(row.qty);
    // A row with a price but no qty counts as qty 1; a row with neither has no total.
    const effectiveQty = qty === null ? (price === null ? null : 1) : qty;
    const total = price === null ? null : round2(price * effectiveQty);
    return { index: i + 1, price, qty, total };
  });
  const subtotal = round2(items.reduce((s, r) => s + (r.total || 0), 0));

  const taxParts = {};
  let tax = 0;
  const baseRate = toNumber(values.tax_rate);
  if (baseRate !== null) tax += round2((subtotal * baseRate) / 100);
  for (const [name, raw] of Object.entries(values)) {
    const m = TAX_PART_RATE.exec(name);
    if (!m) continue;
    const rate = toNumber(raw);
    const amount = rate === null ? null : round2((subtotal * rate) / 100);
    taxParts[`tax_${m[1]}_amount`] = amount;
    if (amount !== null) tax += amount;
  }
  tax = round2(tax);

  // _charges and _discount fields only change grand_total. They are never item rows.
  // _paid fields (e.g. advance_paid) do not change grand_total; they reduce balance_due.
  let charges = 0;
  let discounts = 0;
  let paid = 0;
  for (const [name, raw] of Object.entries(values)) {
    const n = toNumber(raw);
    if (n === null) continue;
    if (name.endsWith('_charges')) charges += n;
    else if (name.endsWith('_discount') || name === 'discount') discounts += n;
    else if (name.endsWith('_paid')) paid += n;
  }
  const grand = round2(subtotal + tax + charges - discounts);
  const balance = round2(grand - paid);
  return {
    items,
    subtotal,
    tax,
    taxParts,
    charges: round2(charges),
    discounts: round2(discounts),
    grand,
    paid: round2(paid),
    balance,
  };
}

/**
 * Turn raw input into display strings for the renderer.
 * @param {object} parsed result of parseTemplate (for field types); may be null
 * @param {object} input {values, items}
 * @param {object} fmt formatting options
 */
export function buildDisplayData(parsed, input, fmt = DEFAULT_FORMAT) {
  fmt = { ...DEFAULT_FORMAT, ...fmt };
  // Only fields the template actually uses count. Values typed for another template
  // (kept so switching back does not lose them) must not change this bill's totals.
  if (parsed && parsed.fieldMap) {
    const used = {};
    for (const [name, raw] of Object.entries(input.values || {})) {
      if (parsed.fieldMap[name]) used[name] = raw;
    }
    input = { ...input, values: used };
  }
  const totals = computeTotals(input);
  const typeOf = (name) => (parsed && parsed.fieldMap && parsed.fieldMap[name]?.type) || inferType(name);

  const show = (name, raw) => {
    if (raw === null || raw === undefined || raw === '') return '';
    switch (typeOf(name)) {
      case 'currency': {
        const n = toNumber(raw);
        return n === null ? String(raw) : formatCurrency(n, fmt);
      }
      case 'number': {
        const n = toNumber(raw);
        return n === null ? String(raw) : formatNumber(n, fmt);
      }
      case 'percent': {
        const n = toNumber(raw);
        return n === null ? String(raw) : formatNumber(n, fmt, 2);
      }
      case 'date':
        return formatDate(raw, fmt);
      default:
        return String(raw);
    }
  };

  const values = {};
  for (const [name, raw] of Object.entries(input.values || {})) values[name] = show(name, raw);

  const items = (input.items || []).map((row, i) => {
    const out = {};
    for (const [field, raw] of Object.entries(row)) out[field] = show(`item.${field}`, raw);
    const t = totals.items[i];
    out.index = String(i + 1);
    out.total = t.total === null ? '' : formatCurrency(t.total, fmt);
    return out;
  });

  const hasItems = totals.items.some((r) => r.total !== null);
  // Subtotal is shown whenever there is a total, including when only charges are set.
  values.subtotal = hasItems || totals.charges ? formatCurrency(totals.subtotal, fmt) : '';
  values.tax_amount = totals.tax ? formatCurrency(totals.tax, fmt) : '';
  for (const [name, amount] of Object.entries(totals.taxParts)) {
    values[name] = amount ? formatCurrency(amount, fmt) : '';
  }
  values.grand_total = hasItems || totals.charges ? formatCurrency(totals.grand, fmt) : '';
  values.total_in_words = values.grand_total ? amountToWords(totals.grand, fmt) : '';
  values.balance_due = values.grand_total ? formatCurrency(totals.balance, fmt) : '';

  return { values, items, totals };
}
