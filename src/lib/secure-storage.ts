/**
 * Secure Storage Module
 * Encrypts data cached in localStorage with ChaCha20 + HMAC-SHA256 (see local-cipher.ts).
 * Values written by older versions (XOR, format v1) are still readable and are rewritten on first read.
 *
 * The key is a random per-installation secret kept in localStorage, so this protects against casual
 * reading and against editing or moving stored values; it is not a hardware-backed keystore.
 * Never make a trust or authorization decision from local storage alone.
 */

import { open as openBox, seal as sealBox, sha256, utf8 } from './local-cipher';

const PERSISTENT_KEY_STORAGE = 'hp_device_id';

// Generate a unique device key with persistent storage
export const getDeviceKey = (): string => {
  // First: Try to get from session cache
  const cachedSession = sessionStorage.getItem('_hpdk');
  if (cachedSession) return cachedSession;
  
  // Second: Try to get persistent key from localStorage
  try {
    const persistedKey = localStorage.getItem(PERSISTENT_KEY_STORAGE);
    if (persistedKey) {
      sessionStorage.setItem('_hpdk', persistedKey);
      return persistedKey;
    }
  } catch {
    // localStorage might not be available
  }
  
  // Third: Generate a new unique key using crypto API
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  const newKey = 'HP' + Array.from(array).map(b => b.toString(36)).join('') + 'SK';
  
  // Persist to localStorage for future sessions
  try {
    localStorage.setItem(PERSISTENT_KEY_STORAGE, newKey);
  } catch {
    console.warn('Could not persist device key to localStorage');
  }
  
  sessionStorage.setItem('_hpdk', newKey);
  return newKey;
};

// Legacy v1 integrity hash (read path only)
const simpleHash = (str: string): string => {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return Math.abs(hash).toString(36);
};

// Legacy v1 XOR (read path only)
const xorEncrypt = (data: string, keys: string[]): string => {
  let result = data;
  for (const key of keys) {
    let encrypted = '';
    for (let i = 0; i < result.length; i++) {
      const charCode = result.charCodeAt(i) ^ key.charCodeAt(i % key.length);
      encrypted += String.fromCharCode(charCode);
    }
    result = encrypted;
  }
  return result;
};

// XOR decrypt (reverse order of keys)
const xorDecrypt = (data: string, keys: string[]): string => {
  return xorEncrypt(data, [...keys].reverse());
};

export interface SecureStorageOptions {
  expiresIn?: number; // milliseconds until expiration
  namespace?: string;
}

interface StoredData {
  v: number; // version
  s?: string; // salt (v1 only)
  d: string; // encrypted data
  h?: string; // integrity hash (v1 only)
  n?: string; // nonce (v2)
  t?: string; // authentication tag (v2)
  e?: number; // expiration timestamp
}

const LEGACY_VERSION = 1;
const CURRENT_VERSION = 2;

// Legacy key that used to be hardcoded in the bundle. Kept ONLY so existing
// stored values can still be decrypted; never used to encrypt new values.
const LEGACY_APP_SECRET = 'HyperPOS2024SecureStorage';
export const APP_SECRET_STORAGE = 'hp_app_secret';
/** The same secret, encrypted by a hardware-backed key (Android Keystore). Present only on native Android. */
export const WRAPPED_APP_SECRET_STORAGE = 'hp_app_secret_w';

// Secret unwrapped by the native keystore at startup; lives in memory only.
let runtimeAppSecret: string | null = null;

/** Called once at startup by native-key.ts, before anything reads secure storage. */
export const setRuntimeAppSecret = (secret: string): void => {
  runtimeAppSecret = secret;
};

/**
 * Per-installation secret, generated randomly on first use.
 * On Android it is kept only in wrapped form (see native-key.ts) and handed over in memory;
 * elsewhere it is stored in localStorage, which is obfuscation rather than a security boundary.
 */
const getAppSecret = (): string => {
  if (runtimeAppSecret) return runtimeAppSecret;
  let wrappedOnly = false;
  try {
    wrappedOnly = !!localStorage.getItem(WRAPPED_APP_SECRET_STORAGE);
  } catch { /* storage unavailable */ }
  // The secret exists but has not been unwrapped: refuse instead of silently creating a second key
  if (wrappedOnly) throw new Error('SecureStorage: key is not unlocked yet');
  try {
    const existing = localStorage.getItem(APP_SECRET_STORAGE);
    if (existing) return existing;
    const array = new Uint8Array(24);
    crypto.getRandomValues(array);
    const secret = Array.from(array).map(b => b.toString(36)).join('');
    localStorage.setItem(APP_SECRET_STORAGE, secret);
    return secret;
  } catch {
    return LEGACY_APP_SECRET;
  }
};

let cachedMasterKey: { secret: string; key: Uint8Array } | null = null;

