/**
 * Simple XOR + Base64 encryption for PosFlow backups
 * This provides basic obfuscation for backup files
 */

const ENCRYPTION_KEY = 'PosFlow2024SecureBackup';
const BACKUP_PREFIX = 'HPBK_';

/**
 * Encrypt backup data using XOR cipher + Base64 encoding
 */
export const encryptBackup = (data: object): string => {
  try {
    const jsonString = JSON.stringify(data);
    let encrypted = '';
    
    for (let i = 0; i < jsonString.length; i++) {
      const charCode = jsonString.charCodeAt(i) ^ ENCRYPTION_KEY.charCodeAt(i % ENCRYPTION_KEY.length);
      encrypted += String.fromCharCode(charCode);
    }
    
    // Convert to Base64 and add prefix for identification
    return BACKUP_PREFIX + btoa(unescape(encodeURIComponent(encrypted)));
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('فشل في تشفير البيانات');
  }
};

/**
 * Decrypt backup data from XOR cipher + Base64 encoding
 */
export const decryptBackup = (encryptedData: string): object | null => {
  try {
    // Check if it's an encrypted backup file
    if (!isEncryptedBackup(encryptedData)) {
      console.error('Invalid backup format: missing prefix');
      return null;
    }
    
    // Remove prefix and decode Base64
    const base64Data = encryptedData.slice(BACKUP_PREFIX.length);
    const decoded = decodeURIComponent(escape(atob(base64Data)));
    
    // XOR decrypt
    let decrypted = '';
    for (let i = 0; i < decoded.length; i++) {
      const charCode = decoded.charCodeAt(i) ^ ENCRYPTION_KEY.charCodeAt(i % ENCRYPTION_KEY.length);
      decrypted += String.fromCharCode(charCode);
    }
    
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('Decryption error:', error);
    return null;
  }
};

/**
 * Check if a string is an encrypted PosFlow backup
 */
export const isEncryptedBackup = (data: string): boolean => {
  return data.startsWith(BACKUP_PREFIX);
};

/**
 * Get backup file extension
 */
export const getBackupFileExtension = (): string => {
  return '.hpbk';
};

/**
 * Get backup MIME type
 */
export const getBackupMimeType = (): string => {
  return 'application/octet-stream';
};

// ───────────────────────── V2: AES-GCM بمفتاح خاص بكل مستخدم/جهاز ─────────────────────────
// الصيغة: HPBK2_ + base64( salt[16] | iv[12] | ciphertext ). المفتاح = PBKDF2(secret, salt).
// النسخ القديمة (HPBK_) تبقى قابلة للقراءة عبر decryptBackupAny للتوافق.
const BACKUP_PREFIX_V2 = 'HPBK2_';
const PBKDF2_ITERATIONS = 100_000;

const toB64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromB64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const deriveKey = async (secret: string, salt: Uint8Array): Promise<CryptoKey> => {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

export const encryptBackupV2 = async (data: object, secret: string): Promise<string> => {
  if (!secret) throw new Error('missing backup secret');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(secret, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data))));
  const out = new Uint8Array(salt.length + iv.length + ct.length);
  out.set(salt, 0); out.set(iv, salt.length); out.set(ct, salt.length + iv.length);
  return BACKUP_PREFIX_V2 + toB64(out);
};

export const isEncryptedBackupAny = (data: string): boolean =>
  data.startsWith(BACKUP_PREFIX_V2) || data.startsWith(BACKUP_PREFIX);

/** يفك V2 بالمفتاح المعطى، أو الصيغة القديمة للتوافق مع النسخ السابقة */
export const decryptBackupAny = async (data: string, secret: string): Promise<object | null> => {
  try {
    if (data.startsWith(BACKUP_PREFIX_V2)) {
      const raw = fromB64(data.slice(BACKUP_PREFIX_V2.length));
      const salt = raw.slice(0, 16);
      const iv = raw.slice(16, 28);
      const key = await deriveKey(secret, salt);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, raw.slice(28));
      return JSON.parse(new TextDecoder().decode(pt));
    }
    return decryptBackup(data);
  } catch (error) {
    console.error('Decryption error:', error);
    return null;
  }
};

/** سر محلي عشوائي خاص بهذا الجهاز لحماية النسخة المحلية (يُولَّد مرة واحدة) */
export const getDeviceBackupSecret = (): string => {
  const K = 'hp_device_bk_secret';
  try {
    let v = localStorage.getItem(K);
    if (!v) {
      v = toB64(crypto.getRandomValues(new Uint8Array(32)));
      localStorage.setItem(K, v);
    }
    return v;
  } catch {
    return 'volatile-' + Math.random().toString(36).slice(2);
  }
};
