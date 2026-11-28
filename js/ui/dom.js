// Small DOM helpers. Text is always set with textContent, never innerHTML.

/**
 * Create an element. attrs: class, text, on<Event> handlers, dataset via data-*, boolean props.
 * h('button', { class: 'btn', onclick: fn, text: 'Save' })
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (
      k === 'checked' ||
      k === 'disabled' ||
      k === 'selected' ||
      k === 'hidden' ||
      k === 'required' ||
      k === 'multiple'
    )
      el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

let toastTimer;
export function toast(message, { error = false, ms = 3500 } = {}) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

/** Modal dialog built on <dialog>. Resolves with the clicked button's value. */
export function dialog({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], wide = false }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: `modal${wide ? ' wide' : ''}`, 'aria-labelledby': 'dlg-title' });
    const form = h('form', { method: 'dialog' });
    form.append(
      h('h2', { id: 'dlg-title', text: title }),
      h('div', { class: 'modal-body' }, body),
      h(
        'div',
        { class: 'modal-actions' },
        buttons.map((b) =>
          h(
            'button',
            {
              class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`,
              value: String(b.value),
              type: 'submit',
              // Cancel must close the dialog even when required fields are empty.
              formnovalidate: b.value === 'cancel',
            },
            b.label,
          ),
        ),
      ),
    );
    // Enter in a text field submits the form with its first button, which is Cancel. Make Enter
    // press the main button instead (that also runs the browser's required-field checks).
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!(e.target instanceof HTMLInputElement) || ['button', 'submit', 'checkbox', 'radio'].includes(e.target.type))
        return;
      const main = form.querySelector('.modal-actions .btn.primary');
      if (!main) return;
      e.preventDefault();
      main.click();
    });
    dlg.append(form);
    document.body.append(dlg);
    dlg.addEventListener('close', () => {
      const v = dlg.returnValue;
      dlg.remove();
      const match = buttons.find((b) => String(b.value) === v);
      resolve(match ? match.value : null);
    });
    dlg.showModal();
  });
}

export async function confirmDialog(title, message, { okLabel = 'OK', danger = false } = {}) {
  const r = await dialog({
    title,
    body: h('p', { text: message }),
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: okLabel, value: 'ok', primary: !danger, danger },
    ],
  });
  return r === 'ok';
}

export async function promptDialog(title, label, initial = '') {
  const input = h('input', { type: 'text', value: initial, class: 'input', 'aria-label': label });
  const p = dialog({
    title,
    body: h('label', { class: 'field' }, h('span', { text: label }), input),
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Save', value: 'ok', primary: true },
    ],
  });
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
  return (await p) === 'ok' ? input.value : null;
}

export function downloadFile(filename, content, type = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Ask the user for a file; resolves with a File or null. */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, hidden: true });
    input.addEventListener('change', () => {
      resolve(input.files[0] || null);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve(null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Read an image as a data: URI, downscaling large images so bills and backups stay small. */
export async function readImageAsDataUrl(file, maxSide = 800) {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error('Use a PNG, JPEG, WebP or GIF image.');
  if (file.size > 10 * 1024 * 1024) throw new Error('Image is larger than 10 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not read that image.'));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    canvas.getContext('2d').drawImage(img, 0, 0, w, hgt);
    // PNG keeps transparency for logos and signatures; JPEG for photos.
    return file.type === 'image/jpeg' ? canvas.toDataURL('image/jpeg', 0.88) : canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function formatDateTime(ms) {
  if (!ms) return 'never';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'file'
  );
}
