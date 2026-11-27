// Settings: appearance, business profile, invoice numbering, formatting, account and sync, backup.
import { h, toast, confirmDialog, dialog, downloadFile, pickFile, formatDateTime, readImageAsDataUrl } from './dom.js';
import {
  getSettings,
  saveSettings,
  getProfile,
  saveProfile,
  formatInvoiceNumber,
  getTheme,
  setTheme,
} from '../settings.js';
import { exportBackup, importBackup, markAllDirty, eraseSyncedData } from '../storage.js';
import { sanitizeTemplate, formatCurrency, formatDate, todayIso } from '../engine/index.js';
import {
  getAccount,
  setAccount,
  normalizeServerUrl,
  mixedContentProblem,
  checkServer,
  authenticate,
  signOut,
} from '../sync/account.js';
import {
  getSyncConfig,
  setSyncConfig,
  getSyncState,
  syncNow,
  pendingCount,
  resetSyncState,
  INTERVAL_CHOICES,
  isSyncing,
} from '../sync/sync.js';
import { APP_VERSION } from '../version.js';

let root;
let hooks;

export function initSettingsView(el, { onDataChanged, onErased }) {
  root = el;
  hooks = { onDataChanged, onErased };
  window.addEventListener('sync-status', () => {
    if (!root.hidden) refreshSyncStatus();
  });
  return renderSettings();
}

export async function renderSettings() {
  const [settings, profile, account, syncCfg] = await Promise.all([
    getSettings(),
    getProfile(),
    getAccount(),
    getSyncConfig(),
  ]);
  root.replaceChildren(
    h('div', { class: 'view-head' }, h('h2', { text: 'Settings' })),
    h(
      'div',
      { class: 'settings' },
      accountSection(account, syncCfg),
      profileSection(profile),
      numberingSection(settings),
      formatSection(settings),
      appearanceSection(),
      backupSection(),
    ),
    h('p', { class: 'app-version', text: `Bill Generator version ${APP_VERSION}` }),
  );
  refreshSyncStatus();
}

const card = (title, ...children) => h('section', { class: 'settings-card' }, h('h3', { text: title }), ...children);
const field = (label, control, hint) =>
  h(
    'label',
    { class: 'field' },
    h('span', { text: label }),
    control,
    hint ? h('small', { class: 'muted', text: hint }) : null,
  );

// ---------- Account and sync ----------

