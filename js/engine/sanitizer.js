// Template security pipeline.
// Browser only: needs DOMParser, CSSStyleSheet and DOMPurify (loaded as a global from js/vendor/purify.min.js).
import { PLACEHOLDER_ONLY_RE } from './fields.js';

export const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;

/** CSP placed inside every rendered bill document. */
export const BILL_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

const FORBID_TAGS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'optgroup',
  'datalist',
  'base',
  'meta',
  'link',
  'style',
  'noscript',
  'audio',
  'video',
  'source',
  'track',
  'canvas',
  'dialog',
];
const URL_ATTRS = new Set([
  'src',
  'href',
  'xlink:href',
  'action',
  'formaction',
  'poster',
  'background',
  'cite',
  'longdesc',
  'ping',
  'data',
  'codebase',
  'manifest',
  'lowsrc',
  'dynsrc',
]);
const DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp|bmp|avif|svg\+xml)[;,]/i;

export class TemplateError extends Error {}

function purify() {
  const p = globalThis.DOMPurify;
  if (!p || !p.sanitize) throw new Error('DOMPurify is not loaded');
  return p;
}

/** True when an attribute URL value is allowed in a stored template. */
export function isSafeUrlValue(attr, value) {
  const v = String(value).trim();
  if (PLACEHOLDER_ONLY_RE.test(v)) return true;
  if (attr === 'href' && v.startsWith('#')) return true;
  return DATA_IMAGE_RE.test(v);
}

/** True when a rendered (filled-in) URL value is allowed. */
export function isSafeRenderedUrl(attr, value) {
  const v = String(value).trim();
  if (attr === 'href' && v.startsWith('#')) return true;
  return DATA_IMAGE_RE.test(v);
}

// ---------------- CSS ----------------

