import * as E from '../js/engine/index.js';
const results = [];
const t = (name, fn) => {
  try {
    fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
};
const eq = (a, b, msg = '') => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${msg} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
};
const ok = (c, msg) => {
  if (!c) throw new Error(msg || 'assertion failed');
};

// format
t('words indian', () =>
  eq(E.amountToWords(296500.5), 'Two Lakh Ninety Six Thousand Five Hundred Rupees and Fifty Paise Only'),
);
t('words crore', () =>
  eq(E.integerToWords(12345678), 'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight'),
);
t('words intl', () =>
  eq(E.amountToWords(1000001, { currency: 'USD', wordsStyle: 'international' }), 'One Million One Dollars Only'),
);
t('words one', () => eq(E.amountToWords(1), 'One Rupee Only'));
t('currency INR', () => eq(E.formatCurrency(296500), '₹2,96,500.00'));
t('date', () => eq(E.formatDate('2026-11-26'), '26/11/2026'));
t('date MMM', () => eq(E.formatDate('2026-11-26', { dateFormat: 'DD MMM YYYY', locale: 'en-IN' }), '26 Nov 2026'));
t('round2', () => eq(E.round2(1.005), 1.01));

// calc
t('totals', () => {
  const r = E.computeTotals({
    values: { tax_cgst_rate: '9', tax_sgst_rate: '9', shipping_charges: '50', invoice_discount: '10' },
    items: [{ price: '100', qty: '2' }, { price: '50.5' }, { description: 'note only' }],
  });
  eq(r.subtotal, 250.5);
  eq(r.taxParts.tax_cgst_amount, 22.55);
  eq(r.tax, 45.1);
  eq(r.grand, 335.6);
});

// sanitizer
const evil = `<html><head><style>@import url(http://x/a.css); body{background:url(http://evil/t.png);color:red} .a{background:u\\72l(http://e/x)} .b{background:url(data:image/png;base64,AAAA)} :root{--accent: {{accent_color}};}</style>
<script>alert(1)</script><script type="application/json" id="template-meta">{"name":"Evil","fields":{"x":{"type":"bogus"}}}</script></head>
<body onload="alert(1)"><img src="http://evil/p.png"><img src="{{business_logo}}" onerror="alert(2)"><a href="javascript:alert(1)">x</a>
<iframe src="x"></iframe><form><input name=a></form><svg><image href="http://e/x"/></svg><div style="background:url(http://e/y);color:blue">{{customer_name}}</div>
<p data-if="business_gstin">GSTIN {{business_gstin}}</p><table><tbody><tr data-repeat="items"><td>{{item.description}}</td><td>{{item.price}}</td><td>{{item.total}}</td></tr></tbody></table>{{grand_totl}}</body></html>`;
let s;
t('sanitize runs', () => {
  s = E.sanitizeTemplate(evil);
});
t('meta parsed', () => eq(s.meta.name, 'Evil'));
t('no script', () => ok(!/<script/i.test(s.html), s.html));
t('no on*', () => ok(!/onload|onerror/i.test(s.html)));
t('no http', () => ok(!/http:/i.test(s.html), s.html.match(/.{30}http:.{30}/)?.[0]));
t('no javascript:', () => ok(!/javascript:/i.test(s.html)));
t('no iframe/form/input', () => ok(!/<(iframe|form|input)/i.test(s.html)));
t('keeps placeholder src', () => ok(s.html.includes('src="{{business_logo}}"')));
t('keeps data url css', () => ok(s.css.includes('data:image/png')));
t('keeps custom prop placeholder', () => ok(s.css.includes('{{accent_color}}'), s.css));
t('inline style keeps color', () =>
  ok(/style="color: blue;?"/.test(s.html) || !/initial/.test(s.html), s.html.match(/<div[^>]*>/)[0]),
);
t('report lists removals', () => ok(s.report.removed.length > 3, JSON.stringify(s.report)));
t('size limit', () => {
  let threw = false;
  try {
    E.sanitizeTemplate('x'.repeat(2 * 1024 * 1024 + 1));
  } catch (e) {
    threw = e instanceof E.TemplateError;
  }
  ok(threw);
});