function accountSection(account, cfg) {
  if (account.mode !== 'user') {
    return card(
      'Account and server backup',
      h('p', {
        text: 'You are using the app as a guest. Everything works offline and your data stays on this device.',
      }),
      h('p', {
        class: 'muted',
        text: 'Sign in to your own sync server to back up your data and use it on other devices. Server backup is only available when signed in.',
      }),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', text: 'Sign in to a server', onclick: () => signInFlow() }),
      ),
    );
  }
  const reauth = account.needsReauth || !account.token;
  const scheduleSel = h(
    'select',
    { class: 'input', 'aria-label': 'Sync schedule' },
    h('option', { value: 'manual', text: 'Manual only', selected: cfg.schedule === 'manual' }),
    h('option', { value: 'interval', text: 'Every few minutes', selected: cfg.schedule === 'interval' }),
    h('option', { value: 'daily', text: 'Once a day', selected: cfg.schedule === 'daily' }),
  );
  const intervalSel = h(
    'select',
    { class: 'input', 'aria-label': 'Sync interval' },
    INTERVAL_CHOICES.map((m) =>
      h('option', {
        value: String(m),
        text: m >= 60 ? `Every ${m / 60} hour${m > 60 ? 's' : ''}` : `Every ${m} minutes`,
        selected: Number(cfg.intervalMinutes) === m,
      }),
    ),
  );
  const timeInput = h('input', { class: 'input', type: 'time', value: cfg.dailyTime, 'aria-label': 'Daily sync time' });
  const intervalField = field('Interval', intervalSel);
  const timeField = field(
    'Time of day',
    timeInput,
    'If the app is closed at that time, it syncs the next time you open it.',
  );
  const toggle = (key, label) =>
    h(
      'label',
      { class: 'check' },
      h('input', { type: 'checkbox', checked: cfg[key], onchange: (e) => update({ [key]: e.target.checked }) }),
      h('span', { text: label }),
    );

  const showSub = () => {
    intervalField.hidden = scheduleSel.value !== 'interval';
    timeField.hidden = scheduleSel.value !== 'daily';
  };
  const update = async (patch) => {
    Object.assign(cfg, patch);
    await setSyncConfig(cfg);
    toast('Sync settings saved.');
  };
  scheduleSel.addEventListener('change', () => {
    showSub();
    update({ schedule: scheduleSel.value });
  });
  intervalSel.addEventListener('change', () => update({ intervalMinutes: Number(intervalSel.value) }));
  timeInput.addEventListener('change', () => update({ dailyTime: timeInput.value || '21:00' }));
  showSub();

  return card(
    'Account and server backup',
    h(
      'p',
      {},
      'Signed in as ',
      h('strong', { text: account.user?.username || '?' }),
      ' on ',
      h('code', { text: account.serverUrl }),
    ),
    reauth
      ? h(
          'p',
          { class: 'warn' },
          'Your session expired. ',
          h('button', {
            type: 'button',
            class: 'btn small primary',
            text: 'Sign in again',
            onclick: () => signInFlow({ serverUrl: account.serverUrl, username: account.user?.username, reauth: true }),
          }),
        )
      : null,
    h('div', { class: 'sync-status', id: 'sync-status', 'aria-live': 'polite' }),
    h(
      'div',
      { class: 'row' },
      h('button', {
        type: 'button',
        class: 'btn primary',
        id: 'sync-now',
        text: 'Sync now',
        disabled: reauth,
        onclick: async () => {
          await syncNow();
          refreshSyncStatus();
        },
      }),
      h('button', {
        type: 'button',
        class: 'btn',
        text: 'Change server address',
        onclick: () => signInFlow({ serverUrl: account.serverUrl, username: account.user?.username, reauth: true }),
      }),
      h('button', { type: 'button', class: 'btn danger', text: 'Sign out', onclick: signOutFlow }),
    ),
    h('h4', { text: 'When to sync' }),
    h('div', { class: 'grid2' }, field('Schedule', scheduleSel), intervalField, timeField),
    toggle('onOpen', 'Sync when the app opens'),
    toggle('onChange', 'Sync a few seconds after I make changes'),
    toggle('onHide', 'Sync when I switch away from the app'),
    h('p', {
      class: 'muted small',
      text: 'Scheduled syncs run while the app is open. Browsers do not reliably run web apps in the background, so a sync also happens when you open the app.',
    }),
  );
}

async function refreshSyncStatus() {
  const el = root.querySelector('#sync-status');
  if (!el) return;
  const [state, pending] = await Promise.all([getSyncState(), pendingCount()]);
  const parts = [
    h('span', {}, 'Last synced: ', h('strong', { text: formatDateTime(state.lastSyncAt) })),
    h('span', { text: `Pending changes: ${pending}` }),
  ];
  if (isSyncing()) parts.push(h('span', { class: 'muted', text: 'Syncing...' }));
  if (state.lastError) parts.push(h('span', { class: 'warn', text: `Last error: ${state.lastError}` }));
  el.replaceChildren(...parts);
}

