import { Capacitor } from '@capacitor/core';
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';

/**
 * FlowPOS Pro - Unified Biometric & WebAuthn Authentication Engine
 * Supports:
 *  1. Android / iOS native Capacitor Biometric Auth (@aparajita/capacitor-biometric-auth)
 *  2. Desktop / Browser / PWA / Electron platform biometrics via window.PublicKeyCredential (WebAuthn)
 *     (Windows Hello, Touch ID, Face ID, Android Biometric Prompt)
 */

export async function isBiometricSupported(): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  // 1. Native Capacitor (Android APK / iOS)
  if (Capacitor.isNativePlatform()) {
    try {
      const result = await BiometricAuth.checkBiometry();
      // Returns true if device has biometric hardware and is enrolled, or hardware is present
      return !!result?.isAvailable || !!result?.strongBiometryIsAvailable;
    } catch (err) {
      console.warn('[BiometricAuth] Native checkBiometry error:', err);
      // Fallback on native platform: if BiometricAuth exists, enable biometric option
      return true;
    }
  }

  // 2. Web / Desktop / Electron (WebAuthn Platform Authenticator)
  if (
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
  ) {
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return false;
    }
  }

  return false;
}

export async function registerBiometricCredential(userId: string, userName: string): Promise<string | null> {
  if (typeof window === 'undefined') return null;

  // 1. Native Capacitor mobile uses OS enrolled biometrics directly
  if (Capacitor.isNativePlatform()) {
    return 'capacitor_native_biometric';
  }

  // 2. WebAuthn Platform Authenticator
  if (!window.PublicKeyCredential) return null;

  try {
    const challenge = new Uint8Array(32);
    window.crypto.getRandomValues(challenge);

    const userIdBuffer = new TextEncoder().encode(userId);
    const hostname = window.location.hostname || 'localhost';
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
    const rpId = isIp || !hostname ? undefined : hostname;

    const createOptions: CredentialCreationOptions = {
      publicKey: {
        challenge,
        rp: {
          name: 'FlowPOS Pro',
          ...(rpId ? { id: rpId } : {}),
        },
        user: {
          id: userIdBuffer,
          name: userName || 'cashier',
          displayName: userName || 'Cashier',
        },
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' },  // ES256
          { alg: -257, type: 'public-key' }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 60000,
        attestation: 'none',
      },
    };

    const credential = (await navigator.credentials.create(createOptions)) as PublicKeyCredential | null;
    if (credential) {
      return credential.id;
    }
  } catch (err) {
    console.warn('[BiometricAuth] WebAuthn registration skipped or canceled:', err);
  }

  return null;
}

export async function authenticateBiometric(credentialId?: string | null): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  // 1. Native Capacitor (Android APK / iOS)
  if (Capacitor.isNativePlatform()) {
    try {
      await BiometricAuth.authenticate({
        reason: 'يرجى مسح البصمة لتأكيد الدخول إلى نقطة البيع',
        cancelTitle: 'إلغاء واستخدام الرمز',
      });
      return true;
    } catch (err) {
      console.warn('[BiometricAuth] Native biometric authentication canceled or failed:', err);
      return false;
    }
  }

  // 2. Web / Desktop / Electron (WebAuthn Platform Authenticator)
  if (!window.PublicKeyCredential) return false;

  try {
    const challenge = new Uint8Array(32);
    window.crypto.getRandomValues(challenge);

    const hostname = window.location.hostname || 'localhost';
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
    const rpId = isIp || !hostname ? undefined : hostname;

    const getOptions: CredentialRequestOptions = {
      publicKey: {
        challenge,
        timeout: 60000,
        userVerification: 'required',
        ...(rpId ? { rpId } : {}),
      },
    };

    if (credentialId && credentialId !== 'capacitor_native_biometric') {
      try {
        const rawId = Uint8Array.from(
          atob(credentialId.replace(/-/g, '+').replace(/_/g, '/')),
          (c) => c.charCodeAt(0)
        );
        (getOptions.publicKey as any).allowCredentials = [
          {
            id: rawId,
            type: 'public-key',
            transports: ['internal'],
          },
        ];
      } catch {
        // Fall back to general platform authenticator challenge
      }
    }

    const assertion = await navigator.credentials.get(getOptions);
    return !!assertion;
  } catch (err) {
    console.warn('[BiometricAuth] WebAuthn verification canceled or failed:', err);
    return false;
  }
}
