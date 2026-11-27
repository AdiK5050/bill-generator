// Template library: built-in (read-only, shipped with the app) + user templates (IndexedDB).
// Every template, from every source, goes through loadTemplate (security pipeline) before use.
import { loadTemplate } from './engine/index.js';
import { listRecords, getRecord, putRecord, deleteRecord } from './storage.js';

export const BUILTINS = [
  { id: 'builtin:classic', file: 'templates/classic.html', name: 'Classic' },
  { id: 'builtin:modern', file: 'templates/modern.html', name: 'Modern' },
  { id: 'builtin:gst-invoice', file: 'templates/gst-invoice.html', name: 'GST Tax Invoice' },
  { id: 'builtin:thermal-receipt', file: 'templates/thermal-receipt.html', name: 'Thermal Receipt' },
];
export const DEFAULT_TEMPLATE_ID = BUILTINS[0].id;

const rawCache = new Map();
const loadedCache = new Map(); // key: id + updatedAt

export const isBuiltin = (id) => typeof id === 'string' && id.startsWith('builtin:');

async function builtinRaw(b) {
  if (!rawCache.has(b.id)) {
    const res = await fetch(b.file);
    if (!res.ok) throw new Error(`Could not load built-in template ${b.name}.`);
    rawCache.set(b.id, await res.text());
  }
  return rawCache.get(b.id);
}

/** List all templates as { id, name, builtin, updatedAt, version }. */
export async function listTemplates() {
  const user = (await listRecords('templates'))
    .map((t) => ({ id: t.id, name: t.name, builtin: false, updatedAt: t.updatedAt, version: t.meta?.version }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...BUILTINS.map((b) => ({ id: b.id, name: b.name, builtin: true, updatedAt: 0 })), ...user];
}

/** Raw (stored) HTML of a template. */
export async function getTemplateHtml(id) {
  const b = BUILTINS.find((x) => x.id === id);
  if (b) return builtinRaw(b);
  const rec = await getRecord('templates', id);
  if (!rec) throw new Error('Template not found.');
  return rec.html;
}

/** Load a template ready for use: { id, name, builtin, html, meta, report, parsed }. */
export async function getTemplate(id) {
  const b = BUILTINS.find((x) => x.id === id);
  let raw;
  let key;
  let name;
  if (b) {
    raw = await builtinRaw(b);
    key = id;
    name = b.name;
  } else {
    const rec = await getRecord('templates', id);
    if (!rec) throw new Error('Template not found.');
    // The stored HTML has no template-meta block (it is kept in rec.meta), so put it
    // back before loading. Without it, field defaults, labels and types are lost.
    raw = withMetaBlock(rec.html, rec.meta);
    key = `${id}@${rec.updatedAt}`;
    name = rec.name;
  }
  if (!loadedCache.has(key)) loadedCache.set(key, loadTemplate(raw));
  return { id, name, builtin: !!b, ...loadedCache.get(key) };
}

/**
 * Save a user template. Runs the pipeline and stores the sanitized HTML.
 * Returns { record, report, parsed } so the UI can show the validation report.
 */
export async function saveTemplate({ id, name, html }) {
  if (id && isBuiltin(id)) throw new Error('Built-in templates are read-only. Duplicate it to make changes.');
  const loaded = loadTemplate(html);
  const finalName = (name || loaded.meta.name || 'My template').trim().slice(0, 120);
  const existing = id ? await getRecord('templates', id) : null;
  const record = await putRecord('templates', {
    ...(existing || {}),
    id: id || undefined,
    name: finalName,
    html: loaded.html,
    // Keep the metadata block in the stored copy so downloads round-trip.
    meta: loaded.meta,
  });
  return { record, report: loaded.report, parsed: loaded.parsed };
}

/** Add the template-meta block back for download, so name and field settings survive a round trip. */
export function withMetaBlock(html, meta) {
  if (!meta || !Object.keys(meta).length) return html;
  const json = JSON.stringify(meta, null, 2).replace(/</g, '\\u003c');
  const block = `<script type="application/json" id="template-meta">\n${json}\n</script>`;
  return html.replace(/<head>/i, `<head>\n${block}`);
}

export async function getDownloadHtml(id) {
  if (isBuiltin(id)) return getTemplateHtml(id);
  const rec = await getRecord('templates', id);
  return withMetaBlock(rec.html, rec.meta);
}

export async function duplicateTemplate(id) {
  const src = await getTemplate(id);
  const html = isBuiltin(id) ? await getTemplateHtml(id) : await getDownloadHtml(id);
  return saveTemplate({ name: `${src.name} (copy)`, html });
}

export async function renameTemplate(id, name) {
  const rec = await getRecord('templates', id);
  if (!rec) throw new Error('Template not found.');
  return putRecord('templates', { ...rec, name: name.trim().slice(0, 120) || rec.name });
}

export async function removeTemplate(id) {
  if (isBuiltin(id)) throw new Error('Built-in templates cannot be deleted.');
  await deleteRecord('templates', id);
}
