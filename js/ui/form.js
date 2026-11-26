// Auto-generated bill form, built from a parsed template.
import { h, toast, readImageAsDataUrl, pickFile } from './dom.js';
import { formatCurrency, toNumber, round2 } from '../engine/index.js';

let idSeq = 0;
const uid = (name) => `f-${name.replace(/[^\w-]/g, '-')}-${++idSeq}`;

/**
 * Build the form.
 * @param {HTMLElement} container
 * @param {object} parsed parseTemplate result
 * @param {{values: object, items: Array<object>}} input mutable state, edited in place
 * @param {{onChange: Function, onSaveProfile: Function, fmt: object}} opts
 */
export function buildForm(container, parsed, input, { onChange, onSaveProfile, fmt }) {
  container.replaceChildren();
  const changed = () => onChange(input);

  for (const section of parsed.sections) {
    const body = h('div', { class: 'section-body' });
    const header = h('div', { class: 'section-head' }, h('h3', { text: section.title }));
    if (section.id === 'business' && onSaveProfile) {
      header.append(
        h('button', {
          type: 'button',
          class: 'btn small ghost',
          text: 'Save as business profile',
          title: 'Remember these business details and fill them into every new bill',
          onclick: () => onSaveProfile(input.values),
        }),
      );
    }
    if (section.id === 'items') {
      buildItems(body, section.fields, input, changed, fmt);
    } else {
      for (const field of section.fields) body.append(buildField(field, input.values, changed));
    }
    container.append(h('fieldset', { class: 'form-section', 'data-section': section.id }, header, body));
  }
  if (!parsed.sections.length) {
    container.append(
      h('p', { class: 'empty', text: 'This template has no fields. Add {{placeholders}} to it to get form fields.' }),
    );
  }
}

function buildField(field, values, changed, { compact = false } = {}) {
  const id = uid(field.name);
  const value = values[field.isItem ? field.name.slice(5) : field.name] ?? '';
  const key = field.isItem ? field.name.slice(5) : field.name;
  const set = (v) => {
    values[key] = v;
    changed();
  };
  const label = h('label', { for: id, text: field.label });
  let control;

  switch (field.type) {
    case 'textarea':
      control = h('textarea', {
        id,
        class: 'input',
        rows: compact ? 2 : 3,
        value,
        placeholder: field.placeholder || null,
        oninput: (e) => set(e.target.value),
      });
      break;
    case 'image':
      return buildImageField(field, id, value, set);
    case 'date':
      control = h('input', { id, class: 'input', type: 'date', value, oninput: (e) => set(e.target.value) });
      break;
    case 'currency':
    case 'number':
    case 'percent':
      control = h('input', {
        id,
        class: 'input num',
        type: 'text',
        inputmode: 'decimal',
        autocomplete: 'off',
        value,
        placeholder: field.placeholder || (field.type === 'percent' ? '%' : field.type === 'currency' ? '0.00' : '0'),
        oninput: (e) => {
          const v = e.target.value;
          e.target.classList.toggle('invalid', v.trim() !== '' && toNumber(v) === null);
          set(v);
        },
      });
      break;
    default:
      control = h('input', {
        id,
        class: 'input',
        type: field.type === 'tel' ? 'tel' : field.type === 'email' ? 'email' : 'text',
        value,
        placeholder: field.placeholder || null,
        autocomplete: autocompleteFor(field.name),
        oninput: (e) => set(e.target.value),
      });
  }
  return h('div', { class: `field type-${field.type}` }, label, control);
}

function autocompleteFor(name) {
  if (name.startsWith('business_') || name.startsWith('customer_')) {
    if (name.endsWith('_email')) return 'email';
    if (name.endsWith('_phone')) return 'tel';
  }
  return 'off';
}

