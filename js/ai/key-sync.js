// API keys shared across a signed-in user's devices, end-to-end encrypted.
//
// The user picks a sync passphrase. Each device turns it into an AES-GCM key (PBKDF2-SHA-256)
// and encrypts API keys before they are stored in the synced kv record "aiKeys". The sync
// server, its owner and its backups only ever see the encrypted data.
//
// After the passphrase is entered once, the device keeps the derived key as a non-extractable
// CryptoKey in the local-only store: page scripts can use it but never read its bytes, and it
// never syncs. The passphrase itself is not stored anywhere.
//
// Record: { v: 1, salt, iterations, verifier: { iv, ct }, keys: { [provider]: { iv, ct } } }
import { getKv, setKv, deleteRecord, getLocal, setLocal, deleteLocal, onChange } from '../storage.js';

const RECORD_ID = 'aiKeys';
const DEVICE_KEY_ID = 'aiSyncKey';
const VERIFIER_TEXT = 'bill-generator-ai-keys';
const ITERATIONS = 600000; // OWASP's current recommendation for PBKDF2-HMAC-SHA256
export const MIN_PASSPHRASE_LENGTH = 8;

export class PassphraseError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, saltB64, iterations) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false, // not extractable
    ['encrypt', 'decrypt'],
  );
}

// The label (provider name or "verifier") is bound as additional data, so an encrypted key
// cannot be moved to another provider's slot.
async function encrypt(key, text, label) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(label) },
    key,
    encoder.encode(text),
  );
  return { iv: toB64(iv), ct: toB64(ct) };
}

async function decrypt(key, box, label) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(box.iv), additionalData: encoder.encode(label) },
    key,
    fromB64(box.ct),
  );
  return decoder.decode(plain);
}

async function getRecordValue() {
  const value = await getKv(RECORD_ID);
  return value && value.v === 1 && value.salt && value.verifier ? value : null;
}

/** The device key, if this device unlocked the current record (same salt). */
async function getDeviceKey(record) {
  const saved = await getLocal(DEVICE_KEY_ID);
  if (!saved || !record || saved.salt !== record.salt) return null;
  return saved.key;
}

/**
 * Sync state for the UI.
 * exists: a passphrase has been set for this account; unlocked: this device can read the keys;
 * providers: which providers have a synced key.
 */
export async function getKeySyncState() {
  const record = await getRecordValue();
  const key = await getDeviceKey(record);
  return {
    exists: Boolean(record),
    unlocked: Boolean(key),
    providers: record ? Object.keys(record.keys || {}) : [],
  };
}

/** Set the sync passphrase for the first time and unlock this device. */
export async function createPassphrase(passphrase, { iterations = ITERATIONS } = {}) {
  if (await getRecordValue()) throw new PassphraseError('A sync passphrase is already set for this account.');
  if (String(passphrase).length < MIN_PASSPHRASE_LENGTH)
    throw new PassphraseError(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveKey(passphrase, salt, iterations);
  const verifier = await encrypt(key, VERIFIER_TEXT, 'verifier');
  await setKv(RECORD_ID, { v: 1, salt, iterations, verifier, keys: {} });
  await setLocal(DEVICE_KEY_ID, { key, salt });
  notify();
}

/** Unlock this device with the existing passphrase. Throws PassphraseError when it is wrong. */
export async function unlock(passphrase) {
  const record = await getRecordValue();
  if (!record) throw new PassphraseError('No sync passphrase is set for this account yet.');
  const key = await deriveKey(passphrase, record.salt, record.iterations || ITERATIONS);
  try {
    if ((await decrypt(key, record.verifier, 'verifier')) !== VERIFIER_TEXT) throw new Error('mismatch');
  } catch {
    throw new PassphraseError('That passphrase is not right.');
  }
  await setLocal(DEVICE_KEY_ID, { key, salt: record.salt });
  notify();
}

/** Forget the passphrase on this device. Synced keys stay on the server, encrypted. */
export async function lockDevice() {
  await deleteLocal(DEVICE_KEY_ID);
  notify();
}

/** Encrypt and store a key for all devices. The device must be unlocked. */
export async function saveSyncedKey(provider, apiKey) {
  const record = await getRecordValue();
  const key = await getDeviceKey(record);
  if (!key) throw new PassphraseError('Enter your sync passphrase first.');
  const box = await encrypt(key, apiKey, provider);
  await setKv(RECORD_ID, { ...record, keys: { ...(record.keys || {}), [provider]: box } });
}

/** The decrypted key, or null when there is none or this device is locked. */
export async function readSyncedKey(provider) {
  const record = await getRecordValue();
  const box = record?.keys?.[provider];
  if (!box) return null;
  const key = await getDeviceKey(record);
  if (!key) return null;
  try {
    return await decrypt(key, box, provider);
  } catch {
    return null; // tampered with, or written with another passphrase
  }
}

/**
 * Remove a provider's key from all devices. When no keys are left, the passphrase is cleared
 * too, so a new one can be chosen next time.
 */
export async function removeSyncedKey(provider) {
  const record = await getRecordValue();
  if (!record?.keys?.[provider]) return;
  const keys = { ...record.keys };
  delete keys[provider];
  if (Object.keys(keys).length) {
    await setKv(RECORD_ID, { ...record, keys });
  } else {
    await deleteRecord('kv', RECORD_ID);
    await deleteLocal(DEVICE_KEY_ID);
  }
}

function notify() {
  window.dispatchEvent(new CustomEvent('ai-config-changed'));
}

// Keys added or removed on another device arrive through sync.
onChange((evt) => {
  if ((evt.store === 'kv' && evt.id === RECORD_ID) || evt.store === '*') notify();
});