/** Sign-in dialog: server address, check, then log in or create an account. */
async function signInFlow({ serverUrl = '', username = '', reauth = false } = {}) {
  const account = await getAccount();
  serverUrl = serverUrl || account.lastServerUrl || '';
  username = username || account.lastUsername || '';
  const urlInput = h('input', {
    class: 'input',
    type: 'url',
    value: serverUrl,
    placeholder: 'https://your-server:8787',
    autocomplete: 'url',
    required: true,
  });
  const userInput = h('input', {
    class: 'input',
    type: 'text',
    value: username,
    autocomplete: 'username',
    autocapitalize: 'off',
    required: true,
  });
  const passInput = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const modeSel = h(
    'select',
    { class: 'input' },
    h('option', { value: 'login', text: 'Sign in to an existing account' }),
    h('option', { value: 'register', text: 'Create a new account' }),
  );
  const info = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const checkBtn = h('button', { type: 'button', class: 'btn small', text: 'Check server' });
  checkBtn.addEventListener('click', async () => {
    try {
      const url = normalizeServerUrl(urlInput.value);
      const mc = mixedContentProblem(url);
      if (mc) {
        info.textContent = mc;
        return;
      }
      info.textContent = 'Checking...';
      const health = await checkServer(url);
      info.textContent = `Server found (version ${health.version}). ${health.registrationOpen ? 'New accounts can be created.' : 'New accounts are closed; sign in with an existing account.'}`;
    } catch (e) {
      info.textContent = e.message;
    }
  });
  const body = h(
    'div',
    { class: 'stack' },
    field('Server address', urlInput, 'The address of your Bill Generator sync server. You can change it later.'),
    h('div', { class: 'row' }, checkBtn),
    field('Account', modeSel),
    field('Username', userInput),
    field('Password', passInput, 'At least 8 characters.'),
    info,
  );
  modeSel.addEventListener('change', () => {
    passInput.autocomplete = modeSel.value === 'register' ? 'new-password' : 'current-password';
  });

  for (;;) {
    const r = await dialog({
      title: reauth ? 'Sign in again' : 'Sign in to a sync server',
      body,
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Continue', value: 'ok', primary: true },
      ],
    });
    if (r !== 'ok') return;
    try {
      const url = normalizeServerUrl(urlInput.value);
      const mc = mixedContentProblem(url);
      if (mc) throw new Error(mc);
      await checkServer(url);
      const next = await authenticate(url, userInput.value, passInput.value, {
        register: modeSel.value === 'register',
      });
      const sameAccount = account.mode === 'user' && account.user?.id === next.user.id && account.serverUrl === url;
      if (!sameAccount) {
        // A guest (or a different account) signing in: confirm merging this device's data.
        const merge = await confirmDialog(
          "Upload this device's data?",
          'Your templates, bills, business profile and settings on this device will be merged into this account and backed up to the server. Data already on the server will also download to this device.',
          { okLabel: 'Merge and sign in' },
        );
        if (!merge) return;
        await resetSyncState();
        await markAllDirty();
      }
      await setAccount(next);
      toast(`Signed in as ${next.user.username}.`);
      await renderSettings();
      const res = await syncNow();
      if (res && res.error) toast(`Signed in, but the first sync failed: ${res.error}`, { error: true });
      else hooks.onDataChanged();
      return;
    } catch (e) {
      info.textContent = e.message;
      passInput.value = '';
    }
  }
}

async function signOutFlow() {
  const pending = await pendingCount();
  const r = await dialog({
    title: 'Sign out',
    body: h(
      'div',
      {},
      h('p', { text: 'Your data on the server is not affected. What should happen to the data on this device?' }),
      pending
        ? h('p', {
            class: 'warn',
            text: `${pending} change(s) have not synced yet. Sync first if you want them on the server.`,
          })
        : null,
    ),
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Erase from this device', value: 'erase', danger: true },
      { label: 'Keep on this device', value: 'keep', primary: true },
    ],
  });
  if (r !== 'keep' && r !== 'erase') return;
  await signOut();
  await resetSyncState();
  if (r === 'erase') {
    await eraseSyncedData();
    // The open bill and its saved draft hold customer and business details too.
    await hooks.onErased?.();
  }
  toast(r === 'erase' ? 'Signed out and erased local data.' : 'Signed out. Your data stays on this device.');
  await renderSettings();
  hooks.onDataChanged();
}

// ---------- Business profile ----------

