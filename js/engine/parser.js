// Discover fields, sections, repeats, conditionals and page size in a sanitized template.
// Browser only (DOMParser).
import {
  PLACEHOLDER_RE,
  SECTIONS,
  STANDARD_ITEM_FIELDS,
  isReserved,
  inferSection,
  inferType,
  makeLabel,
  looksLikeReservedTypo,
} from './fields.js';

const PAGE_SIZES_MM = {
  a3: [297, 420],
  a4: [210, 297],
  a5: [148, 210],
  a6: [105, 148],
  b4: [250, 353],
  b5: [176, 250],
  letter: [215.9, 279.4],
  legal: [215.9, 355.6],
  ledger: [279.4, 431.8],
};
const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, q: 0.25 };

function lengthToMm(token) {
  const m = /^([\d.]+)(mm|cm|in|pt|pc|px|q)$/i.exec(token);
  return m ? parseFloat(m[1]) * UNIT_MM[m[2].toLowerCase()] : null;
}

/**
 * Read the page size from an `@page { size: ... }` rule. Returns mm. Default A4.
 * A width followed by "auto" returns autoHeight: true and heightMm: null.
 */
export function parsePageSize(css) {
  const result = { widthMm: 210, heightMm: 297, declared: false, label: 'A4' };
  const re = /@page\s*(?::[a-z]+\s*)?\{([^}]*)\}/gi;
  let m;
  let sizeValue = null;
  while ((m = re.exec(css || ''))) {
    const s = /(?:^|;|\s)size\s*:\s*([^;]+)/i.exec(m[1]);
    if (s) sizeValue = s[1].trim();
  }
  if (!sizeValue) return result;
  const tokens = sizeValue.toLowerCase().split(/\s+/);
  // "80mm auto": as wide as given, as long as the bill (measured when shown and printed).
  if (tokens.length === 2 && tokens[1] === 'auto') {
    const width = lengthToMm(tokens[0]);
    if (width !== null) return { widthMm: width, heightMm: null, autoHeight: true, declared: true, label: sizeValue };
  }
  let w = null;
  let h = null;
  let orientation = null;
  for (const t of tokens) {
    if (PAGE_SIZES_MM[t]) [w, h] = PAGE_SIZES_MM[t];
    else if (t === 'landscape' || t === 'portrait') orientation = t;
    else {
      const mm = lengthToMm(t);
      if (mm !== null) {
        if (w === null) w = mm;
        else h = mm;
      }
    }
  }
  if (w === null) return result;
  if (h === null) h = w;
  if (orientation === 'landscape' && w < h) [w, h] = [h, w];
  if (orientation === 'portrait' && w > h) [w, h] = [h, w];
  return { widthMm: w, heightMm: h, declared: true, label: sizeValue };
}

function collectPlaceholders(str, into) {
  if (!str || !str.includes('{{')) return;
  PLACEHOLDER_RE.lastIndex = 0;
  let m;
  while ((m = PLACEHOLDER_RE.exec(str))) into.add(m[1]);
}

/**
 * Parse a sanitized template.
 * @param {string} html sanitized template document
 * @param {object} meta template metadata (from sanitizeTemplate)
 */
export function parseTemplate(html, meta = {}) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const warnings = [];
  const names = new Set();
  const conditionals = new Set();
  const repeats = [];

  // Placeholders inside repeat blocks.
  doc.querySelectorAll('[data-repeat]').forEach((el) => {
    const key = el.getAttribute('data-repeat');
    if (key !== 'items') warnings.push(`data-repeat="${key}" is not supported; only "items" is.`);
    const inRow = new Set();
    collectPlaceholders(el.outerHTML, inRow);
    repeats.push({ key, fields: Array.from(inRow).filter((n) => n.startsWith('item.')) });
  });

  // All placeholders, anywhere (text, attributes, CSS).
  collectPlaceholders(doc.documentElement.outerHTML, names);

  // item.* outside any repeat block.
  const outside = doc.body.cloneNode(true);
  outside.querySelectorAll('[data-repeat]').forEach((el) => el.remove());
  const outsideNames = new Set();
  collectPlaceholders(outside.innerHTML, outsideNames);
  for (const n of outsideNames) {
    if (n.startsWith('item.')) warnings.push(`{{${n}}} is outside a data-repeat="items" block and will be empty.`);
  }

  doc.querySelectorAll('[data-if]').forEach((el) => {
    const n = (el.getAttribute('data-if') || '').trim().replace(/^!/, '');
    if (/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)?$/.test(n)) {
      conditionals.add(n);
      names.add(n);
    } else warnings.push(`data-if="${n}" is not a valid field name.`);
  });

  if (repeats.length) names.add('item.description');

  const fieldsMeta = meta.fields || {};
  const fields = [];
  const fieldMap = {};
  for (const name of names) {
    const reserved = isReserved(name, names);
    const typo = !reserved && looksLikeReservedTypo(name);
    if (typo) warnings.push(`{{${name}}} looks like a typo of the auto-calculated field {{${typo}}}.`);
    const m = fieldsMeta[name] || {};
    const field = {
      name,
      reserved,
      label: m.label || makeLabel(name),
      type: m.type || inferType(name),
      section: inferSection(name),
      default: m.default ?? '',
      placeholder: m.placeholder || '',
      order: m.order,
      isItem: name.startsWith('item.'),
    };
    fieldMap[name] = field;
    if (!reserved) fields.push(field);
  }
  for (const metaName of Object.keys(fieldsMeta)) {
    if (!names.has(metaName)) warnings.push(`template-meta mentions "${metaName}", which the template does not use.`);
  }

  // Order: explicit meta order list, then per-field order, then standard item order, then document order.
  const docOrder = Array.from(names);
  const orderList = meta.order || [];
  const rank = (f) => {
    const i = orderList.indexOf(f.name);
    if (i >= 0) return i;
    if (typeof f.order === 'number') return f.order;
    if (f.isItem) {
      const s = STANDARD_ITEM_FIELDS.indexOf(f.name.slice(5));
      if (s >= 0) return 1000 + s;
    }
    return 2000 + docOrder.indexOf(f.name);
  };
  fields.sort((a, b) => rank(a) - rank(b));

  const sections = SECTIONS.map((s) => ({ ...s, fields: fields.filter((f) => f.section === s.id) })).filter(
    (s) => s.fields.length,
  );

  // Recommendations.
  const recommendations = [];
  if (!names.has('grand_total')) recommendations.push('No {{grand_total}} found.');
  if (!repeats.length) recommendations.push('No data-repeat="items" block found, so the bill has no item rows.');
  if (repeats.length && !names.has('item.price')) recommendations.push('Item rows have no {{item.price}}.');

  const css = Array.from(doc.querySelectorAll('style'), (s) => s.textContent).join('\n');
  const pageSize = parsePageSize(css);

  return {
    name: meta.name || 'Untitled template',
    fields,
    fieldMap,
    sections,
    repeats,
    conditionals: Array.from(conditionals),
    reservedUsed: Array.from(names).filter((n) => fieldMap[n].reserved),
    pageSize,
    warnings,
    recommendations,
  };
}
