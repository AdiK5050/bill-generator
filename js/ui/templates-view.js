// Template library and in-app HTML editor.
import { h, toast, confirmDialog, promptDialog, downloadFile, pickFile, slugify, dialog, debounce } from './dom.js';
import { Preview } from './preview.js';
import {
  listTemplates,
  getTemplate,
  getDownloadHtml,
  duplicateTemplate,
  renameTemplate,
  removeTemplate,
  saveTemplate,
  isBuiltin,
  getTemplateHtml,
} from '../library.js';
import { loadTemplate, buildDisplayData, renderBill, TemplateError, MAX_TEMPLATE_BYTES } from '../engine/index.js';
import { getSettings, getProfile } from '../settings.js';

let root;
let hooks;

export function initTemplatesView(el, { onUse, onLibraryChanged }) {
  root = el;
  hooks = { onUse, onLibraryChanged };
  return renderLibrary();
}

export async function renderLibrary() {
  const list = await listTemplates();
  const grid = h('div', { class: 'card-grid' });
  for (const t of list) grid.append(templateCard(t));
  root.replaceChildren(
    h(
      'div',
      { class: 'view-head' },
      h('h2', { text: 'Templates' }),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn', text: 'Upload .html', onclick: uploadTemplate }),
      h('button', {
        type: 'button',
        class: 'btn primary',
        text: 'New from Classic',
        onclick: () => openEditor(null, 'builtin:classic'),
      }),
    ),
    h(
      'p',
      { class: 'hint' },
      'Built-in templates are read-only. Duplicate one to make your own copy. Templates follow the rules in ',
      h('a', { href: 'docs/TEMPLATE_GUIDE.md', target: '_blank', rel: 'noopener', text: 'the template guide' }),
      '.',
    ),
    grid,
  );
}

function templateCard(t) {
  const actions = [
    h('button', { type: 'button', class: 'btn small primary', text: 'Use', onclick: () => hooks.onUse(t.id) }),
    h('button', {
      type: 'button',
      class: 'btn small',
      text: 'Duplicate',
      onclick: () =>
        act(async () => {
          await duplicateTemplate(t.id);
          toast('Copy created.');
        }),
    }),
    h('button', { type: 'button', class: 'btn small', text: 'Download', onclick: () => act(() => download(t)) }),
  ];
  if (!t.builtin) {
    actions.push(
      h('button', { type: 'button', class: 'btn small', text: 'Edit', onclick: () => openEditor(t.id) }),
      h('button', {
        type: 'button',
        class: 'btn small',
        text: 'Rename',
        onclick: () =>
          act(async () => {
            const name = await promptDialog('Rename template', 'Name', t.name);
            if (name !== null) await renameTemplate(t.id, name);
          }),
      }),
      h('button', {
        type: 'button',
        class: 'btn small danger',
        text: 'Delete',
        onclick: () =>
          act(async () => {
            if (
              await confirmDialog('Delete template?', `"${t.name}" will be deleted. Saved bills keep their own copy.`, {
                okLabel: 'Delete',
                danger: true,
              })
            ) {
              await removeTemplate(t.id);
              toast('Template deleted.');
            }
          }),
      }),
    );
  }
  return h(
    'article',
    { class: 'card' },
    h(
      'div',
      { class: 'card-title' },
      h('h3', { text: t.name }),
      t.builtin ? h('span', { class: 'badge', text: 'Built-in' }) : null,
    ),
    h('div', { class: 'card-actions' }, actions),
  );
}

async function act(fn) {
  try {
    await fn();
    await renderLibrary();
    hooks.onLibraryChanged();
  } catch (e) {
    toast(e.message, { error: true });
  }
}

async function download(t) {
  const html = await getDownloadHtml(t.id);
  downloadFile(`${slugify(t.name)}.html`, html, 'text/html');
}