function valueIsSafe(value) {
  const v = String(value);
  // Every url(...) must be a data: URI.
  const urlRe = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
  let m;
  while ((m = urlRe.exec(v))) {
    if (!/^data:/i.test(m[2].trim())) return false;
  }
  // image-set() and similar accept bare strings as URLs.
  if (/image-set\(/i.test(v)) {
    const strRe = /image-set\(([^)]*)\)/gi;
    while ((m = strRe.exec(v))) {
      const strings = m[1].match(/(['"])(.*?)\1/g) || [];
      if (strings.some((s) => !/^['"]data:/i.test(s))) return false;
    }
  }
  if (/expression\s*\(|javascript:|-moz-binding|behavior\s*:/i.test(v)) return false;
  return true;
}

function cleanStyleDeclaration(style, removed) {
  if (!style) return;
  for (let i = style.length - 1; i >= 0; i--) {
    const prop = style[i];
    const val = style.getPropertyValue(prop);
    if (!valueIsSafe(val)) {
      removed.push(`CSS ${prop}: ${val.slice(0, 80)}`);
      // Also drop the shorthand it came from (e.g. background for background-image),
      // so the rest of the shorthand does not linger as "initial" longhands.
      const parts = prop.split('-');
      for (let n = 1; n < parts.length; n++) {
        const shorthand = parts.slice(0, n).join('-');
        if (shorthand && !valueIsSafe(style.getPropertyValue(shorthand))) style.removeProperty(shorthand);
      }
      style.removeProperty(prop);
      if (i > style.length) i = style.length;
    }
  }
}

function cleanRules(ruleList, removed) {
  for (let i = ruleList.length - 1; i >= 0; i--) {
    const rule = ruleList[i];
    const type = rule.constructor && rule.constructor.name;
    if (type === 'CSSImportRule' || type === 'CSSNamespaceRule') {
      removed.push(`CSS ${rule.cssText.slice(0, 80)}`);
      if (rule.parentRule) rule.parentRule.deleteRule(i);
      else rule.parentStyleSheet.deleteRule(i);
      continue;
    }
    if (rule.style) cleanStyleDeclaration(rule.style, removed);
    if (rule.cssRules) cleanRules(rule.cssRules, removed);
  }
}

// ---- Page size ----
// "size: 80mm auto" is not valid CSS, but templates may use it to ask for a page as long as
// the bill: the app measures the bill and sets the real height when it shows and prints it.
// The browser's CSS parser drops invalid declarations, so the marker is put back after parsing.
const CSS_LENGTH = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:mm|cm|in|pt|pc|px|q)';
export const AUTO_PAGE_SIZE_RE = new RegExp(`^(${CSS_LENGTH})\\s+auto$`, 'i');

/** size values declared in @page rules, as written: [{ plain, value }] (plain: no :first etc.). */
function rawPageSizes(css) {
  const out = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const pageRe = /@page\s*([^{]*)\{([^}]*)\}/gi;
  let m;
  while ((m = pageRe.exec(text))) {
    const sizeRe = /(?:^|[;\s])size\s*:\s*([^;]+)/gi;
    let s;
    while ((s = sizeRe.exec(m[2]))) {
      out.push({
        plain: !m[1].trim(),
        value: s[1]
          .trim()
          .replace(/\s*!important$/i, '')
          .replace(/\s+/g, ' '),
      });
    }
  }
  return out;
}

function isValidPageSize(value) {
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(`@page { size: ${value}; }`);
  } catch {
    return false;
  }
  const rule = sheet.cssRules[0];
  return Boolean(rule && rule.style && rule.style.getPropertyValue('size'));
}

/**
 * Sanitize a CSS string using the browser's own CSS parser, so escapes and odd syntax
 * cannot hide url() or @import. Returns cleaned CSS text.
 * warnings (optional) receives notes about page sizes the browser would ignore.
 */
export function sanitizeCss(css, removed = [], warnings = null) {
  if (!css || !css.trim()) return '';
  if (/@import/i.test(css)) removed.push('CSS @import');

  const sizes = rawPageSizes(css);
  const lastPlain = sizes.filter((s) => s.plain).pop();
  const autoWidth = lastPlain ? AUTO_PAGE_SIZE_RE.exec(lastPlain.value)?.[1] : null;
  if (warnings) {
    for (const s of sizes) {
      if (s.plain && AUTO_PAGE_SIZE_RE.test(s.value)) continue;
      if (isValidPageSize(s.value)) continue;
      warnings.push(
        `Page size "${s.value}" is not valid CSS, so browsers ignore it. Use a fixed size such as "A4" or "80mm 297mm", or a width followed by "auto" (for example "80mm auto") in a plain @page rule to make the page as long as the bill.`,
      );
    }
  }

  const sheet = new CSSStyleSheet();
  // replaceSync ignores @import rules by design.
  sheet.replaceSync(css);
  cleanRules(sheet.cssRules, removed);
  const rules = Array.from(sheet.cssRules, (r) => r.cssText);
  if (autoWidth) {
    // Built only from the matched length, so nothing else from the template is re-inserted.
    const marker = `size: ${autoWidth.toLowerCase()} auto;`;
    const i = Array.from(sheet.cssRules).findIndex((r) => r.constructor?.name === 'CSSPageRule' && !r.selectorText);
    if (i >= 0) rules[i] = rules[i].replace(/\bsize\s*:[^;}]*;?\s*/i, '').replace(/\{\s*/, `{ ${marker} `);
    else rules.push(`@page { ${marker} }`);
  }
  return rules.join('\n');
}

/** Sanitize the contents of a style="" attribute. */
export function sanitizeInlineStyle(text, removed = []) {
  if (!text || !text.trim()) return '';
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(`x{${text}}`);
  } catch {
    return '';
  }
  const rule = sheet.cssRules[0];
  if (!rule || !rule.style) return '';
  cleanStyleDeclaration(rule.style, removed);
  return rule.style.cssText;
}

// ---------------- Metadata ----------------

/** Pull the #template-meta JSON out of the raw HTML. Never executed, only JSON.parse'd. */
export function extractMeta(doc, report) {
  const el = doc.querySelector('script#template-meta');
  if (!el) return {};
  el.remove();
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type !== 'application/json') {
    report.warnings.push('template-meta must have type="application/json"; it was ignored.');
    return {};
  }
  try {
    const meta = JSON.parse(el.textContent || '{}');
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('not an object');
    return normalizeMeta(meta, report);
  } catch (e) {
    report.warnings.push(`template-meta is not valid JSON (${e.message}); it was ignored.`);
    return {};
  }
}

const FIELD_TYPES = new Set(['text', 'textarea', 'date', 'tel', 'email', 'image', 'currency', 'number', 'percent']);

function normalizeMeta(meta, report) {
  const out = {};
  if (typeof meta.name === 'string') out.name = meta.name.slice(0, 120);
  if (typeof meta.version === 'string' || typeof meta.version === 'number')
    out.version = String(meta.version).slice(0, 20);
  if (typeof meta.description === 'string') out.description = meta.description.slice(0, 500);
  if (Array.isArray(meta.order)) out.order = meta.order.filter((x) => typeof x === 'string');
  out.fields = {};
  if (meta.fields && typeof meta.fields === 'object') {
    for (const [name, def] of Object.entries(meta.fields)) {
      if (!def || typeof def !== 'object') continue;
      const f = {};
      if (typeof def.label === 'string') f.label = def.label.slice(0, 120);
      if (typeof def.placeholder === 'string') f.placeholder = def.placeholder.slice(0, 200);
      if (typeof def.default === 'string' || typeof def.default === 'number') f.default = String(def.default);
      if (typeof def.order === 'number') f.order = def.order;
      if (typeof def.type === 'string') {
        if (FIELD_TYPES.has(def.type)) f.type = def.type;
        else report.warnings.push(`Unknown type "${def.type}" for field ${name}; using the inferred type.`);
      }
      out.fields[name] = f;
    }
  }
  return out;
}

// ---------------- Main pipeline ----------------

/**
 * Run the full security pipeline on raw template HTML.
 * @param {string} rawHtml
 * @returns {{html: string, css: string, meta: object, report: object}}
 *   html is a complete, normalized, safe HTML document (without CSP; the renderer adds it).
 */
export function sanitizeTemplate(rawHtml) {
  if (typeof rawHtml !== 'string') throw new TemplateError('Template must be text.');
  const sizeBytes = new Blob([rawHtml]).size;
  if (sizeBytes > MAX_TEMPLATE_BYTES) {
    throw new TemplateError(
      `Template is ${(sizeBytes / 1048576).toFixed(1)} MB; the limit is ${MAX_TEMPLATE_BYTES / 1048576} MB.`,
    );
  }
  const report = { sizeBytes, removed: [], warnings: [] };

  // DOMParser builds an inert document: scripts do not run, images do not load.
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');

  // 1. Metadata
  const meta = extractMeta(doc, report);
  if (!meta.name) {
    const title = doc.querySelector('title')?.textContent?.trim();
    if (title) meta.name = title.slice(0, 120);
  }

  // 2. Collect CSS from every <style>, then remove them (re-added after cleaning).
  const cssParts = [];
  doc.querySelectorAll('style').forEach((s) => {
    cssParts.push(s.textContent || '');
    s.remove();
  });
  const cssRemoved = [];
  let css = '';
  try {
    css = sanitizeCss(cssParts.join('\n'), cssRemoved, report.warnings);
  } catch (e) {
    report.warnings.push(`CSS could not be parsed and was dropped (${e.message}).`);
  }
  report.removed.push(...cssRemoved);

  // 3. Sanitize body markup with DOMPurify.
  const DOMPurify = purify();
  const attrRemoved = [];
  const hook = (node, data) => {
    const name = data.attrName;
    if (name === 'style') {
      const before = data.attrValue;
      data.attrValue = sanitizeInlineStyle(before, attrRemoved);
      return;
    }
    if (name === 'srcset' || name.startsWith('on')) {
      attrRemoved.push(`${node.nodeName.toLowerCase()}[${name}]`);
      data.keepAttr = false;
      return;
    }
    if (URL_ATTRS.has(name) && !isSafeUrlValue(name, data.attrValue)) {
      attrRemoved.push(`${node.nodeName.toLowerCase()}[${name}="${String(data.attrValue).slice(0, 60)}"]`);
      data.keepAttr = false;
    }
  };
  DOMPurify.removeAllHooks();
  DOMPurify.addHook('uponSanitizeAttribute', hook);
  let bodyHtml;
  try {
    bodyHtml = DOMPurify.sanitize(doc.body ? doc.body.innerHTML : '', {
      FORBID_TAGS,
      FORBID_ATTR: ['srcset', 'ping', 'formaction', 'action'],
      ALLOW_DATA_ATTR: true,
      ALLOW_UNKNOWN_PROTOCOLS: false,
      WHOLE_DOCUMENT: false,
      KEEP_CONTENT: true,
    });
    for (const r of DOMPurify.removed || []) {
      if (r.element) {
        const n = r.element.nodeName ? r.element.nodeName.toLowerCase() : 'element';
        if (n !== '#text' && n !== '#comment') report.removed.push(`<${n}>`);
      } else if (r.attribute) {
        report.removed.push(`${r.from?.nodeName?.toLowerCase() || ''}[${r.attribute.name}]`);
      }
    }
  } finally {
    DOMPurify.removeAllHooks();
  }
  report.removed.push(...attrRemoved);
  report.removed = dedupeCount(report.removed);

  // 4. Keep only harmless attributes from <html> and <body>.
  const lang = /^[A-Za-z-]{1,20}$/.test(doc.documentElement.getAttribute('lang') || '')
    ? doc.documentElement.getAttribute('lang')
    : 'en';
  const bodyClass = (doc.body?.getAttribute('class') || '').replace(/[^\w\s-]/g, '');
  const bodyStyle = sanitizeInlineStyle(doc.body?.getAttribute('style') || '', []);

  const html = [
    '<!DOCTYPE html>',
    `<html lang="${lang}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<style>\n${css}\n</style>`,
    '</head>',
    `<body${bodyClass ? ` class="${bodyClass}"` : ''}${bodyStyle ? ` style="${escapeAttr(bodyStyle)}"` : ''}>`,
    bodyHtml,
    '</body>',
    '</html>',
  ].join('\n');

  return { html, css, meta, report };
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function dedupeCount(list) {
  const counts = new Map();
  for (const x of list) counts.set(x, (counts.get(x) || 0) + 1);
  return Array.from(counts, ([k, n]) => (n > 1 ? `${k} (x${n})` : k));
}
