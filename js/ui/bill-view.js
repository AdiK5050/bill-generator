// Bill editor: template picker, auto-generated form, live preview, save and print.
import { h, toast, debounce, confirmDialog } from './dom.js';
import { buildForm } from './form.js';
import { Preview } from './preview.js';
import { buildDisplayData, renderBill, todayIso, loadTemplate } from '../engine/index.js';
import { listTemplates, getTemplate, DEFAULT_TEMPLATE_ID } from '../library.js';
import { getSettings, getProfile, saveProfile, formatInvoiceNumber, claimInvoiceNumber } from '../settings.js';
import { getLocal, setLocal, putRecord, getRecord } from '../storage.js';

const state = {
  billId: null,
  templateId: DEFAULT_TEMPLATE_ID,
  input: { values: {}, items: [{}] },
  template: null,
  settings: null,
  dirtySinceSave: false,
};

let els = null;
let preview = null;

export async function initBillView(root) {
  els = {
    root,
    select: h('select', { class: 'input', id: 'template-select', 'aria-label': 'Template' }),
    form: h('form', { class: 'bill-form', novalidate: true, onsubmit: (e) => e.preventDefault() }),
    previewWrap: h('div', { class: 'preview-wrap' }),
    status: h('span', { class: 'bill-status', 'aria-live': 'polite' }),
    tabs: null,
  };
  els.select.addEventListener('change', () => switchTemplate(els.select.value));

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('label', { class: 'toolbar-label', for: 'template-select', text: 'Template' }),
    els.select,
    h('span', { class: 'spacer' }),
    els.status,
    h('button', { type: 'button', class: 'btn', text: 'New bill', onclick: () => newBill() }),
    h('button', { type: 'button', class: 'btn', text: 'Save', onclick: () => saveBill() }),
    h('button', { type: 'button', class: 'btn primary', text: 'Print / PDF', onclick: () => printBill() }),
  );

  const formTab = h('button', {
    type: 'button',
    role: 'tab',
    class: 'tab',
    'aria-selected': 'true',
    'aria-controls': 'bill-form-pane',
    id: 'tab-form',
    text: 'Form',
  });
  const previewTab = h('button', {
    type: 'button',
    role: 'tab',
    class: 'tab',
    'aria-selected': 'false',
    'aria-controls': 'bill-preview-pane',
    id: 'tab-preview',
    text: 'Preview',
  });
  const setTab = (which) => {
    root.dataset.tab = which;
    formTab.setAttribute('aria-selected', String(which === 'form'));
    previewTab.setAttribute('aria-selected', String(which === 'preview'));
    if (which === 'preview') preview.fit();
  };
  formTab.addEventListener('click', () => setTab('form'));
  previewTab.addEventListener('click', () => setTab('preview'));
  els.tabs = h('div', { class: 'mobile-tabs', role: 'tablist', 'aria-label': 'Bill view' }, formTab, previewTab);

  const formPane = h(
    'div',
    { class: 'pane form-pane', id: 'bill-form-pane', role: 'tabpanel', 'aria-labelledby': 'tab-form' },
    els.form,
  );
  const previewPane = h(
    'div',
    { class: 'pane preview-pane', id: 'bill-preview-pane', role: 'tabpanel', 'aria-labelledby': 'tab-preview' },
    els.previewWrap,
  );
  root.dataset.tab = 'form';
  root.append(toolbar, els.tabs, h('div', { class: 'split' }, formPane, previewPane));
  preview = new Preview(els.previewWrap);

  await refreshTemplateList();
  const draft = await getLocal('draft');
  if (draft && draft.input) {
    Object.assign(state, {
      billId: draft.billId || null,
      templateId: draft.templateId || DEFAULT_TEMPLATE_ID,
      input: draft.input,
    });
    try {
      await loadCurrentTemplate();
    } catch {
      // The draft's template was deleted. If the draft is a saved bill, keep using the copy
      // saved with that bill; otherwise fall back to the default template.
      const rec = draft.billId ? await getRecord('bills', draft.billId) : null;
      if (rec && rec.templateId === state.templateId && rec.templateHtml) {
        state.settings = await getSettings();
        state.template = {
          id: rec.templateId,
          name: rec.templateName,
          fromSnapshot: true,
          ...loadTemplate(rec.templateHtml),
        };
        await refreshTemplateList();
        rebuildForm();
        updatePreview();
      } else {
        state.templateId = DEFAULT_TEMPLATE_ID;
        await loadCurrentTemplate();
      }
    }
  } else {
    await newBill({ confirm: false });
  }
}

