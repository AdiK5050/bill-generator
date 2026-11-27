// Template guide: table of contents highlight and the live playground.
// The playground runs the app's real engine (sanitizer, parser, calc, renderer).
import { loadTemplate, buildDisplayData, renderBill, TemplateError, todayIso } from '../js/engine/index.js';
import { Preview } from '../js/ui/preview.js';

const EXAMPLES = {
  invoice: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<script type="application/json" id="template-meta">
{
  "name": "Simple Invoice",
  "version": "1.0",
  "fields": {
    "invoice_number": { "label": "Invoice #", "default": "INV-001" },
    "footer_note": { "type": "textarea", "default": "Thank you for your business." }
  }
}
</script>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; width: 210mm; padding: 16mm;
         font-family: system-ui, "Segoe UI", Roboto, Arial, sans-serif;
         font-size: 10.5pt; color: #1c1f24;
         print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  header { display: flex; justify-content: space-between; align-items: flex-start; }
  h1 { margin: 0; font-size: 20pt; color: #2f5bea; }
  .muted { color: #5d6673; }
  .meta { text-align: right; }
  table { width: 100%; border-collapse: collapse; margin-top: 10mm; }
  th { text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.05em;
       border-bottom: 1.5px solid #1c1f24; padding: 2mm; }
  td { padding: 2.5mm 2mm; border-bottom: 1px solid #e3e6ec; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tr { break-inside: avoid; }
  .totals { margin-left: auto; width: 70mm; margin-top: 6mm; }
  .totals div { display: flex; justify-content: space-between; padding: 1.5mm 0; }
  .grand { font-weight: 700; font-size: 12pt; border-top: 1.5px solid #1c1f24; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>{{business_name}}</h1>
      <p class="muted">{{business_address}}</p>
      <p data-if="business_gstin">GSTIN: {{business_gstin}}</p>
    </div>
    <div class="meta">
      <p><strong>Invoice {{invoice_number}}</strong></p>
      <p class="muted">{{invoice_date}}</p>
    </div>
  </header>

  <p><strong>Bill to</strong><br>{{customer_name}}<span data-if="customer_address"><br>{{customer_address}}</span></p>

  <table>
    <thead>
      <tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr>
    </thead>
    <tbody>
      <tr data-repeat="items">
        <td>{{item.index}}</td>
        <td>{{item.description}}</td>
        <td class="num">{{item.qty}} {{item.unit}}</td>
        <td class="num">{{item.price}}</td>
        <td class="num">{{item.total}}</td>
      </tr>
    </tbody>
  </table>

  <div class="totals">
    <div><span>Subtotal</span><span class="num">{{subtotal}}</span></div>
    <div data-if="tax_rate"><span>Tax ({{tax_rate}}%)</span><span class="num">{{tax_amount}}</span></div>
    <div data-if="invoice_discount"><span>Discount</span><span class="num">- {{invoice_discount}}</span></div>
    <div class="grand"><span>Total</span><span class="num">{{grand_total}}</span></div>
  </div>
  <p class="muted">{{total_in_words}}</p>
  <p>{{footer_note}}</p>
</body>
</html>
`,
  advance: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<script type="application/json" id="template-meta">
{
  "name": "Invoice with Advance",
  "version": "1.0",
  "fields": {
    "transport_charges": { "label": "Transportation charges (optional)" },
    "advance_paid": { "label": "Advance paid (optional)" },
    "advance_qty": { "label": "Advance covers (optional, e.g. 900 kg)" }
  }
}
</script>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; width: 210mm; padding: 16mm;
         font-family: system-ui, "Segoe UI", Roboto, Arial, sans-serif;
         font-size: 10.5pt; color: #1c1f24;
         print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  h1 { margin: 0 0 6mm; font-size: 22pt; letter-spacing: 0.1em; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; background: #1c1f24; color: #fff; font-size: 8pt; padding: 2.5mm; }
  td { padding: 2.5mm; border-bottom: 1px solid #e3e6ec; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .sum { margin-left: auto; width: 85mm; margin-top: 6mm; }
  .sum div { display: flex; justify-content: space-between; padding: 1.5mm 0; }
  .strong { font-weight: 700; border-top: 1.5px solid #1c1f24; }
  .due { font-weight: 700; color: #b23a10; font-size: 12pt; }
</style>
</head>
<body>
  <h1>INVOICE</h1>
  <p><strong>{{business_name}}</strong> · {{invoice_date}}</p>
  <p>Bill to: {{customer_name}}</p>

  <table>
    <thead><tr><th>Description</th><th class="num">Price</th><th class="num">Qty</th><th class="num">Total</th></tr></thead>
    <tbody>
      <tr data-repeat="items">
        <td>{{item.description}}</td>
        <td class="num">{{item.price}}/{{item.unit}}</td>
        <td class="num">{{item.qty}} {{item.unit}}</td>
        <td class="num">{{item.total}}</td>
      </tr>
    </tbody>
  </table>

  <div class="sum">
    <div data-if="transport_charges"><span>Subtotal</span><span class="num">{{subtotal}}</span></div>
    <div data-if="transport_charges"><span>Transportation</span><span class="num">+ {{transport_charges}}</span></div>
    <div class="strong"><span>TOTAL</span><span class="num">{{grand_total}}</span></div>
    <div data-if="advance_paid">
      <span>Advance<span data-if="advance_qty"> ({{advance_qty}})</span></span>
      <span class="num">- {{advance_paid}}</span>
    </div>
    <div class="due" data-if="advance_paid"><span>BALANCE DUE</span><span class="num">{{balance_due}}</span></div>
  </div>
</body>
</html>
`,
  receipt: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<script type="application/json" id="template-meta">
{ "name": "Shop Receipt", "version": "1.0",
  "fields": { "footer_note": { "default": "Thank you! Visit again." } } }
</script>
<style>
  @page { size: 80mm 297mm; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; width: 80mm; padding: 5mm 4mm;
         font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 9pt; color: #000; }
  .c { text-align: center; }
  h1 { font-size: 12pt; margin: 0; }
  hr { border: 0; border-top: 1px dashed #000; margin: 3mm 0; }
  .line { display: flex; justify-content: space-between; gap: 2mm; }
  .total { font-weight: 700; font-size: 11pt; }
</style>
</head>
<body>
  <div class="c">
    <h1>{{business_name}}</h1>
    <div data-if="business_phone">Ph: {{business_phone}}</div>
  </div>
  <hr>
  <div class="line"><span>Bill {{invoice_number}}</span><span>{{invoice_date}}</span></div>
  <div data-if="!customer_name">Cash sale</div>
  <div data-if="customer_name">Customer: {{customer_name}}</div>
  <hr>
  <div data-repeat="items">
    <div>{{item.description}}</div>
    <div class="line"><span>{{item.qty}} x {{item.price}}</span><span>{{item.total}}</span></div>
  </div>
  <hr>
  <div class="line total"><span>TOTAL</span><span>{{grand_total}}</span></div>
  <hr>
  <div class="c">{{footer_note}}</div>
</body>
</html>
`,
};

// Sample values so the preview looks like a real bill. Anything not listed gets a value by type.
const SAMPLE_VALUES = {
  business_name: 'Sharma Dry Fruits',
  business_address: '12 Station Road, Pune 411001',
  business_phone: '98765 43210',
  business_gstin: '20ABCDE1234F1Z5',
  customer_name: 'Gupta Traders',
  customer_address: 'Main Road, Ranchi',
  invoice_number: 'INV-042',
  tax_rate: '5',
  transport_charges: '16000',
  advance_paid: '81000',
  advance_qty: '900 kg',
};
const SAMPLE_ITEMS = {
  invoice: [
    { description: 'Cashew W240', qty: '25', unit: 'kg', price: '980' },
    { description: 'Almonds, California', qty: '10', unit: 'kg', price: '760' },
  ],
  advance: [{ description: 'Jaggery', qty: '3300', unit: 'kg', price: '90' }],
  receipt: [
    { description: 'Raisins 500 g', qty: '2', price: '180' },
    { description: 'Pistachio 250 g', qty: '1', price: '320' },
  ],
};

function sampleFor(field) {
  if (field.default) return field.default;
  if (field.name in SAMPLE_VALUES) return SAMPLE_VALUES[field.name];
  switch (field.type) {
    case 'date':
      return todayIso();
    case 'currency':
    case 'number':
    case 'percent':
    case 'image':
      return '';
    case 'email':
      return 'accounts@example.com';
    case 'tel':
      return '98765 43210';
    default:
      return field.label;
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

const TYPE_NAMES = {
  text: 'text',
  textarea: 'multi-line',
  date: 'date',
  tel: 'phone',
  email: 'email',
  image: 'image',
  currency: 'money',
  number: 'number',
  percent: '%',
};

function showFields(target, loaded) {
  const { parsed, report } = loaded;
  const groups = parsed.sections.map((s) =>
    el(
      'div',
      { class: 'g-field-group' },
      el('strong', { text: s.title }),
      el(
        'div',
        { class: 'g-field-list' },
        ...s.fields.map((f) =>
          el('span', { class: 'g-field', title: f.name }, f.label, el('small', { text: TYPE_NAMES[f.type] || f.type })),
        ),
      ),
    ),
  );
  if (parsed.reservedUsed.length) {
    groups.push(
      el(
        'div',
        { class: 'g-field-group' },
        el('strong', { text: 'Calculated for you' }),
        el(
          'div',
          { class: 'g-field-list' },
          ...parsed.reservedUsed.map((n) => el('span', { class: 'g-field auto' }, n, el('small', { text: 'auto' }))),
        ),
      ),
    );
  }
  const notes = [...report.warnings, ...parsed.warnings, ...parsed.recommendations];
  if (report.removed.length) notes.push(`Removed by the security filter: ${report.removed.join(', ')}`);
  if (notes.length) {
    groups.push(el('ul', { class: 'g-pg-msgs' }, ...notes.map((n) => el('li', { text: n }))));
  }
  target.replaceChildren(...groups);
}

function initPlayground() {
  const code = document.getElementById('pg-code');
  const fieldsEl = document.getElementById('pg-fields');
  const status = document.getElementById('pg-status');
  const exampleButtons = document.querySelectorAll('[data-example]');
  const preview = new Preview(document.getElementById('pg-preview'));
  let current = 'invoice';
  let timer = null;

  const render = () => {
    if (!globalThis.DOMPurify) {
      fieldsEl.replaceChildren(el('p', { class: 'g-pg-error', text: 'The security filter did not load.' }));
      return;
    }
    try {
      const loaded = loadTemplate(code.value);
      showFields(fieldsEl, loaded);
      const values = {};
      for (const f of loaded.parsed.fields) if (!f.isItem) values[f.name] = sampleFor(f);
      const items = SAMPLE_ITEMS[current] || SAMPLE_ITEMS.invoice;
      const display = buildDisplayData(loaded.parsed, { values, items });
      preview.show(renderBill(loaded.html, display), loaded.parsed.pageSize);
    } catch (e) {
      const msg = e instanceof TemplateError ? e.message : `Could not read this template: ${e.message}`;
      fieldsEl.replaceChildren(el('p', { class: 'g-pg-error', text: msg }));
    }
  };

  const load = (name) => {
    current = name;
    code.value = EXAMPLES[name];
    exampleButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.example === name)));
    render();
  };

  code.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(render, 250);
  });
  // Tab inserts two spaces instead of leaving the editor; Escape then Tab still leaves it.
  let escaped = false;
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      escaped = true;
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && !escaped) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end } = code;
      code.setRangeText('  ', s, end, 'end');
      code.dispatchEvent(new Event('input'));
    }
    escaped = false;
  });
  exampleButtons.forEach((b) => b.addEventListener('click', () => load(b.dataset.example)));

  document.getElementById('pg-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.value);
      status.textContent = 'Copied.';
    } catch {
      code.select();
      status.textContent = 'Press Ctrl+C (or Cmd+C) to copy.';
    }
  });
  document.getElementById('pg-download').addEventListener('click', () => {
    const name = (/"name"\s*:\s*"([^"]+)"/.exec(code.value)?.[1] || 'my-template')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const url = URL.createObjectURL(new Blob([code.value], { type: 'text/html' }));
    const a = el('a', { href: url, download: `${name || 'my-template'}.html` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = 'Downloaded. Upload it in the app under Templates.';
  });

  load('invoice');
}

function initToc() {
  const links = new Map();
  document.querySelectorAll('.g-toc a').forEach((a) => links.set(a.getAttribute('href').slice(1), a));
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        links.forEach((a, id) => a.classList.toggle('active', id === en.target.id));
      }
    },
    { rootMargin: '-15% 0px -75% 0px' },
  );
  document.querySelectorAll('.g-section').forEach((s) => io.observe(s));
}

initToc();
// DOMPurify loads with defer; module scripts run after deferred scripts, so it is ready here.
initPlayground();
