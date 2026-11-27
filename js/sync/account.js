// Guest / signed-in state and server auth.
import { getLocal, setLocal } from '../storage.js';

const ACCOUNT_KEY = 'account';
const REQUEST_TIMEOUT_MS = 15000;

/** @typedef {{ mode: 'guest'|'user', serverUrl?: string, token?: string, user?: {id: string, username: string} }} Account */

export async function getAccount() {
  return (await getLocal(ACCOUNT_KEY)) || { mode: 'guest' };
}

export async function setAccount(account) {
  await setLocal(ACCOUNT_KEY, account);
  window.dispatchEvent(new CustomEvent('account-changed', { detail: account }));
}

export async function isSignedIn() {
  const a = await getAccount();
  return a.mode === 'user' && !!a.token;
}

/** Normalize a user-typed server address: trim, add http(s) if missing, drop trailing slash. */
export function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter the server address.');
  if (!/^https?:\/\//i.test(s)) s = (isLocalHost(s) ? 'http://' : 'https://') + s;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new Error('That does not look like a valid address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Use an http:// or https:// address.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function isLocalHost(s) {
  return /^(localhost|127\.|\[::1\])/i.test(s);
}

/** Warn when an https page would call an http server (blocked by browsers as mixed content). */
export function mixedContentProblem(serverUrl) {
  try {
    const u = new URL(serverUrl);
    const localTarget = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (location.protocol === 'https:' && u.protocol === 'http:' && !localTarget) {
      return 'This app is open over HTTPS, so browsers block calls to an http:// server. Use an https:// server address, or open the app over http on your local network.';
    }
  } catch {
    /* ignore */
  }
  return null;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Call the sync server. Throws ApiError with a readable message. */
export async function api(serverUrl, path, { method = 'GET', body, token, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(serverUrl + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new ApiError('The server did not respond in time.', 0);
    throw new ApiError(
      mixedContentProblem(serverUrl) || 'Could not reach the server. Check the address and that the server is running.',
      0,
    );
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new ApiError((data && data.error) || `Server error (${res.status}).`, res.status);
  return data;
}

/** Check that the address points at a compatible sync server. */
export async function checkServer(serverUrl) {
  const info = await api(serverUrl, '/api/health', { timeoutMs: 8000 });
  if (!info || info.ok !== true || info.name !== 'bill-generator-sync') {
    throw new ApiError('That address is reachable but is not a Bill Generator sync server.', 0);
  }
  return info;
}

/** Log in or register. Returns the new account object (not yet saved). */
export async function authenticate(serverUrl, username, password, { register = false } = {}) {
  const data = await api(serverUrl, register ? '/api/register' : '/api/login', {
    method: 'POST',
    body: { username: String(username).trim(), password: String(password) },
  });
  if (!data || !data.token || !data.user) throw new ApiError('Unexpected response from the server.', 0);
  return { mode: 'user', serverUrl, token: data.token, user: data.user };
}

/** Revoke the token on the server (best effort) and return to guest mode. */
export async function signOut() {
  const a = await getAccount();
  if (a.mode === 'user' && a.token) {
    try {
      await api(a.serverUrl, '/api/logout', { method: 'POST', token: a.token, timeoutMs: 5000 });
    } catch {
      /* offline is fine */
    }
  }
  await setAccount({ mode: 'guest', lastServerUrl: a.serverUrl, lastUsername: a.user?.username });
}