export async function refreshTemplateList() {
  const list = await listTemplates();
  const builtin = h('optgroup', { label: 'Built-in' });
  const mine = h('optgroup', { label: 'My templates' });
  for (const t of list) (t.builtin ? builtin : mine).append(h('option', { value: t.id, text: t.name }));
  els.select.replaceChildren(builtin, ...(mine.children.length ? [mine] : []));
  if (!list.some((t) => t.id === state.templateId)) {
    if (state.template?.fromSnapshot && state.template.id === state.templateId) {
      // An open bill whose template was deleted: keep showing the copy saved with the bill.
      els.select.append(h('option', { value: state.templateId, text: `${state.template.name} (deleted)` }));
    } else {
      state.templateId = DEFAULT_TEMPLATE_ID;
    }
  }
  els.select.value = state.templateId;
}

async function loadCurrentTemplate() {
  state.settings = await getSettings();
  state.template = await getTemplate(state.templateId);
  els.select.value = state.templateId;
  applyDefaults(false);
  rebuildForm();
  updatePreview();
}

/** Fill empty fields from template defaults. */
function applyDefaults(overwrite) {
  for (const f of state.template.parsed.fields) {
    if (f.isItem || !f.default) continue;
    if (overwrite || state.input.values[f.name] === undefined) state.input.values[f.name] = f.default;
  }
}

function rebuildForm() {
  buildForm(els.form, state.template.parsed, state.input, {
    fmt: state.settings,
    onChange: onInputChange,
    onSaveProfile: async (values) => {
      await saveProfile(values);
      toast('Business profile saved. It will fill into new bills.');
    },
  });
}

const saveDraft = debounce(() => {
  setLocal('draft', { billId: state.billId, templateId: state.templateId, input: state.input }).catch(console.error);
}, 400);

const updatePreviewSoon = debounce(() => updatePreview(), 150);

function onInputChange() {
  state.dirtySinceSave = true;
  setStatus(state.billId ? 'Unsaved changes' : 'New bill, not saved');
  updatePreviewSoon();
  saveDraft();
}

function setStatus(text) {
  els.status.textContent = text;
}

function currentHtml() {
  const display = buildDisplayData(state.template.parsed, state.input, state.settings);
  return renderBill(state.template.html, display);
}

function updatePreview() {
  try {
    preview.show(currentHtml(), state.template.parsed.pageSize);
  } catch (e) {
    console.error(e);
    toast(`Preview failed: ${e.message}`, { error: true });
  }
}

async function switchTemplate(id) {
  state.templateId = id;
  try {
    await loadCurrentTemplate();
    saveDraft();
  } catch (e) {
    toast(e.message, { error: true });
  }
}

/** Start a new bill. Business details come from the profile; invoice number is the next one. */
export async function newBill({ confirm = true, templateId } = {}) {
  if (confirm && state.dirtySinceSave) {
    const ok = await confirmDialog('Start a new bill?', 'The current bill has unsaved changes. They will be lost.', {
      okLabel: 'Discard and start new',
      danger: true,
    });
    if (!ok) return;
  }
  state.settings = await getSettings();
  const profile = await getProfile();
  state.billId = null;
  if (templateId) state.templateId = templateId;
  else if (state.template?.fromSnapshot) state.templateId = DEFAULT_TEMPLATE_ID; // its template is gone
  state.input = {
    values: { ...profile, invoice_date: todayIso(), invoice_number: formatInvoiceNumber(state.settings) },
    items: [{}],
  };
  state.dirtySinceSave = false;
  await loadCurrentTemplate();
  setStatus('New bill');
  saveDraft();
}

