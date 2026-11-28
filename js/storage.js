// Local storage in IndexedDB. Offline-first and sync-ready.
//
// Synced stores hold records shaped { id, updatedAt, deleted, dirty, ...data }.
//   templates : user templates { id, name, html, createdAt, updatedAt }
//   bills     : saved bills    { id, templateId, templateName, templateHtml, input, summary, createdAt, updatedAt }
//   kv        : small synced documents { id: 'profile' | 'settings', value }
// Local-only store:
//   local     : device state { id, value } (account, sync config, sync state, deviceId). Never synced.

const DB_NAME = 'bill-generator';
const DB_VERSION = 1;
export const SYNCED_STORES = ['templates', 'bills', 'kv'];
// Synced kv records that never go into backup files, and are ignored when importing one:
// aiKeys holds API keys, encrypted with the user's sync passphrase.
const NO_BACKUP_KV = new Set(['aiKeys']);
const inBackup = (store, id) => !(store === 'kv' && NO_BACKUP_KV.has(id));

let dbPromise = null;
const listeners = new Set();

/** Subscribe to local changes: fn({ store, id, source }) where source is 'local' or 'sync'. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(evt) {
  for (const fn of listeners) {
    try {
      fn(evt);
    } catch (e) {
      console.error(e);
    }
  }
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of SYNCED_STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const os = db.createObjectStore(name, { keyPath: 'id' });
          os.createIndex('dirty', 'dirty', { unique: false });
        }
      }
      if (!db.objectStoreNames.contains('local')) db.createObjectStore('local', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      reject(new Error('Database is open in another tab with an older version. Close other tabs and reload.'));
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    Promise.resolve(fn(t)).then(
      (r) => {
        result = r;
      },
      (e) => {
        try {
          t.abort();
        } catch {
          /* already done */
        }
        reject(e);
      },
    );
  });
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Monotonic timestamp so two quick edits never share an updatedAt. `after` is the record's
 * previous updatedAt: an edit is always newer than the version it was made from, even when
 * this device's clock is behind the device that wrote that version.
 */
let lastStamp = 0;
function stamp(after = 0) {
  lastStamp = Math.max(Date.now(), lastStamp + 1, after + 1);
  return lastStamp;
}

// ---------- Synced records ----------

export async function getRecord(store, id) {
  const rec = await tx([store], 'readonly', (t) => reqToPromise(t.objectStore(store).get(id)));
  return rec && !rec.deleted ? rec : null;
}

export async function listRecords(store) {
  const all = await tx([store], 'readonly', (t) => reqToPromise(t.objectStore(store).getAll()));
  return all.filter((r) => !r.deleted);
}

/** Create or update a record; marks it dirty for sync. */
export async function putRecord(store, record) {
  const now = stamp(record.updatedAt || 0);
  const rec = { createdAt: now, ...record, id: record.id || uuid(), updatedAt: now, deleted: false, dirty: 1 };
  await tx([store], 'readwrite', (t) => reqToPromise(t.objectStore(store).put(rec)));
  emit({ store, id: rec.id, source: 'local' });
  return rec;
}

/** Soft delete (tombstone) so the delete can sync. */
export async function deleteRecord(store, id) {
  const cur = await tx([store], 'readonly', (t) => reqToPromise(t.objectStore(store).get(id)));
  const rec = { id, updatedAt: stamp(cur?.updatedAt || 0), deleted: true, dirty: 1 };
  await tx([store], 'readwrite', (t) => reqToPromise(t.objectStore(store).put(rec)));
  emit({ store, id, source: 'local' });
}

/**
 * Remove a record from this device only, without a tombstone, so nothing syncs. Used for
 * records that belong to a previous account and must not be uploaded to a new one.
 */
export async function forgetRecord(store, id) {
  await tx([store], 'readwrite', (t) => reqToPromise(t.objectStore(store).delete(id)));
  emit({ store, id, source: 'local' });
}

export async function getKv(id, fallback = null) {
  const rec = await getRecord('kv', id);
  return rec ? rec.value : fallback;
}

export async function setKv(id, value) {
  return putRecord('kv', { id, value });
}

// ---------- Local-only ----------

export async function getLocal(id, fallback = null) {
  const rec = await tx(['local'], 'readonly', (t) => reqToPromise(t.objectStore('local').get(id)));
  return rec ? rec.value : fallback;
}

export async function setLocal(id, value) {
  await tx(['local'], 'readwrite', (t) => reqToPromise(t.objectStore('local').put({ id, value })));
}

export async function deleteLocal(id) {
  await tx(['local'], 'readwrite', (t) => reqToPromise(t.objectStore('local').delete(id)));
}

export async function getDeviceId() {
  let id = await getLocal('deviceId');
  if (!id) {
    id = uuid();
    await setLocal('deviceId', id);
  }
  return id;
}

// ---------- Sync support ----------

/** All dirty records (including tombstones) across synced stores. */
export async function getDirtyRecords() {
  return tx(SYNCED_STORES, 'readonly', async (t) => {
    const out = [];
    for (const store of SYNCED_STORES) {
      const recs = await reqToPromise(t.objectStore(store).index('dirty').getAll(1));
      for (const r of recs) out.push({ store, record: r });
    }
    return out;
  });
}

