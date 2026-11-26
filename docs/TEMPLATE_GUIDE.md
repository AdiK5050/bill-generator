# Template Guide

How to write your own bill template. A template is one `.html` file. The app reads it, builds a form from its placeholders, and prints it exactly as designed.

## 1. The basics

- One self-contained file. Put CSS in a `<style>` tag inside `<head>`.
- Images must be embedded as `data:` URIs. External links, `@import`, web fonts and any `url()` that is not `data:` are removed.
- No JavaScript. Every `<script>` is removed, except the optional metadata block (section 8).
- Forms, inputs, iframes, embeds and `on*` attributes are removed.
- Maximum size: 2 MB.
- Use system fonts, for example `system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`, or embed a font as a `data:` URI.

## 2. Placeholders

Write `{{field_name}}` anywhere in text and the app creates a form field for it. Use `snake_case`. The label comes from the name (`customer_name` becomes "Customer name").

Values are always inserted as plain text, never as HTML. Line breaks in multi-line values (addresses, notes) become `<br>`.

### Input type from the name

| Name | Input |
|---|---|
| ends with `_date` | date picker |
| ends with `_address`, `_notes`, `_terms` | multi-line text |
| ends with `_phone` | phone |
| ends with `_email` | email |
| ends with `_logo`, `_image`, `_signature` | image upload |
| `tax_rate`, `tax_<name>_rate`, ends with `_percent` | percentage number |
| contains `price`, `amount`, `charge`, `rate`, `discount` | currency number |
| `item.qty` | number |
| anything else | single-line text |

### Form sections from the prefix

| Prefix | Section |
|---|---|
| `business_` | Business details (auto-filled from the business profile) |
| `customer_` | Customer / Bill to |
| `invoice_` | Invoice details |
| `item.` | Items |
| `tax_` | Tax |
| anything else | Other |

## 3. Item rows

Mark the element that repeats per item with `data-repeat="items"`. Inside it, use `{{item.<field>}}`.

```html
<tr data-repeat="items">
  <td>{{item.index}}</td>
  <td>{{item.description}}</td>
  <td>{{item.qty}} {{item.unit}}</td>
  <td>{{item.price}}</td>
  <td>{{item.total}}</td>
</tr>
```

Standard item fields: `description`, `price`, `unit`, `qty`, `hsn`. Any other `item.*` name becomes an extra column in the item form.

Important: inside a `<table>`, placeholders must be inside a `<td>` or `<th>`. Text placed directly in `<table>`, `<tbody>` or `<tr>` is moved out of the table by the browser.

## 4. Show only when filled

`data-if="field_name"` hides the element when that field is empty.

```html
<p data-if="business_gstin">GSTIN: {{business_gstin}}</p>
<tr data-if="shipping_charges"><td>Shipping</td><td>{{shipping_charges}}</td></tr>
```

## 5. Calculated fields

These are filled by the app and never appear in the form.

| Field | Value |
|---|---|
| `{{item.total}}` | price x qty |
| `{{item.index}}` | row number |
| `{{subtotal}}` | sum of item totals |
| `{{tax_<name>_amount}}` | subtotal x `tax_<name>_rate` / 100 (e.g. `tax_cgst_rate` gives `tax_cgst_amount`) |
| `{{tax_amount}}` | subtotal x `tax_rate` / 100, plus all `tax_<name>_amount` values |
| `{{grand_total}}` | subtotal + tax + fields ending in `_charges` minus fields ending in `_discount` |
| `{{total_in_words}}` | grand total in words |

Rates are shown as plain numbers, so write the percent sign yourself: `Tax ({{tax_rate}}%)`.

Discounts: name the field so it ends in `_discount`, for example `invoice_discount`. Extra charges end in `_charges`, for example `shipping_charges`.

## 6. Images, CSS and attributes

- Image fields go in `src` as the whole value: `<img src="{{business_logo}}">`. Only uploaded images (`data:image/...`) are allowed there.
- In CSS, placeholders work only inside custom properties:

```css
:root { --accent: {{accent_color}}; }
h1 { color: var(--accent); }
```

Placeholders in normal CSS properties (`color: {{x}}`) are dropped.

## 7. Page size

Declare it with `@page`. Default is A4.

```css
@page { size: A4; margin: 0; }          /* A4 invoice */
@page { size: 80mm 297mm; margin: 0; }  /* 80mm thermal receipt */
```

`size: 80mm auto` is not valid CSS, so give receipts an explicit height. Set the page padding on `body` and add `print-color-adjust: exact;` so background colors print. Add `tr { break-inside: avoid; }` so rows do not split across pages.

## 8. Optional metadata

One JSON block sets the template name and overrides labels, types, defaults or order. It is read with `JSON.parse`, never run.

```html
<script type="application/json" id="template-meta">
{
  "name": "My Invoice",
  "version": "1.0",
  "fields": {
    "invoice_number": { "label": "Invoice #", "default": "INV-001" },
    "footer_note": { "type": "textarea", "default": "Thank you for your business." }
  }
}
</script>
```

Types you can set: `text`, `textarea`, `date`, `tel`, `email`, `image`, `currency`, `number`, `percent`.

## 9. Validation report

When you upload or save a template, the app shows:

- every field found and its input type
- recommended fields that are missing (for example no `{{grand_total}}`)
- everything the sanitiser removed
- names that look like a typo of a calculated field (for example `{{grand_totl}}`)

## 10. Full minimal example

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<script type="application/json" id="template-meta">
{ "name": "Minimal Invoice", "version": "1.0",
  "fields": { "invoice_number": { "default": "INV-001" } } }
</script>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; width: 210mm; padding: 15mm;
         font-family: system-ui, Arial, sans-serif; font-size: 10.5pt;
         print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 2mm; border-bottom: 1px solid #ddd; text-align: left; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tr { break-inside: avoid; }
</style>
</head>
<body>
  <div data-if="business_logo"><img src="{{business_logo}}" alt="" style="max-height:20mm"></div>
  <h1>{{business_name}}</h1>
  <p>{{business_address}}</p>
  <p data-if="business_gstin">GSTIN: {{business_gstin}}</p>

  <h2>Invoice {{invoice_number}}</h2>
  <p>Date: {{invoice_date}}</p>
  <p><strong>Bill to:</strong> {{customer_name}}<br>{{customer_address}}</p>

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

  <p class="num">Subtotal: {{subtotal}}</p>
  <p class="num" data-if="tax_rate">Tax ({{tax_rate}}%): {{tax_amount}}</p>
  <p class="num" data-if="invoice_discount">Discount: {{invoice_discount}}</p>
  <p class="num"><strong>Total: {{grand_total}}</strong></p>
  <p>{{total_in_words}}</p>
</body>
</html>
```
