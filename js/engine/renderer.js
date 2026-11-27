// Fill a sanitized template with display data -> complete, safe HTML document string.
// Browser only (DOMParser). Values are always inserted as text, never as HTML.
import { PLACEHOLDER_RE } from './fields.js';
import { BILL_CSP, sanitizeCss, sanitizeInlineStyle, isSafeRenderedUrl } from './sanitizer.js';

const URL_ATTRS = new Set(['src', 'href', 'xlink:href']);

function lookup(name, values, row) {
  if (name.startsWith('item.')) {
    if (!row) return '';
    const v = row[name.slice(5)];
    return v === undefined || v === null ? '' : String(v);
  }
  const v = values[name];
  return v === undefined || v === null ? '' : String(v);
}

function replaceInString(str, values, row) {
  return str.replace(PLACEHOLDER_RE, (_, name) => lookup(name, values, row));
}

/** Replace placeholders inside a text node; newlines become <br>. */
function fillTextNode(node, values, row) {
  const text = node.nodeValue;
  if (!text.includes('{{')) return;
  const filled = replaceInString(text, values, row);
  if (!filled.includes('\n') || isInsidePre(node)) {
    node.nodeValue = filled;
    return;
  }
  const doc = node.ownerDocument;
  const frag = doc.createDocumentFragment();
  filled.split(/\r?\n/).forEach((line, i) => {
    if (i > 0) frag.appendChild(doc.createElement('br'));
    frag.appendChild(doc.createTextNode(line));
  });
  node.replaceWith(frag);
}

function isInsidePre(node) {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (el.tagName === 'PRE' || el.tagName === 'TEXTAREA') return true;
  }
  return false;
}

function fillAttributes(el, values, row) {
  for (const attr of Array.from(el.attributes)) {
    if (!attr.value.includes('{{')) continue;
    const name = attr.name.toLowerCase();
    const filled = replaceInString(attr.value, values, row);
    if (URL_ATTRS.has(name)) {
      if (filled && isSafeRenderedUrl(name, filled)) el.setAttribute(attr.name, filled);
      else el.removeAttribute(attr.name);
    } else if (name === 'style') {
      el.setAttribute('style', sanitizeInlineStyle(filled));
    } else {
      el.setAttribute(attr.name, filled);
    }
  }
}

/** Fill everything under root (inclusive), for one data row (or none). */
function fillTree(root, values, row) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  const texts = [];
  const elements = [];
  if (root.nodeType === 1) elements.push(root);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) texts.push(n);
    else elements.push(n);
  }
  elements.forEach((el) => fillAttributes(el, values, row));
  texts.forEach((t) => fillTextNode(t, values, row));
}

function hasValue(name, values, row) {
  return lookup(name.trim(), values, row).trim() !== '';
}

/** Remove data-if elements whose field is empty. Supports "!field" for "show when empty". */
function applyConditionals(root, values, row) {
  const els = Array.from(root.querySelectorAll('[data-if]'));
  if (root.nodeType === 1 && root.hasAttribute('data-if')) els.unshift(root);
  for (const el of els) {
    // Skip elements already removed with an ancestor. (Not isConnected: rows are filled
    // while they sit in a DocumentFragment, where nothing counts as connected.)
    if (el !== root && !root.contains(el)) continue;
    const expr = (el.getAttribute('data-if') || '').trim();
    // Rows handle their own item.* conditions.
    if (!row && expr.replace(/^!/, '').startsWith('item.')) continue;
    const negate = expr.startsWith('!');
    const ok = hasValue(expr.replace(/^!/, ''), values, row);
    if (ok === negate) el.remove();
    else el.removeAttribute('data-if');
  }
}

/**
 * Render a bill.
 * @param {string} templateHtml sanitized template document (from sanitizeTemplate)
 * @param {{values: object, items: Array<object>}} data display strings (from buildDisplayData)
 * @returns {string} complete HTML document with CSP
 */
export function renderBill(templateHtml, data) {
  const values = data.values || {};
  const items = data.items || [];
  const doc = new DOMParser().parseFromString(templateHtml, 'text/html');

  // Repeating blocks: clone per row, fill each clone with its row.
  for (const tpl of Array.from(doc.querySelectorAll('[data-repeat]'))) {
    if (!tpl.isConnected) continue;
    tpl.removeAttribute('data-repeat');
    const rows = items.length ? items : [];
    const frag = doc.createDocumentFragment();
    for (const row of rows) {
      const clone = tpl.cloneNode(true);
      // Nested repeats are not supported; strip their marker.
      clone.querySelectorAll('[data-repeat]').forEach((n) => n.removeAttribute('data-repeat'));
      frag.appendChild(clone);
      applyConditionals(clone, values, row);
      if (clone.isConnected || clone.parentNode) fillTree(clone, values, row);
    }
    tpl.replaceWith(frag);
  }

  applyConditionals(doc.body, values, null);
  fillTree(doc.body, values, null);

  // Placeholders in CSS (only meaningful inside custom properties).
  doc.querySelectorAll('style').forEach((s) => {
    const text = s.textContent || '';
    if (text.includes('{{')) s.textContent = sanitizeCss(replaceInString(text, values, null));
  });

  // Content Security Policy as the first thing in <head>.
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', BILL_CSP);
  doc.head.prepend(meta);

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}