const PROFILE_FIELDS = [
  ['business_name', 'Business name', 'text'],
  ['business_address', 'Address', 'textarea'],
  ['business_phone', 'Phone', 'tel'],
  ['business_email', 'Email', 'email'],
  ['business_gstin', 'GSTIN', 'text'],
  ['business_logo', 'Logo', 'image'],
  ['business_signature', 'Signature', 'image'],
];

function profileSection(profile) {
  const values = { ...profile };
  const controls = PROFILE_FIELDS.map(([key, label, type]) => {
    if (type === 'image') {
      const img = h('img', { class: 'thumb', alt: '', hidden: !values[key] });
      if (values[key]) img.src = values[key];
      const choose = h('button', {
        type: 'button',
        class: 'btn small',
        text: 'Choose image',
        onclick: async () => {
          const file = await pickFile('image/png,image/jpeg,image/webp,image/gif');
          if (!file) return;
          try {
            values[key] = await readImageAsDataUrl(file);
            img.src = values[key];
            img.hidden = false;
          } catch (e) {
            toast(e.message, { error: true });
          }
        },
      });
      const remove = h('button', {
        type: 'button',
        class: 'btn small ghost',
        text: 'Remove',
        onclick: () => {
          values[key] = '';
          img.hidden = true;
        },
      });
      return h(
        'div',
        { class: 'field' },
        h('span', { text: label }),
        h('div', { class: 'image-row' }, img, choose, remove),
      );
    }
    const input =
      type === 'textarea'
        ? h('textarea', { class: 'input', rows: 3, value: values[key] || '' })
        : h('input', { class: 'input', type, value: values[key] || '' });
    input.addEventListener('input', () => {
      values[key] = input.value;
    });
    return field(label, input);
  });
  return card(
    'Business profile',
    h('p', { class: 'muted', text: 'Saved once and filled into every new bill whose template uses these fields.' }),
    h('div', { class: 'grid2' }, controls),
    h(
      'div',
      { class: 'row' },
      h('button', {
        type: 'button',
        class: 'btn primary',
        text: 'Save profile',
        onclick: async () => {
          await saveProfile(values);
          toast('Business profile saved.');
        },
      }),
    ),
  );
}

// ---------- Invoice numbering ----------

function numberingSection(s) {
  const prefix = h('input', { class: 'input', type: 'text', value: s.invoicePrefix });
  const next = h('input', { class: 'input', type: 'number', min: '1', step: '1', value: String(s.invoiceNext) });
  const pad = h('input', {
    class: 'input',
    type: 'number',
    min: '0',
    max: '10',
    step: '1',
    value: String(s.invoicePad),
  });
  const example = h('p', { class: 'muted' });
  const upd = () => {
    example.textContent = `Next invoice number: ${formatInvoiceNumber({ invoicePrefix: prefix.value, invoiceNext: next.value, invoicePad: pad.value })}`;
  };
  [prefix, next, pad].forEach((i) => i.addEventListener('input', upd));
  upd();
  return card(
    'Invoice numbering',
    h(
      'div',
      { class: 'grid3' },
      field('Prefix', prefix),
      field('Next number', next),
      field('Digits', pad, 'Pads with zeros, e.g. 3 gives 001'),
    ),
    example,
    h(
      'div',
      { class: 'row' },
      h('button', {
        type: 'button',
        class: 'btn primary',
        text: 'Save numbering',
        onclick: async () => {
          await saveSettings({
            invoicePrefix: prefix.value,
            invoiceNext: Math.max(1, parseInt(next.value, 10) || 1),
            invoicePad: Math.max(0, Math.min(10, parseInt(pad.value, 10) || 0)),
          });
          toast('Invoice numbering saved. It applies to new bills.');
          hooks.onDataChanged();
        },
      }),
    ),
  );
}

// ---------- Formatting ----------

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'NPR', 'LKR', 'PKR', 'BDT', 'SGD', 'AUD', 'CAD'];
const LOCALES = [
  ['en-IN', 'English (India)'],
  ['hi-IN', 'Hindi (India)'],
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-AE', 'English (UAE)'],
  ['de-DE', 'German'],
  ['fr-FR', 'French'],
];
const DATE_FORMATS = ['DD/MM/YYYY', 'DD-MM-YYYY', 'DD MMM YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMMM YYYY'];

