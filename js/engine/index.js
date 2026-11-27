// Public API of the reusable bill engine.
// No app UI dependencies. Requires DOMPurify as a global for sanitizeTemplate.
export { sanitizeTemplate, sanitizeCss, TemplateError, MAX_TEMPLATE_BYTES, BILL_CSP } from './sanitizer.js';
export { parseTemplate, parsePageSize } from './parser.js';
export { renderBill } from './renderer.js';
export { computeTotals, buildDisplayData } from './calc.js';
export * from './format.js';
export { SECTIONS, FIELD_TYPES, inferType, inferSection, makeLabel } from './fields.js';

import { sanitizeTemplate } from './sanitizer.js';
import { parseTemplate } from './parser.js';

/** Convenience: run the security pipeline and parse in one step. */
export function loadTemplate(rawHtml) {
  const safe = sanitizeTemplate(rawHtml);
  const parsed = parseTemplate(safe.html, safe.meta);
  return { ...safe, parsed };
}
