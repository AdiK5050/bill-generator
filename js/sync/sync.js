// Sync client and scheduler.
// Runs only while the app is open; also on app open, when changes are made and when the app is hidden.
import {
  getDirtyRecords,
  markClean,
  applyRemote,
  toWire,
  getLocal,
  setLocal,
  countDirty,
  onChange,
} from '../storage.js';
import { getAccount, setAccount, api, ApiError } from './account.js';

export const DEFAULT_SYNC_CONFIG = {
  schedule: 'interval', // 'manual' | 'interval' | 'daily'
  intervalMinutes: 15,
  dailyTime: '21:00',
  onOpen: true,
  onChange: true,
  onHide: true,
};
export const INTERVAL_CHOICES = [5, 15, 30, 60, 360];
const CHANGE_DEBOUNCE_MS = 5000;
const MAX_BATCH = 200; // records per request
// Bytes per request. Bills carry a template snapshot and images, so count size too;
// the reference server rejects bodies over 50 MB.
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

/** Take dirty records up to the count and size limits (always at least one). */
function takeBatch(all) {
  const batch = [];
  const changes = [];
  let bytes = 0;
  for (const item of all) {
    if (batch.length >= MAX_BATCH) break;
    const wire = toWire(item.store, item.record);
    const size = encoder.encode(JSON.stringify(wire)).length;
    if (batch.length && bytes + size > MAX_BATCH_BYTES) break;
    batch.push(item);
    changes.push(wire);
    bytes += size;
  }
  return { batch, changes };
}

export async function getSyncConfig() {
  return { ...DEFAULT_SYNC_CONFIG, ...((await getLocal('syncConfig')) || {}) };
}
export async function setSyncConfig(cfg) {
  await setLocal('syncConfig', { ...DEFAULT_SYNC_CONFIG, ...cfg });
  scheduler.reschedule();
}

/** { lastRev, lastSyncAt, lastError, lastErrorAt } */
export async function getSyncState() {
  return (await getLocal('syncState')) || { lastRev: 0, lastSyncAt: null, lastError: null };
}
async function patchSyncState(patch) {
  const s = { ...(await getSyncState()), ...patch };
  await setLocal('syncState', s);
  window.dispatchEvent(new CustomEvent('sync-status', { detail: { ...s, running: running !== null } }));
  return s;
}

let running = null;

/** Run one sync now. Safe to call repeatedly; concurrent calls share one run. */
export function syncNow() {
  if (running) return running;
  running = doSync().finally(() => {
    running = null;
    getSyncState().then((s) =>
      window.dispatchEvent(new CustomEvent('sync-status', { detail: { ...s, running: false } })),
    );
  });
  return running;
}

export function isSyncing() {
  return running !== null;
}

async function doSync() {
  const account = await getAccount();
  if (account.mode !== 'user' || !account.token) return { skipped: 'guest' };
  if (!navigator.onLine) {
    await patchSyncState({
      lastError: 'Offline. Changes will sync when you are back online.',
      lastErrorAt: Date.now(),
    });
    return { skipped: 'offline' };
  }
  window.dispatchEvent(new CustomEvent('sync-status', { detail: { ...(await getSyncState()), running: true } }));
  try {
    let state = await getSyncState();
    let pulled = 0;
    let pushed = 0;
    // Loop: push in batches; each response also carries server changes since lastRev.
    for (let guard = 0; guard < 1000; guard++) {
      const all = await getDirtyRecords();
      const { batch: dirty, changes } = takeBatch(all);
      const res = await api(account.serverUrl, '/api/sync', {
        method: 'POST',
        token: account.token,
        body: { since: state.lastRev || 0, changes },
        timeoutMs: 60000,
      });
      if (!res || typeof res.rev !== 'number' || !Array.isArray(res.changes))
        throw new ApiError('Unexpected response from the server.', 0);
      await markClean(dirty.map(({ store, record }) => ({ store, id: record.id, updatedAt: record.updatedAt })));
      pulled += await applyRemote(res.changes);
      pushed += changes.length;
      state = await patchSyncState({ lastRev: res.rev });
      if (dirty.length === all.length) break;
    }
    await patchSyncState({ lastSyncAt: Date.now(), lastError: null, lastErrorAt: null });
    return { pushed, pulled };
  } catch (e) {
    if (e instanceof ApiError && e.status === 413) {
      await patchSyncState({
        lastError:
          'A bill or template is too large for the server (often a very large logo image). Use a smaller image and try again.',
        lastErrorAt: Date.now(),
      });
    } else if (e instanceof ApiError && e.status === 401) {
      // Token expired or revoked: stay usable offline, ask the user to sign in again.
      await setAccount({ ...account, token: null, needsReauth: true });
      await patchSyncState({
        lastError: 'Your session expired. Sign in again to resume syncing.',
        lastErrorAt: Date.now(),
      });
    } else {
      await patchSyncState({ lastError: e.message || String(e), lastErrorAt: Date.now() });
    }
    return { error: e.message };
  }
}

export async function pendingCount() {
  return countDirty();
}

/** Forget the server revision so the next sync pulls everything (used after sign-in). */
export async function resetSyncState() {
  await setLocal('syncState', { lastRev: 0, lastSyncAt: null, lastError: null });
}

// ---------- Scheduler ----------

const scheduler = {
  timer: null,
  changeTimer: null,
  started: false,

  async start() {
    if (this.started) return;
    this.started = true;
    onChange((evt) => {
      if (evt.source === 'local') this.onLocalChange();
    });
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'hidden') {
        const cfg = await getSyncConfig();
        if (cfg.onHide && (await countDirty()) > 0) syncNow();
      } else {
        this.checkDaily();
      }
    });
    window.addEventListener('online', () => syncNow());
    window.addEventListener('account-changed', () => this.reschedule());
    await this.reschedule();
    const cfg = await getSyncConfig();
    if (cfg.onOpen) syncNow();
  },

  generation: 0,

  async reschedule() {
    // Overlapping calls (e.g. a settings change right after sign-in) must not each start a
    // timer: only the newest call sets one.
    const generation = ++this.generation;
    const cfg = await getSyncConfig();
    const account = await getAccount();
    if (generation !== this.generation) return;
    clearInterval(this.timer);
    this.timer = null;
    if (account.mode !== 'user') return;
    if (cfg.schedule === 'interval') {
      const minutes = Math.max(1, Number(cfg.intervalMinutes) || 15);
      this.timer = setInterval(() => syncNow(), minutes * 60000);
    } else if (cfg.schedule === 'daily') {
      this.timer = setInterval(() => this.checkDaily(), 60000);
      this.checkDaily();
    }
  },

  /** Sync once per day after the chosen time, catching up if the app was closed at that time. */
  async checkDaily() {
    const cfg = await getSyncConfig();
    if (cfg.schedule !== 'daily') return;
    const [h, m] = String(cfg.dailyTime || '21:00')
      .split(':')
      .map(Number);
    const due = new Date();
    due.setHours(h || 0, m || 0, 0, 0);
    if (Date.now() < due.getTime()) due.setDate(due.getDate() - 1); // most recent occurrence
    const state = await getSyncState();
    if (!state.lastSyncAt || state.lastSyncAt < due.getTime()) syncNow();
  },

  async onLocalChange() {
    const cfg = await getSyncConfig();
    if (!cfg.onChange) return;
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => syncNow(), CHANGE_DEBOUNCE_MS);
  },
};

export function startScheduler() {
  return scheduler.start();
}