/** Open a saved bill from history. duplicate=true starts a new bill with the same content. */
export async function openBill(id, { duplicate = false } = {}) {
  const rec = await getRecord('bills', id);
  if (!rec) {
    toast('Bill not found.', { error: true });
    return;
  }
  state.settings = await getSettings();
  state.input = structuredClone(rec.input);
  state.templateId = rec.templateId;
  if (duplicate) {
    state.billId = null;
    state.input.values.invoice_number = formatInvoiceNumber(state.settings);
    state.input.values.invoice_date = todayIso();
  } else {
    state.billId = rec.id;
  }
  // Load the bill's own template before refreshing the list: the refresh falls back to the
  // default template when the id is missing, which would hide the deleted-template case.
  try {
    state.template = await getTemplate(state.templateId);
  } catch {
    // Template was deleted: fall back to the snapshot stored with the bill.
    state.template = {
      id: rec.templateId,
      name: rec.templateName,
      fromSnapshot: true,
      ...loadTemplate(rec.templateHtml),
    };
    toast('The original template was deleted; showing the copy saved with this bill.');
  }
  await refreshTemplateList();
  rebuildForm();
  updatePreview();
  state.dirtySinceSave = duplicate;
  setStatus(duplicate ? 'Copy, not saved' : `Saved bill ${rec.summary?.invoiceNumber || ''}`);
  saveDraft();
}

export async function saveBill({ quiet = false } = {}) {
  try {
    const settings = await getSettings();
    if (!state.billId && state.input.values.invoice_number === formatInvoiceNumber(settings)) {
      state.input.values.invoice_number = await claimInvoiceNumber();
    }
    const display = buildDisplayData(state.template.parsed, state.input, settings);
    const v = state.input.values;
    const existing = state.billId ? await getRecord('bills', state.billId) : null;
    const rec = await putRecord('bills', {
      ...(existing || {}),
      id: state.billId || undefined,
      templateId: state.templateId,
      templateName: state.template.name,
      // Snapshot of the sanitized template, so reprints match even if the template changes later.
      templateHtml: state.template.html,
      input: structuredClone(state.input),
      summary: {
        invoiceNumber: v.invoice_number || '',
        customerName: v.customer_name || '',
        date: v.invoice_date || '',
        grandTotal: display.totals.grand,
        grandTotalText: display.values.grand_total || '',
      },
    });
    state.billId = rec.id;
    state.dirtySinceSave = false;
    setStatus(`Saved bill ${rec.summary.invoiceNumber}`);
    saveDraft();
    rebuildForm();
    updatePreview();
    if (!quiet) toast('Bill saved.');
    return rec;
  } catch (e) {
    toast(`Could not save: ${e.message}`, { error: true });
    return null;
  }
}

export async function printBill() {
  if (state.dirtySinceSave || !state.billId) await saveBill({ quiet: true });
  // Make sure the latest render is loaded before printing.
  await new Promise((resolve) => {
    preview.frame.addEventListener('load', resolve, { once: true });
    preview.show(currentHtml(), state.template.parsed.pageSize);
  });
  try {
    await preview.print();
  } catch (e) {
    toast(`Printing failed: ${e.message}`, { error: true });
  }
}

/** Called when data changes elsewhere (sync, settings). */
export async function onExternalChange() {
  state.settings = await getSettings();
  await refreshTemplateList();
  if (!state.template?.fromSnapshot) {
    try {
      state.template = await getTemplate(state.templateId);
    } catch {
      state.templateId = DEFAULT_TEMPLATE_ID;
      state.template = await getTemplate(state.templateId);
    }
  }
  els.select.value = state.templateId;
  rebuildForm();
  updatePreview();
}

/** Preview fit needs a nudge when the view becomes visible. */
export function onShow() {
  if (preview) preview.fit();
}
