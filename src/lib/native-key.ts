/**
 * Hardware-backed protection for the local storage key (Android only).
 *
 * The secure-storage secret is encrypted by an AES key that lives inside Android Keystore and
 * never leaves it. Only the wrapped form is written to localStorage; the usable secret exists in
 * memory after startup. Copying the app's storage files is then not enough to read the cached data.
 *
 * Web and Windows have no keystore here and keep the secret in localStorage as before.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { APP_SECRET_STORAGE, WRAPPED_APP_SECRET_STORAGE, setRuntimeAppSecret } from './secure-storage';

interface FlowPosKeystorePlugin {
  wrap(options: { data: string }): Promise<{ data: string }>;
  unwrap(options: { data: string }): Promise<{ data: string }>;
}

const Keystore = registerPlugin<FlowPosKeystorePlugin>('FlowPosKeystore');

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const newSecret = (): string => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(36)).join('');
};

async function unwrapWithRetry(wrapped: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await Keystore.unwrap({ data: wrapped });
      const secret = atob(data);
      if (secret) return secret;
    } catch (error) {
      console.warn('[NativeKey] unwrap attempt failed:', error);
    }
    await sleep(150 * (attempt + 1));
  }
  return null;
}

/**
 * Must finish before any module reads secure storage (see main.tsx).
 * Never throws: on any failure the app keeps working with the previous storage mode.
 */
export async function initSecureStorageKey(): Promise<void> {
  try {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return;

    const wrapped = localStorage.getItem(WRAPPED_APP_SECRET_STORAGE);
    if (wrapped) {
      const secret = await unwrapWithRetry(wrapped);
      if (secret) {
        setRuntimeAppSecret(secret);
        localStorage.removeItem(APP_SECRET_STORAGE);
        return;
      }
      // Keep the wrapped key and encrypted data recoverable after a transient failure.
      console.error('[NativeKey] stored key could not be unwrapped; preserving it for recovery');
      return;
    }

    // First run on this version: move the existing secret (or a new one) under the keystore
    const secret = localStorage.getItem(APP_SECRET_STORAGE) || newSecret();
    const { data } = await Keystore.wrap({ data: btoa(secret) });
    const check = await Keystore.unwrap({ data });
    if (atob(check.data) !== secret) throw new Error('keystore round-trip mismatch');

    localStorage.setItem(WRAPPED_APP_SECRET_STORAGE, data);
    setRuntimeAppSecret(secret);
    localStorage.removeItem(APP_SECRET_STORAGE);
  } catch (error) {
    // Keystore unavailable: the plain per-installation secret keeps being used (previous behaviour)
    console.warn('[NativeKey] keystore protection not active:', error);
  }
}

