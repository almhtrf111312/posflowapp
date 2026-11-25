// مفتاح تشفير الحساب (AES-GCM 256). يُولَّد مرة واحدة عند التسجيل ويُحفظ في جدول
// account_encryption_keys (مقفل بسياسات RLS للمالك فقط). لا يُخزَّن المفتاح على الجهاز بشكل دائم.
import { supabase } from '@/integrations/supabase/client';

const TABLE = 'account_encryption_keys';
const ALGORITHM = { name: 'AES-GCM', length: 256 } as const;
const ENVELOPE_PREFIX = 'HPE2_';
const IV_BYTES = 12;

let cached: { userId: string; key: CryptoKey } | null = null;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
};

const base64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

/**
 * يضمن وجود مفتاح للحساب في السحابة. إن وُجد لا يفعل شيئاً.
 * يرجع false عند تعذر الوصول إلى الجدول (مثلاً قبل تطبيق الـ migration) دون رمي خطأ.
 */
export async function ensureAccountEncryptionKey(userId: string): Promise<boolean> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return false;

  const { data, error } = await supabase.from(TABLE).select('key_material').eq('user_id', userId).maybeSingle();
  if (error) {
    console.warn('[EncryptionKey] Could not read key:', error.message);
    return false;
  }
  if (data?.key_material) return true;

  const key = await crypto.subtle.generateKey(ALGORITHM, true, ['encrypt', 'decrypt']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  const { error: insertError } = await supabase.from(TABLE).insert({
    user_id: userId,
    key_material: bytesToBase64(raw),
  });
  if (insertError) {
    // 23505 = جهاز آخر سجّل المفتاح أولاً؛ نعتبره ناجحاً ونسترجعه لاحقاً
    if (insertError.code === '23505') return true;
    console.warn('[EncryptionKey] Could not save key:', insertError.message);
    return false;
  }
  return true;
}

/** يسترجع مفتاح الحساب من السحابة ويستورده للاستخدام. null إذا لم يوجد أو تعذّر. */
export async function loadAccountEncryptionKey(userId: string): Promise<CryptoKey | null> {
  if (cached && cached.userId === userId) return cached.key;

  const { data, error } = await supabase.from(TABLE).select('key_material').eq('user_id', userId).maybeSingle();
  if (error || !data?.key_material) return null;

  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(data.key_material) as unknown as BufferSource,
    ALGORITHM,
    true,
    ['encrypt', 'decrypt'],
  );
  cached = { userId, key };
  return key;
}

/** تشفير نص بالمفتاح. الناتج: HPE2_ + base64(iv || ciphertext) */
export async function encryptWithAccountKey(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext) as unknown as BufferSource),
  );
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return ENVELOPE_PREFIX + bytesToBase64(packed);
}

/** فك التشفير. يرمي خطأ عند عدم تطابق المفتاح أو تلف البيانات (AES-GCM يتحقق من السلامة). */
export async function decryptWithAccountKey(key: CryptoKey, envelope: string): Promise<string> {
  if (!envelope.startsWith(ENVELOPE_PREFIX)) throw new Error('صيغة التشفير غير معروفة');
  const packed = base64ToBytes(envelope.slice(ENVELOPE_PREFIX.length));
  const iv = packed.slice(0, IV_BYTES);
  const cipher = packed.slice(IV_BYTES);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    cipher as unknown as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

/**
 * Raw key material (base64) of the account key, used as the secret for cloud backup encryption.
 * Creates the key on first use. Returns null when the table cannot be reached.
 */
export async function getAccountKeyMaterial(userId: string): Promise<string | null> {
  try {
    await ensureAccountEncryptionKey(userId);
    const { data, error } = await supabase.from(TABLE).select('key_material').eq('user_id', userId).maybeSingle();
    if (error || !data?.key_material) return null;
    return String(data.key_material);
  } catch {
    return null;
  }
}