function formatSection(s) {
  const locale = h(
    'select',
    { class: 'input' },
    LOCALES.map(([v, l]) => h('option', { value: v, text: l, selected: s.locale === v })),
  );
  const currency = h(
    'select',
    { class: 'input' },
    CURRENCIES.map((c) => h('option', { value: c, text: c, selected: s.currency === c })),
  );
  const dateFormat = h(
    'select',
    { class: 'input' },
    DATE_FORMATS.map((f) => h('option', { value: f, text: f, selected: s.dateFormat === f })),
  );
  const words = h(
    'select',
    { class: 'input' },
    h('option', { value: 'indian', text: 'Lakh / crore', selected: s.wordsStyle === 'indian' }),
    h('option', { value: 'international', text: 'Million / billion', selected: s.wordsStyle === 'international' }),
  );
  const example = h('p', { class: 'muted' });
  const read = () => ({
    locale: locale.value,
    currency: currency.value,
    dateFormat: dateFormat.value,
    wordsStyle: words.value,
  });
  const upd = () => {
    const f = read();
    example.textContent = `Example: ${formatCurrency(296500.5, f)} on ${formatDate(todayIso(), f)}`;
  };
  [locale, currency, dateFormat, words].forEach((i) => i.addEventListener('change', upd));
  upd();
  return card(
    'Formatting',
    h(
      'div',
      { class: 'grid2' },
      field('Number format', locale),
      field('Currency', currency),
      field('Date format', dateFormat),
      field('Amount in words', words),
    ),
    example,
    h(
      'div',
      { class: 'row' },
      h('button', {
        type: 'button',
        class: 'btn primary',
        text: 'Save formatting',
        onclick: async () => {
          await saveSettings(read());
          toast('Formatting saved.');
          hooks.onDataChanged();
        },
      }),
    ),
  );
}

// ---------- Appearance ----------

function appearanceSection() {
  const current = getTheme();
  const opt = (value, label) =>
    h(
      'label',
      { class: 'check' },
      h('input', { type: 'radio', name: 'theme', value, checked: current === value, onchange: () => setTheme(value) }),
      h('span', { text: label }),
    );
  return card(
    'Appearance',
    h(
      'div',
      { class: 'row', role: 'radiogroup', 'aria-label': 'Theme' },
      opt('system', 'Match device'),
      opt('light', 'Light'),
      opt('dark', 'Dark'),
    ),
    h('p', { class: 'muted small', text: "Bills always print in the template's own colors." }),
  );
}

// ---------- Backup ----------

function backupSection() {
  return card(
    'Backup file',
    h('p', {
      class: 'muted',
      text: 'Export all templates, bills, profile and settings as one JSON file, or import one. Importing merges: newer records win. Imported templates go through the security filter.',
    }),
    h(
      'div',
      { class: 'row' },
      h('button', {
        type: 'button',
        class: 'btn',
        text: 'Export backup',
        onclick: async () => {
          const data = await exportBackup();
          downloadFile(`bill-generator-backup-${todayIso()}.json`, JSON.stringify(data), 'application/json');
        },
      }),
      h('button', {
        type: 'button',
        class: 'btn',
        text: 'Import backup',
        onclick: async () => {
          const file = await pickFile('.json,application/json');
          if (!file) return;
          try {
            const json = JSON.parse(await file.text());
            if (
              !(await confirmDialog(
                'Import backup?',
                'Records from the file will be merged into this device. Newer records win.',
                { okLabel: 'Import' },
              ))
            )
              return;
            const n = await importBackup(json, { sanitizeTemplateHtml: (html) => sanitizeTemplate(html).html });
            toast(`Imported ${n} record(s).`);
            hooks.onDataChanged();
            renderSettings();
          } catch (e) {
            toast(`Import failed: ${e.message}`, { error: true });
          }
        },
      }),
    ),
  );
}
