import * as E from '../js/engine/index.js';
import { withMetaBlock } from '../js/library.js';
import { runAiTests } from './ai.test.js';
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
t('numbered fields keep their type', () => {
  eq(E.inferType('business_phone_2'), 'tel');
  eq(E.inferType('customer_email_2'), 'email');
  eq(E.inferType('business_address_2'), 'textarea');
  eq(E.inferType('line_2'), 'text');
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
t('page size auto height', () => {
  const ps = E.parsePageSize('@page { size: 58mm auto }');
  eq([ps.widthMm, ps.heightMm, ps.autoHeight, ps.label], [58, null, true, '58mm auto']);
});
const pageTpl = (rule, extra = '') =>
  E.loadTemplate(
    `<html><head><style>${rule} body { color: red; }${extra}</style></head><body>{{grand_total}}</body></html>`,
  );
t('auto height survives the security filter', () => {
  const tpl = pageTpl('@page { size: 80mm auto; margin: 0; }');
  ok(/@page\s*\{\s*size: 80mm auto;/.test(tpl.html), tpl.html);
  ok(/margin: 0px/.test(tpl.html), 'other @page declarations kept');
  eq(tpl.parsed.pageSize.autoHeight, true);
  eq(tpl.report.warnings, []);
  // Stored templates are filtered again on every load: the marker must survive a second pass.
  eq(E.loadTemplate(tpl.html).parsed.pageSize.autoHeight, true);
});
t('auto height with placeholders in CSS', () => {
  const tpl = pageTpl('@page { size: 80mm auto; }', ':root { --accent: {{accent_color}}; }');
  const out = E.renderBill(tpl.html, E.buildDisplayData(tpl.parsed, { values: { accent_color: 'red' }, items: [] }));
  ok(/size: 80mm auto/.test(out), out);
});
t('fixed page sizes are unchanged', () => {
  for (const [rule, want] of [
    ['@page { size: A4; margin: 0; }', [210, 297]],
    ['@page { size: A5 landscape; }', [210, 148]],
    ['@page { size: 80mm 297mm; }', [80, 297]],
    ['@page { size: letter; }', [215.9, 279.4]],
  ]) {
    const tpl = pageTpl(rule);
    eq(
      [tpl.parsed.pageSize.widthMm, tpl.parsed.pageSize.heightMm, !!tpl.parsed.pageSize.autoHeight],
      [...want, false],
      rule,
    );
    ok(!/auto/.test(tpl.html), `no auto added for ${rule}`);
    eq(tpl.report.warnings, [], rule);
  }
});
t('invalid page sizes are reported', () => {
  for (const bad of ['A4 auto', '80mm auto landscape', 'banana']) {
    const tpl = pageTpl(`@page { size: ${bad}; }`);
    ok(
      tpl.report.warnings.some((w) => w.includes(`"${bad}"`)),
      `${bad}: ${JSON.stringify(tpl.report.warnings)}`,
    );
    eq(tpl.parsed.pageSize.declared, false, bad);
    ok(!/auto/.test(tpl.html.replace(/banana/, '')), `${bad} not kept`);
  }
  // auto only counts in a plain @page rule
  const first = pageTpl('@page :first { size: 80mm auto; }');
  ok(first.report.warnings.length === 1 && !first.parsed.pageSize.autoHeight, JSON.stringify(first.report.warnings));
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

// charges, advance and balance due
const advanceTpl = E.loadTemplate(`<html><head><title>Advance test</title></head><body>
<div class="items"><div class="item" data-repeat="items">{{item.description}}|{{item.price}}/{{item.unit}}|{{item.qty}} {{item.unit}}|{{item.total}}</div></div>
<div data-if="transport_charges"><span id="sub">{{subtotal}}</span><span id="tr">+ {{transport_charges}}</span></div>
<span id="grand">{{grand_total}}</span>
<div data-if="advance_paid"><span id="adv">Advance<span data-if="advance_qty"> ({{advance_qty}})</span> - {{advance_paid}}</span><span id="bal">{{balance_due}}</span></div>
</body></html>`);
const jaggery = {
  values: { transport_charges: '16000', advance_paid: '81000', advance_qty: '900 kg' },
  items: [{ description: 'Jaggery', price: '90', unit: 'kg', qty: '3300' }],
};
t('balance_due is reserved, advance fields are inputs', () => {
  const f = advanceTpl.parsed.fieldMap;
  ok(f.balance_due.reserved, 'balance_due reserved');
  ok(!f.advance_paid.reserved && !f.advance_qty.reserved, 'advance fields are inputs');
  eq(f.advance_paid.type, 'currency');
  eq(f.advance_qty.type, 'text');
  eq(f.transport_charges.type, 'currency');
});
t('jaggery totals', () => {
  const d = E.buildDisplayData(advanceTpl.parsed, jaggery);
  eq(d.values.subtotal, '₹2,97,000.00');
  eq(d.values.transport_charges, '₹16,000.00');
  eq(d.values.grand_total, '₹3,13,000.00');
  eq(d.values.advance_paid, '₹81,000.00');
  eq(d.values.balance_due, '₹2,32,000.00');
});
t('charges never become item rows', () => {
  const d = E.buildDisplayData(advanceTpl.parsed, jaggery);
  eq(d.items.length, 1);
  const out = E.renderBill(advanceTpl.html, d);
  eq((out.match(/class="item"/g) || []).length, 1);
  ok(out.includes('Jaggery|₹90.00/kg|3,300 kg|₹2,97,000.00'), out.match(/class="item">[^<]*/)?.[0]);
  ok(out.includes('<span id="sub">₹2,97,000.00</span>'), 'subtotal shown with transport');
  ok(out.replace(/<[^>]+>/g, '').includes('Advance (900 kg) - ₹81,000.00'), 'advance line');
  ok(out.includes('<span id="bal">₹2,32,000.00</span>'), 'balance');
  ok(!out.includes('{{'), 'leftover');
});
t('no advance hides advance and balance lines', () => {
  const d = E.buildDisplayData(advanceTpl.parsed, { ...jaggery, values: { transport_charges: '16000' } });
  eq(d.values.balance_due, '₹3,13,000.00');
  const out = E.renderBill(advanceTpl.html, d);
  ok(!out.includes('id="adv"') && !out.includes('id="bal"'), 'hidden');
});
t('no transport hides subtotal and charge lines', () => {
  const d = E.buildDisplayData(advanceTpl.parsed, { ...jaggery, values: {} });
  eq(d.values.grand_total, '₹2,97,000.00');
  ok(!E.renderBill(advanceTpl.html, d).includes('id="tr"'), 'hidden');
});

// review fixes
t('toNumber ignores currency prefixes', () => {
  eq(['Rs. 500', 'Rs.1,250.50', '₹ 99', '.5', '-.5', 'abc', '1,234.50'].map(E.toNumber), [
    500,
    1250.5,
    99,
    0.5,
    -0.5,
    null,
    1234.5,
  ]);
});
t('data-if on item fields inside rows', () => {
  const tpl = E.loadTemplate(
    `<html><body><table><tbody><tr data-repeat="items"><td>{{item.description}}<span data-if="item.hsn"> HSN {{item.hsn}}</span></td></tr></tbody></table></body></html>`,
  );
  const d = E.buildDisplayData(tpl.parsed, { items: [{ description: 'A', hsn: '0901' }, { description: 'B' }] });
  const out = E.renderBill(tpl.html, d);
  ok(out.includes('A<span> HSN 0901</span>'), 'shown when set: ' + out.match(/<td>A.*?<\/td>/)?.[0]);
  ok(out.includes('<td>B</td>'), 'hidden when empty: ' + out.match(/<td>B.*?<\/td>/)?.[0]);
  ok(!out.includes('data-if'), 'no leftover data-if');
});
t('meta with $ patterns survives', () => {
  const meta = { name: 'T', fields: { x: { label: "Cost $& $' $$", placeholder: '$$' } } };
  const html = withMetaBlock('<html><head></head><body>{{x}}</body></html>', meta);
  const back = E.loadTemplate(html).parsed.fieldMap.x;
  eq([back.label, back.placeholder], ["Cost $& $' $$", '$$']);
});

// stored user templates keep their template-meta
t('meta survives save and load', () => {
  const src = E.loadTemplate(`<html><head><script type="application/json" id="template-meta">
{"name":"Meta test","version":"2","fields":{"footer_note":{"label":"Note","type":"textarea","default":"Incl. of all taxes."}}}
</script></head><body><p>{{footer_note}}</p></body></html>`);
  // library.saveTemplate stores src.html and src.meta separately; getTemplate joins them.
  const back = E.loadTemplate(withMetaBlock(src.html, src.meta));
  const f = back.parsed.fieldMap.footer_note;
  eq([f.default, f.label, f.type, back.meta.version], ['Incl. of all taxes.', 'Note', 'textarea', '2']);
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
results.push(...(await runAiTests()));
document.getElementById('out').textContent = 'DONE\n' + results.map((r) => r.join(' :: ')).join('\n');