/** 32-byte key derived from the per-installation secret. */
const getMasterKey = (): Uint8Array => {
  const secret = getAppSecret();
  if (!cachedMasterKey || cachedMasterKey.secret !== secret) {
    cachedMasterKey = { secret, key: sha256(utf8(`hp-secure-storage-v2|${secret}`)) };
  }
  return cachedMasterKey.key;
};

/**
 * Securely store data with encryption
 */
export const secureSet = (key: string, data: unknown, options: SecureStorageOptions = {}): boolean => {
  // Validate data before processing
  if (data === null || data === undefined) {
    console.warn('SecureStorage: Attempting to store null/undefined data');
    return false;
  }
  
  try {
    const dataString = JSON.stringify(data);
    
    // Additional validation after serialization
    if (!dataString || dataString === 'null' || dataString === 'undefined') {
      console.warn('SecureStorage: Invalid data serialization');
      return false;
    }
    
    const namespace = options.namespace || 'hp_sec';
    const storageKey = `${namespace}_${key}`;

    // Authenticated encryption; the storage key name is bound into the tag
    const box = sealBox(getMasterKey(), dataString, storageKey);

    const stored: StoredData = {
      v: CURRENT_VERSION,
      n: box.n,
      d: box.c,
      t: box.t,
    };
    
    if (options.expiresIn) {
      stored.e = Date.now() + options.expiresIn;
    }
    
    localStorage.setItem(storageKey, JSON.stringify(stored));
    return true;
  } catch (error) {
    console.error('SecureStorage set error:', error);
    return false;
  }
};

/**
 * Retrieve and decrypt data from secure storage
 */
export const secureGet = <T = unknown>(key: string, options: SecureStorageOptions = {}): T | null => {
  try {
    const namespace = options.namespace || 'hp_sec';
    const raw = localStorage.getItem(`${namespace}_${key}`);
    if (!raw) return null;
    
    const stored: StoredData = JSON.parse(raw);
    
    const storageKey = `${namespace}_${key}`;

    // Check expiration
    if (stored.e && Date.now() > stored.e) {
      localStorage.removeItem(storageKey);
      return null;
    }

    if (stored.v === CURRENT_VERSION) {
      const plain = openBox(getMasterKey(), { n: stored.n || '', c: stored.d, t: stored.t || '' }, storageKey);
      if (plain === null) {
        console.error('SecureStorage integrity check failed');
        return null;
      }
      return JSON.parse(plain) as T;
    }

    if (stored.v !== LEGACY_VERSION || !stored.s) {
      console.warn('SecureStorage: unknown stored format');
      return null;
    }

    // Legacy v1 (XOR) value written by an older version
    const deviceKey = getDeviceKey();
    const decoded = decodeURIComponent(escape(atob(stored.d)));
    
    // Decrypt (falls back to the legacy secret for values stored before rotation)
    let decrypted = xorDecrypt(decoded, [getAppSecret(), deviceKey, stored.s]);
    if (simpleHash(decrypted + stored.s) !== stored.h) {
      decrypted = xorDecrypt(decoded, [LEGACY_APP_SECRET, deviceKey, stored.s]);
    }
    
    // Verify integrity
    const hash = simpleHash(decrypted + stored.s);
    if (hash !== stored.h) {
      console.error('SecureStorage integrity check failed');
      return null;
    }
    
    const value = JSON.parse(decrypted) as T;

    // Rewrite in the current format, keeping the original expiry
    try {
      const box = sealBox(getMasterKey(), decrypted, storageKey);
      const upgraded: StoredData = { v: CURRENT_VERSION, n: box.n, d: box.c, t: box.t };
      if (stored.e) upgraded.e = stored.e;
      localStorage.setItem(storageKey, JSON.stringify(upgraded));
    } catch { /* keep the legacy value; it stays readable */ }

    return value;
  } catch (error) {
    console.error('SecureStorage get error:', error);
    return null;
  }
};

/**
 * Remove data from secure storage
 */
export const secureRemove = (key: string, options: SecureStorageOptions = {}): void => {
  const namespace = options.namespace || 'hp_sec';
  localStorage.removeItem(`${namespace}_${key}`);
};

/**
 * Clear all secure storage items with a specific namespace
 */
export const secureClear = (namespace: string = 'hp_sec'): void => {
  const prefix = `${namespace}_`;
  const keysToRemove: string[] = [];
  
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) {
      keysToRemove.push(key);
    }
  }
  
  keysToRemove.forEach(key => localStorage.removeItem(key));
};

/**
 * Check if a key exists and is not expired
 */
export const secureHas = (key: string, options: SecureStorageOptions = {}): boolean => {
  const namespace = options.namespace || 'hp_sec';
  const raw = localStorage.getItem(`${namespace}_${key}`);
  if (!raw) return false;
  
  try {
    const stored: StoredData = JSON.parse(raw);
    if (stored.e && Date.now() > stored.e) {
      localStorage.removeItem(`${namespace}_${key}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
};