export async function countDirty() {
  return tx(SYNCED_STORES, 'readonly', async (t) => {
    let n = 0;
    for (const store of SYNCED_STORES) n += await reqToPromise(t.objectStore(store).index('dirty').count(1));
    return n;
  });
}

/** Clear dirty flags, but only for records not edited again since they were sent. */
export async function markClean(sent) {
  await tx(SYNCED_STORES, 'readwrite', async (t) => {
    for (const { store, id, updatedAt } of sent) {
      const os = t.objectStore(store);
      const cur = await reqToPromise(os.get(id));
      if (cur && cur.updatedAt === updatedAt && cur.dirty) {
        delete cur.dirty;
        await reqToPromise(os.put(cur));
      }
    }
  });
}

/** Apply records pulled from the server. Never overwrite a newer local dirty record. */
export async function applyRemote(changes) {
  const applied = [];
  await tx(SYNCED_STORES, 'readwrite', async (t) => {
    for (const ch of changes) {
      if (!SYNCED_STORES.includes(ch.store) || typeof ch.id !== 'string') continue;
      const os = t.objectStore(ch.store);
      const cur = await reqToPromise(os.get(ch.id));
      if (cur && cur.dirty && cur.updatedAt > ch.updatedAt) continue;
      if (cur && !cur.dirty && cur.updatedAt > ch.updatedAt) continue;
      const rec = ch.deleted
        ? { id: ch.id, updatedAt: ch.updatedAt, deleted: true }
        : { ...(ch.data || {}), id: ch.id, updatedAt: ch.updatedAt, deleted: false };
      await reqToPromise(os.put(rec));
      applied.push({ store: ch.store, id: ch.id });
    }
  });
  for (const a of applied) emit({ ...a, source: 'sync' });
  return applied.length;
}

/** Turn a stored record into the wire format for the server. */
export function toWire(store, rec) {
  if (rec.deleted) return { store, id: rec.id, updatedAt: rec.updatedAt, deleted: true, data: null };
  const { dirty, deleted, id, updatedAt, ...data } = rec;
  void dirty;
  void deleted;
  return { store, id, updatedAt, deleted: false, data };
}

/** Mark every live record dirty, e.g. when a guest signs in and merges data into an account. */
export async function markAllDirty() {
  await tx(SYNCED_STORES, 'readwrite', async (t) => {
    for (const store of SYNCED_STORES) {
      const os = t.objectStore(store);
      const all = await reqToPromise(os.getAll());
      for (const r of all) {
        r.dirty = 1;
        await reqToPromise(os.put(r));
      }
    }
  });
}

/** Erase all synced data on this device (used on sign-out with "erase"). Keeps deviceId. */
export async function eraseSyncedData() {
  await tx(SYNCED_STORES, 'readwrite', async (t) => {
    for (const store of SYNCED_STORES) await reqToPromise(t.objectStore(store).clear());
  });
  emit({ store: '*', id: null, source: 'local' });
}

// ---------- Backup (JSON export / import) ----------

export async function exportBackup() {
  const data = {};
  for (const store of SYNCED_STORES) {
    data[store] = (await listRecords(store))
      .filter((r) => inBackup(store, r.id))
      .map((r) => {
        const { dirty, ...rest } = r;
        void dirty;
        return rest;
      });
  }
  return { app: 'bill-generator', format: 1, exportedAt: new Date().toISOString(), data };
}

/**
 * Import a backup. Records are merged: newer updatedAt wins. Templates in a backup are
 * returned so the caller can run them through the security pipeline before saving.
 */
export async function importBackup(json, { sanitizeTemplateHtml } = {}) {
  if (!json || json.app !== 'bill-generator' || !json.data)
    throw new Error('This is not a Bill Generator backup file.');
  let count = 0;
  for (const store of SYNCED_STORES) {
    const recs = Array.isArray(json.data[store]) ? json.data[store] : [];
    for (const r of recs) {
      if (!r || typeof r.id !== 'string' || !inBackup(store, r.id)) continue;
      const existing = await tx([store], 'readonly', (t) => reqToPromise(t.objectStore(store).get(r.id)));
      if (existing && existing.updatedAt >= (r.updatedAt || 0)) continue;
      const rec = { ...r, deleted: false, dirty: 1, updatedAt: Number(r.updatedAt) || stamp() };
      if (store === 'templates') {
        if (typeof rec.html !== 'string' || !sanitizeTemplateHtml) continue;
        rec.html = sanitizeTemplateHtml(rec.html);
      }
      if (store === 'bills' && typeof rec.templateHtml === 'string' && sanitizeTemplateHtml) {
        rec.templateHtml = sanitizeTemplateHtml(rec.templateHtml);
      }
      await tx([store], 'readwrite', (t) => reqToPromise(t.objectStore(store).put(rec)));
      count++;
    }
  }
  emit({ store: '*', id: null, source: 'local' });
  return count;
}