function buildImageField(field, id, value, set) {
  const img = h('img', { class: 'thumb', alt: '', hidden: !value });
  if (value) img.src = value;
  const remove = h('button', { type: 'button', class: 'btn small ghost', text: 'Remove', hidden: !value });
  const choose = h('button', { type: 'button', class: 'btn small', id, text: value ? 'Change image' : 'Choose image' });
  choose.addEventListener('click', async () => {
    const file = await pickFile('image/png,image/jpeg,image/webp,image/gif');
    if (!file) return;
    try {
      const data = await readImageAsDataUrl(file, field.name.endsWith('_signature') ? 600 : 800);
      img.src = data;
      img.hidden = false;
      remove.hidden = false;
      choose.textContent = 'Change image';
      set(data);
    } catch (e) {
      toast(e.message, { error: true });
    }
  });
  remove.addEventListener('click', () => {
    img.removeAttribute('src');
    img.hidden = true;
    remove.hidden = true;
    choose.textContent = 'Choose image';
    set('');
  });
  return h(
    'div',
    { class: 'field type-image' },
    h('label', { for: id, text: field.label }),
    h('div', { class: 'image-row' }, img, choose, remove),
  );
}

function buildItems(body, fields, input, changed, fmt) {
  if (!Array.isArray(input.items)) input.items = [];
  if (!input.items.length) input.items.push({});
  const list = h('div', { class: 'items' });
  const footer = h('div', { class: 'items-foot' });
  const subtotalEl = h('span', { class: 'items-subtotal' });

  const rowTotal = (row) => {
    const price = toNumber(row.price);
    if (price === null) return '';
    const qty = toNumber(row.qty);
    return formatCurrency(round2(price * (qty === null ? 1 : qty)), fmt);
  };
  const updateTotals = () => {
    list.querySelectorAll('.item-row').forEach((el, i) => {
      const t = el.querySelector('.row-total');
      if (t && input.items[i]) t.textContent = rowTotal(input.items[i]);
      const n = el.querySelector('.row-num');
      if (n) n.textContent = `#${i + 1}`;
    });
    const sum = input.items.reduce((s, r) => {
      const p = toNumber(r.price);
      const q = toNumber(r.qty);
      return p === null ? s : s + round2(p * (q === null ? 1 : q));
    }, 0);
    subtotalEl.textContent = `Subtotal: ${formatCurrency(round2(sum), fmt)}`;
  };

  const renderRows = () => {
    list.replaceChildren();
    input.items.forEach((row, i) => {
      const onRowChange = () => {
        updateTotals();
        changed();
      };
      const grid = h('div', { class: 'item-grid' });
      for (const f of fields) {
        const el = buildField(f, row, onRowChange, { compact: true });
        if (f.name === 'item.description') el.classList.add('wide');
        grid.append(el);
      }
      const actions = h(
        'div',
        { class: 'row-actions' },
        h('span', { class: 'row-num', text: `#${i + 1}` }),
        h('span', { class: 'row-total', 'aria-label': 'Row total', text: rowTotal(row) }),
        h('button', {
          type: 'button',
          class: 'btn icon ghost',
          title: 'Move up',
          'aria-label': `Move row ${i + 1} up`,
          disabled: i === 0,
          text: '↑',
          onclick: () => {
            [input.items[i - 1], input.items[i]] = [input.items[i], input.items[i - 1]];
            renderRows();
            changed();
          },
        }),
        h('button', {
          type: 'button',
          class: 'btn icon ghost',
          title: 'Duplicate row',
          'aria-label': `Duplicate row ${i + 1}`,
          text: '⧉',
          onclick: () => {
            input.items.splice(i + 1, 0, { ...row });
            renderRows();
            changed();
          },
        }),
        h('button', {
          type: 'button',
          class: 'btn icon ghost danger',
          title: 'Remove row',
          'aria-label': `Remove row ${i + 1}`,
          text: '✕',
          onclick: () => {
            input.items.splice(i, 1);
            if (!input.items.length) input.items.push({});
            renderRows();
            changed();
          },
        }),
      );
      list.append(h('div', { class: 'item-row' }, actions, grid));
    });
    updateTotals();
  };

  const add = h('button', {
    type: 'button',
    class: 'btn',
    text: '+ Add row',
    onclick: () => {
      input.items.push({});
      renderRows();
      changed();
      const last = list.lastElementChild?.querySelector('input, textarea');
      if (last) last.focus();
    },
  });
  footer.append(add, subtotalEl);
  body.append(list, footer);
  renderRows();
}
