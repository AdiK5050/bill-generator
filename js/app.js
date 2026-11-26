// App entry: routing between views, first-launch welcome, sync wiring, service worker.
import { h, dialog } from './ui/dom.js';
import {
  initBillView,
  newBill,
  openBill,
  refreshTemplateList,
  onExternalChange,
  onShow as onBillShow,
} from './ui/bill-view.js';
import { initTemplatesView, renderLibrary } from './ui/templates-view.js';
import { initHistoryView, renderHistory } from './ui/history-view.js';
import { initSettingsView, renderSettings } from './ui/settings-view.js';
import { applyTheme } from './settings.js';
import { getLocal, setLocal, onChange, countDirty } from './storage.js';
import { getAccount } from './sync/account.js';
import { startScheduler, getSyncState, isSyncing } from './sync/sync.js';

const VIEWS = ['bill', 'templates', 'history', 'settings'];

function currentView() {
  const v = location.hash.replace(/^#\/?/, '');
  return VIEWS.includes(v) ? v : 'bill';
}

async function show(view) {
  for (const v of VIEWS) {
    document.getElementById(`view-${v}`).hidden = v !== view;
    const link = document.querySelector(`[data-nav="${v}"]`);
    if (link) link.setAttribute('aria-current', v === view ? 'page' : 'false');
  }
  if (view === 'bill') onBillShow();
  if (view === 'templates') await renderLibrary();
  if (view === 'history') await renderHistory();
  if (view === 'settings') await renderSettings();
  document.getElementById('main').focus({ preventScroll: true });
}

function go(view) {
  if (location.hash !== `#/${view}`) location.hash = `#/${view}`;
  else show(view);
}

async function refreshSyncChip() {
  const chip = document.getElementById('sync-chip');
  const account = await getAccount();
  if (account.mode !== 'user') {
    chip.textContent = 'Guest';
    chip.title = 'Using the app as a guest. Data stays on this device.';
    chip.dataset.state = 'guest';
    return;
  }
  const [state, pending] = await Promise.all([getSyncState(), countDirty()]);
  let label = 'Synced';
  let st = 'ok';
  if (isSyncing()) {
    label = 'Syncing';
    st = 'busy';
  } else if (!account.token || account.needsReauth) {
    label = 'Sign in again';
    st = 'error';
  } else if (state.lastError) {
    label = navigator.onLine ? 'Sync error' : 'Offline';
    st = 'error';
  } else if (pending) {
    label = `${pending} pending`;
    st = 'pending';
  }
  chip.textContent = label;
  chip.dataset.state = st;
  chip.title = `Signed in as ${account.user?.username}. Last synced: ${state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : 'never'}${state.lastError ? `. ${state.lastError}` : ''}`;
}

/** First launch: guest or sign in. */
async function welcome() {
  if (await getLocal('welcomed')) return;
  const r = await dialog({
    title: 'Welcome to Bill Generator',
    body: h(
      'div',
      {},
      h('p', {
        text: 'Create bills and invoices from templates, preview them live, and print or save them as PDF. Works offline.',
      }),
      h('p', {
        class: 'muted',
        text: 'Use it as a guest and your data stays on this device. If you run your own sync server, sign in to back up and sync your data between devices. You can sign in later from Settings.',
      }),
    ),
    buttons: [
      { label: 'Sign in to a server', value: 'signin' },
      { label: 'Continue as guest', value: 'guest', primary: true },
    ],
  });
  await setLocal('welcomed', true);
  if (r === 'signin') {
    go('settings');
    setTimeout(() => document.querySelector('#view-settings .settings-card .btn.primary')?.click(), 50);
  }
}

async function main() {
  applyTheme();
  const billRoot = document.getElementById('view-bill');
  await initBillView(billRoot);
  await initTemplatesView(document.getElementById('view-templates'), {
    onUse: async (id) => {
      await newBill({ templateId: id });
      go('bill');
    },
    onLibraryChanged: () => refreshTemplateList(),
  });
  await initHistoryView(document.getElementById('view-history'), {
    onOpen: async (id) => {
      await openBill(id);
      go('bill');
    },
    onDuplicate: async (id) => {
      await openBill(id, { duplicate: true });
      go('bill');
    },
  });
  await initSettingsView(document.getElementById('view-settings'), { onDataChanged: () => onExternalChange() });

  window.addEventListener('hashchange', () => show(currentView()));
  document.querySelectorAll('[data-nav]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      go(a.dataset.nav);
    }),
  );
  await show(currentView());

  // Data that arrives from a sync refreshes what is on screen, without interrupting typing.
  onChange(async (evt) => {
    refreshSyncChip();
    if (evt.source !== 'sync') return;
    const view = currentView();
    if (view === 'history' && evt.store === 'bills') renderHistory();
    if (view === 'templates' && evt.store === 'templates') renderLibrary();
    if (evt.store === 'templates' || evt.store === 'kv') {
      const typing = document.activeElement && billRoot.contains(document.activeElement);
      if (typing) refreshTemplateList();
      else onExternalChange();
    }
  });
  window.addEventListener('sync-status', refreshSyncChip);
  window.addEventListener('account-changed', refreshSyncChip);
  window.addEventListener('online', refreshSyncChip);
  window.addEventListener('offline', refreshSyncChip);
  document.getElementById('sync-chip').addEventListener('click', () => go('settings'));
  refreshSyncChip();

  await startScheduler();
  welcome();
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            const bar = document.getElementById('update-bar');
            bar.hidden = false;
            bar.querySelector('button').onclick = () => location.reload();
          }
        });
      });
    })
    .catch((e) => console.warn('Service worker registration failed', e));
}

main().catch((e) => {
  console.error(e);
  const el = document.getElementById('fatal');
  el.hidden = false;
  el.textContent = `The app could not start: ${e.message}`;
});
