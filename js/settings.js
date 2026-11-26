// App settings and business profile (synced through the kv store).
import { getKv, setKv } from './storage.js';
import { DEFAULT_FORMAT } from './engine/index.js';

export const DEFAULT_SETTINGS = {
  ...DEFAULT_FORMAT,
  invoicePrefix: 'INV-',
  invoiceNext: 1,
  invoicePad: 3,
};

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...((await getKv('settings')) || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await setKv('settings', next);
  return next;
}

/** Business profile: a map of business_* values auto-filled into any template. */
export async function getProfile() {
  return (await getKv('profile')) || {};
}

export async function saveProfile(values) {
  const clean = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (k.startsWith('business_') && typeof v === 'string') clean[k] = v;
  }
  await setKv('profile', clean);
  return clean;
}

export function formatInvoiceNumber(settings, n = settings.invoiceNext) {
  const pad = Math.max(0, Math.min(10, Number(settings.invoicePad) || 0));
  return `${settings.invoicePrefix || ''}${String(Math.max(1, Number(n) || 1)).padStart(pad, '0')}`;
}

/** Take the next invoice number and advance the counter. */
export async function claimInvoiceNumber() {
  const s = await getSettings();
  const number = formatInvoiceNumber(s);
  await saveSettings({ invoiceNext: (Number(s.invoiceNext) || 1) + 1 });
  return number;
}

/** Local UI preference (not synced): theme. */
export function getTheme() {
  try {
    return localStorage.getItem('theme') || 'system';
  } catch {
    return 'system';
  }
}
export function setTheme(theme) {
  try {
    localStorage.setItem('theme', theme);
  } catch {
    /* private mode */
  }
  applyTheme(theme);
}
export function applyTheme(theme = getTheme()) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