async function uploadTemplate() {
  const file = await pickFile('.html,.htm,text/html');
  if (!file) return;
  if (file.size > MAX_TEMPLATE_BYTES) {
    toast('Template is larger than 2 MB.', { error: true });
    return;
  }
  try {
    const html = await file.text();
    const loaded = loadTemplate(html);
    const name = loaded.meta.name || file.name.replace(/\.html?$/i, '');
    // A newer version of a template you already uploaded replaces it, so bills
    // made with that template pick up the new layout and no stale copy is left behind.
    const existing = (await listTemplates()).find((t) => !t.builtin && t.name === name);
    let title = 'Upload template';
    let confirmLabel = 'Save template';
    if (existing) {
      const oldVersion = existing.version;
      const newVersion = loaded.meta.version;
      const from = oldVersion ? `version ${oldVersion}` : 'saved copy';
      const to = newVersion ? `version ${newVersion}` : 'uploaded file';
      title = `Update "${name}" (${from} to ${to})`;
      confirmLabel = 'Replace template';
    }
    const ok = await showReport(title, loaded, { confirmLabel });
    if (!ok) return;
    await saveTemplate({ id: existing?.id, name, html });
    toast(existing ? 'Template updated.' : 'Template saved.');
    await renderLibrary();
    hooks.onLibraryChanged();
  } catch (e) {
    toast(e instanceof TemplateError ? e.message : `Could not read template: ${e.message}`, { error: true });
  }
}

/** Validation report. Resolves true when the user confirms. */
export async function showReport(title, loaded, { confirmLabel } = {}) {
  const r = await dialog({
    title,
    wide: true,
    body: reportBody(loaded),
    buttons: confirmLabel
      ? [
          { label: 'Cancel', value: 'cancel' },
          { label: confirmLabel, value: 'ok', primary: true },
        ]
      : [{ label: 'Close', value: 'ok', primary: true }],
  });
  return r === 'ok';
}

function reportBody({ parsed, report }) {
  const list = (items, cls) =>
    items.length
      ? h(
          'ul',
          { class: cls },
          items.map((x) => h('li', { text: x })),
        )
      : h('p', { class: 'muted', text: 'None' });
  const fields = parsed.fields.map((f) => `${f.name}: ${f.type} (${f.label})`);
  return h(
    'div',
    { class: 'report' },
    h('p', {
      text: `${parsed.name}. Page size: ${parsed.pageSize.declared ? parsed.pageSize.label : 'A4 (default)'}. Size: ${(report.sizeBytes / 1024).toFixed(1)} KB.`,
    }),
    h('h4', { text: `Fields found (${fields.length})` }),
    list(fields, 'report-fields'),
    h('h4', { text: 'Auto-calculated fields used' }),
    list(parsed.reservedUsed, ''),
    h('h4', { text: 'Recommendations' }),
    list(parsed.recommendations, 'warn'),
    h('h4', { text: 'Warnings' }),
    list([...report.warnings, ...parsed.warnings], 'warn'),
    h('h4', { text: 'Removed by the security filter' }),
    list(report.removed, 'removed'),
  );
}

// ---------- In-app HTML editor ----------

