/**
 * Synchronous authenticated encryption for locally cached data.
 *
 * ChaCha20 (RFC 8439 block function) for confidentiality, HMAC-SHA256 (encrypt-then-MAC) for integrity.
 * Synchronous on purpose: secure-storage is read during startup and inside non-async code paths,
 * so Web Crypto (async only) cannot be used there.
 *
 * SHA-256, HMAC and ChaCha20 were checked against Node crypto and the RFC 8439 test vector.
 * This file has no imports and no side effects.
 */

// ───────────────────────── SHA-256 / HMAC ─────────────────────────

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(message: Uint8Array): Uint8Array {
  const length = message.length;
  const paddedLength = (((length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(length / 0x20000000), false);
  view.setUint32(paddedLength - 4, (length << 3) >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((value, i) => outView.setUint32(i * 4, value >>> 0, false));
  return out;
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockKey = new Uint8Array(64);
  blockKey.set(key.length > 64 ? sha256(key) : key);
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = blockKey[i] ^ 0x36;
    outer[i] = blockKey[i] ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

// ───────────────────────── ChaCha20 (RFC 8439) ─────────────────────────

const rotl = (value: number, shift: number): number => (value << shift) | (value >>> (32 - shift));

/** XORs `data` with the ChaCha20 keystream. Encryption and decryption are the same operation. */
export function chacha20(key: Uint8Array, nonce: Uint8Array, data: Uint8Array, initialCounter = 1): Uint8Array {
  if (key.length !== 32) throw new Error('chacha20: key must be 32 bytes');
  if (nonce.length !== 12) throw new Error('chacha20: nonce must be 12 bytes');

  const keyView = new DataView(key.buffer, key.byteOffset, 32);
  const nonceView = new DataView(nonce.buffer, nonce.byteOffset, 12);
  const state = new Uint32Array(16);
  state[0] = 0x61707865; state[1] = 0x3320646e; state[2] = 0x79622d32; state[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) state[4 + i] = keyView.getUint32(i * 4, true);
  state[12] = initialCounter >>> 0;
  for (let i = 0; i < 3; i++) state[13 + i] = nonceView.getUint32(i * 4, true);

  const out = new Uint8Array(data.length);
  const x = new Uint32Array(16);
  const block = new Uint8Array(64);
  const blockView = new DataView(block.buffer);

  const quarter = (a: number, b: number, c: number, d: number) => {
    x[a] = (x[a] + x[b]) | 0; x[d] = rotl(x[d] ^ x[a], 16);
    x[c] = (x[c] + x[d]) | 0; x[b] = rotl(x[b] ^ x[c], 12);
    x[a] = (x[a] + x[b]) | 0; x[d] = rotl(x[d] ^ x[a], 8);
    x[c] = (x[c] + x[d]) | 0; x[b] = rotl(x[b] ^ x[c], 7);
  };

  for (let offset = 0; offset < data.length; offset += 64) {
    x.set(state);
    for (let round = 0; round < 10; round++) {
      quarter(0, 4, 8, 12); quarter(1, 5, 9, 13); quarter(2, 6, 10, 14); quarter(3, 7, 11, 15);
      quarter(0, 5, 10, 15); quarter(1, 6, 11, 12); quarter(2, 7, 8, 13); quarter(3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i++) blockView.setUint32(i * 4, (x[i] + state[i]) >>> 0, true);
    const end = Math.min(offset + 64, data.length);
    for (let i = offset; i < end; i++) out[i] = data[i] ^ block[i - offset];
    state[12] = (state[12] + 1) >>> 0;
  }
  return out;
}

// ───────────────────────── Sealed box ─────────────────────────

export interface SealedBox {
  /** 12-byte nonce, base64 */
  n: string;
  /** ciphertext, base64 */
  c: string;
  /** HMAC-SHA256 tag over nonce + ciphertext + context, base64 */
  t: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (text: string): Uint8Array => encoder.encode(text);

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};

const subKey = (master: Uint8Array, label: string): Uint8Array => hmacSha256(master, utf8(label));

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

/**
 * Encrypts `plaintext` under `masterKey` (32 bytes).
 * `context` is authenticated but not stored (the storage key name): a value copied to another key fails to open.
 */
export function seal(masterKey: Uint8Array, plaintext: string, context: string): SealedBox {
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ciphertext = chacha20(subKey(masterKey, 'enc'), nonce, utf8(plaintext));
  const tag = hmacSha256(subKey(masterKey, 'mac'), concat(nonce, ciphertext, utf8(context)));
  return { n: toBase64(nonce), c: toBase64(ciphertext), t: toBase64(tag) };
}

/** Returns the plaintext, or null when the box was modified, moved to another key, or sealed with another key. */
export function open(masterKey: Uint8Array, box: SealedBox, context: string): string | null {
  try {
    const nonce = fromBase64(box.n);
    const ciphertext = fromBase64(box.c);
    const expected = hmacSha256(subKey(masterKey, 'mac'), concat(nonce, ciphertext, utf8(context)));
    if (!equalBytes(expected, fromBase64(box.t))) return null;
    return decoder.decode(chacha20(subKey(masterKey, 'enc'), nonce, ciphertext));
  } catch {
    return null;
  }
}
