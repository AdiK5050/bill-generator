// Bill history: recent bills saved locally; reopen, duplicate, delete.
import { h, toast, confirmDialog } from './dom.js';
import { listRecords, deleteRecord } from '../storage.js';
import { formatDate } from '../engine/index.js';
import { getSettings } from '../settings.js';

let root;
let hooks;
let query = '';

export function initHistoryView(el, { onOpen, onDuplicate }) {
  root = el;
  hooks = { onOpen, onDuplicate };
  return renderHistory();
}

export async function renderHistory() {
  const settings = await getSettings();
  const bills = (await listRecords('bills')).sort((a, b) => b.updatedAt - a.updatedAt);
  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search by number or customer',
    value: query,
    'aria-label': 'Search bills',
    oninput: (e) => {
      query = e.target.value;
      draw();
    },
  });
  const listEl = h('div', { class: 'history-list' });

  const draw = () => {
    const q = query.trim().toLowerCase();
    const shown = q
      ? bills.filter((b) => `${b.summary?.invoiceNumber} ${b.summary?.customerName}`.toLowerCase().includes(q))
      : bills;
    listEl.replaceChildren(
      ...(shown.length
        ? shown.map((b) => row(b, settings))
        : [
            h('p', {
              class: 'empty',
              text: bills.length
                ? 'No bills match.'
                : 'No saved bills yet. Bills are saved when you press Save or Print.',
            }),
          ]),
    );
  };
  draw();
  root.replaceChildren(
    h('div', { class: 'view-head' }, h('h2', { text: 'Bill history' }), h('span', { class: 'spacer' }), search),
    listEl,
  );
}

function row(b, settings) {
  const s = b.summary || {};
  return h(
    'article',
    { class: 'history-row' },
    h(
      'div',
      { class: 'history-main' },
      h('strong', { text: s.invoiceNumber || '(no number)' }),
      h('span', { text: s.customerName || 'No customer name' }),
      h('span', {
        class: 'muted',
        text: [s.date ? formatDate(s.date, settings) : '', b.templateName].filter(Boolean).join(' · '),
      }),
    ),
    h('span', { class: 'history-total', text: s.grandTotalText || '' }),
    h(
      'div',
      { class: 'history-actions' },
      h('button', { type: 'button', class: 'btn small primary', text: 'Open', onclick: () => hooks.onOpen(b.id) }),
      h('button', { type: 'button', class: 'btn small', text: 'Duplicate', onclick: () => hooks.onDuplicate(b.id) }),
      h('button', {
        type: 'button',
        class: 'btn small danger',
        text: 'Delete',
        onclick: async () => {
          if (
            !(await confirmDialog('Delete bill?', `Bill ${s.invoiceNumber || ''} will be deleted.`, {
              okLabel: 'Delete',
              danger: true,
            }))
          )
            return;
          await deleteRecord('bills', b.id);
          toast('Bill deleted.');
          renderHistory();
        },
      }),
    ),
  );
}