async function openEditor(id, fromId) {
  let name;
  let html;
  if (id) {
    const t = await getTemplate(id);
    name = t.name;
    html = await getDownloadHtml(id);
  } else {
    const src = await getTemplate(fromId);
    name = `${src.name} (copy)`;
    html = isBuiltin(fromId) ? await getTemplateHtml(fromId) : await getDownloadHtml(fromId);
  }
  const settings = await getSettings();
  const profile = await getProfile();

  const nameInput = h('input', { class: 'input', type: 'text', value: name, 'aria-label': 'Template name' });
  const code = h('textarea', {
    class: 'code',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
    'aria-label': 'Template HTML',
    value: html,
  });
  const problems = h('div', { class: 'editor-problems', 'aria-live': 'polite' });
  const previewWrap = h('div', { class: 'preview-wrap' });
  let lastLoaded = null;

  const sample = (parsed) => {
    const values = { ...profile };
    for (const f of parsed.fields) {
      if (f.isItem || values[f.name]) continue;
      values[f.name] = f.default || sampleValue(f);
    }
    return {
      values,
      items: [
        { description: 'Sample item', qty: '2', unit: 'pcs', price: '250', hsn: '9988' },
        { description: 'Another item', qty: '1', price: '1200' },
      ],
    };
  };

  const refresh = () => {
    try {
      lastLoaded = loadTemplate(code.value);
      const removed = lastLoaded.report.removed.length;
      const warns = lastLoaded.report.warnings.length + lastLoaded.parsed.warnings.length;
      problems.textContent = `${lastLoaded.parsed.fields.length} fields. ${warns} warning(s). ${removed} item(s) removed by the security filter.`;
      problems.classList.toggle('warn', warns + removed > 0);
      const display = buildDisplayData(lastLoaded.parsed, sample(lastLoaded.parsed), settings);
      preview.show(renderBill(lastLoaded.html, display), lastLoaded.parsed.pageSize);
    } catch (e) {
      lastLoaded = null;
      problems.textContent = e.message;
      problems.classList.add('warn');
    }
  };

  const save = async () => {
    try {
      const loaded = loadTemplate(code.value);
      const ok = await showReport('Save template', loaded, { confirmLabel: 'Save' });
      if (!ok) return;
      const res = await saveTemplate({ id, name: nameInput.value, html: code.value });
      id = res.record.id;
      toast('Template saved.');
      hooks.onLibraryChanged();
    } catch (e) {
      toast(e.message, { error: true });
    }
  };

  code.addEventListener('input', debounce(refresh, 300));
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      // Insert two spaces instead of moving focus. Escape then Tab still leaves the editor.
      if (code.dataset.escaped === '1') {
        code.dataset.escaped = '';
        return;
      }
      e.preventDefault();
      code.setRangeText('  ', code.selectionStart, code.selectionEnd, 'end');
      code.dispatchEvent(new Event('input'));
    } else if (e.key === 'Escape') {
      code.dataset.escaped = '1';
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });

  root.replaceChildren(
    h(
      'div',
      { class: 'view-head' },
      h('button', {
        type: 'button',
        class: 'btn ghost',
        text: '← Templates',
        onclick: async () => {
          if (
            await confirmDialog('Leave the editor?', 'Unsaved changes in the editor will be lost.', {
              okLabel: 'Leave',
            })
          )
            renderLibrary();
        },
      }),
      nameInput,
      h('span', { class: 'spacer' }),
      h('button', {
        type: 'button',
        class: 'btn',
        text: 'Report',
        onclick: () => lastLoaded && showReport('Validation report', lastLoaded),
      }),
      h('button', { type: 'button', class: 'btn primary', text: 'Save', onclick: save }),
    ),
    h('p', {
      class: 'hint',
      text: 'Edit the HTML on the left; the preview uses sample data. Saving runs the security filter. Tab inserts spaces; press Escape then Tab to leave the editor. Ctrl+S saves.',
    }),
    h(
      'div',
      { class: 'editor-split' },
      h('div', { class: 'editor-pane' }, code, problems),
      h('div', { class: 'pane preview-pane' }, previewWrap),
    ),
  );
  const preview = new Preview(previewWrap);
  refresh();
}

function sampleValue(f) {
  switch (f.type) {
    case 'date':
      return new Date().toISOString().slice(0, 10);
    case 'percent':
      return '18';
    case 'currency':
      return '';
    case 'number':
      return '1';
    case 'image':
      return '';
    case 'email':
      return 'name@example.com';
    case 'tel':
      return '+91 98765 43210';
    case 'textarea':
      return `${f.label}\nSecond line`;
    default:
      return f.label;
  }
}