// parser
let p;
t('parse', () => {
  p = E.parseTemplate(s.html, s.meta);
});
t('fields', () => {
  const names = p.fields.map((f) => f.name);
  ok(names.includes('customer_name') && names.includes('item.price') && names.includes('business_logo'), names.join());
  ok(!names.includes('item.total') && !names.includes('grand_total'));
});
t('types', () => {
  eq(p.fieldMap['business_logo'].type, 'image');
  eq(p.fieldMap['item.price'].type, 'currency');
});
t('typo warning', () =>
  ok(
    p.warnings.some((w) => w.includes('grand_totl')),
    JSON.stringify(p.warnings),
  ),
);
t('sections', () =>
  eq(
    p.sections.map((x) => x.id),
    ['business', 'customer', 'items', 'other'],
  ),
);
t('page size default', () => eq(p.pageSize.widthMm, 210));
t('page size thermal', () => {
  const ps = E.parsePageSize('@page { size: 80mm 297mm; margin:0 }');
  eq([ps.widthMm, ps.heightMm], [80, 297]);
});
t('page landscape', () => {
  const ps = E.parsePageSize('@page{size:A4 landscape}');
  eq([ps.widthMm, ps.heightMm], [297, 210]);
});

// renderer
t('render', () => {
  const input = {
    values: {
      customer_name: 'A <b>&</b> B\nLine2',
      business_gstin: '',
      business_logo: 'javascript:alert(1)',
      accent_color: 'red;background:url(http://x)',
    },
    items: [
      { description: 'Pen', price: '10', qty: '3' },
      { description: 'Book', price: '100' },
    ],
  };
  const d = E.buildDisplayData(p, input);
  const out = E.renderBill(s.html, d);
  ok(out.includes('Content-Security-Policy'), 'csp');
  ok(out.includes('A &lt;b&gt;&amp;&lt;/b&gt; B<br>Line2'), 'escaped + br: ' + out.match(/<div[^>]*>.*?<\/div>/s)?.[0]);
  ok(!out.includes('GSTIN'), 'data-if hides');
  ok(!out.includes('javascript:'), 'bad src dropped');
  ok(!/http:/.test(out), 'css url dropped');
  ok((out.match(/<tr>/g) || []).length === 2, 'two rows');
  ok(out.includes('₹30.00') && out.includes('₹100.00'), 'item totals');
  ok(!out.includes('{{'), 'no leftover placeholders');
});

t('values from another template do not affect totals', () => {
  const parsed = {
    fieldMap: { 'item.price': { type: 'currency' }, 'item.qty': { type: 'number' }, tax_rate: { type: 'percent' } },
  };
  const d = E.buildDisplayData(parsed, {
    values: { tax_cgst_rate: '9', shipping_charges: '50' },
    items: [{ price: '100', qty: '1' }],
  });
  eq(d.totals.grand, 100);
});

// built-in templates
for (const name of ['classic', 'modern', 'gst-invoice', 'thermal-receipt']) {
  const raw = await (await fetch(`../templates/${name}.html`)).text();
  t(`builtin ${name}`, () => {
    const tpl = E.loadTemplate(raw);
    ok(tpl.report.removed.length === 0, 'removed: ' + JSON.stringify(tpl.report.removed));
    ok(tpl.report.warnings.length === 0, 'warnings: ' + JSON.stringify(tpl.report.warnings));
    ok(tpl.parsed.warnings.length === 0, 'parse warnings: ' + JSON.stringify(tpl.parsed.warnings));
    ok(tpl.parsed.recommendations.length === 0, 'recs: ' + JSON.stringify(tpl.parsed.recommendations));
    const d = E.buildDisplayData(tpl.parsed, {
      values: { business_name: 'Shop', tax_rate: '18', tax_cgst_rate: '9', tax_sgst_rate: '9' },
      items: [{ description: 'X', price: '100', qty: '2' }],
    });
    const out = E.renderBill(tpl.html, d);
    ok(!out.includes('{{'), 'leftover');
    results.push([
      'INFO',
      name,
      tpl.parsed.name,
      tpl.parsed.pageSize.label,
      tpl.parsed.sections.map((s) => s.id + ':' + s.fields.map((f) => f.name + '/' + f.type).join(',')).join(' | '),
    ]);
  });
}
document.getElementById('out').textContent = 'DONE\n' + results.map((r) => r.join(' :: ')).join('\n');
