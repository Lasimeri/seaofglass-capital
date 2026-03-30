// Orchestrates the full compression/encryption pipeline
// Create: html -> deflate -> AES-GCM -> base64 -> LZMA -> base64
// Read:   base64 -> LZMA -> base64 -> AES-GCM -> deflate -> html

import { generateKey, exportKey, importKey, base64url, unbase64url } from './crypto.js?v=2';
import { compress, decompress } from './compress.js?v=1';

// --- Chunked base64 for large arrays (avoids stack overflow) ---

function arrayToBase64(arr) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArray(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// --- Link mode: random key ---

export async function createArchive(html) {
  const key = await generateKey();
  const keyStr = await exportKey(key);

  // 1. Deflate compress
  const compressed = await compress(new TextEncoder().encode(html));

  // 2. AES-256-GCM encrypt
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed);
  const encrypted = new Uint8Array(12 + ct.byteLength);
  encrypted.set(iv);
  encrypted.set(new Uint8Array(ct), 12);

  // 3. Base64url encode
  const b64 = base64url(encrypted);

  // 4. LZMA compress (level 1)
  const { compress: lzmaCompress } = await import('./lzma.js');
  const lzmaOut = await lzmaCompress(new TextEncoder().encode(b64), 1);

  // 5. Base64 encode for transport
  const blob = arrayToBase64(lzmaOut);

  return { blob, key: keyStr };
}

// Unwrap a session-wrapped key (PBKDF2 + AES-GCM, CPU-based)
export async function unwrapSessionKey(wrappedKeyHex, sessionSecret, sessionId) {
  // Decode hex → bytes
  const packed = new Uint8Array(wrappedKeyHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);

  // Derive the same wrapping key the worker used
  const rawSecret = new TextEncoder().encode(sessionSecret);
  const material = await crypto.subtle.importKey('raw', rawSecret, 'PBKDF2', false, ['deriveKey']);
  const wrapKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode(sessionId), iterations: 1000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );

  // Decrypt to get the real encryption key
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrapKey, ct);
  return new TextDecoder().decode(decrypted);
}

export async function readArchive(blob, keyStr) {
  // 1. Base64 decode
  const lzmaBytes = base64ToArray(blob);

  // 2. LZMA decompress
  const { decompress: lzmaDecompress } = await import('./lzma.js');
  const b64Bytes = await lzmaDecompress(lzmaBytes);
  const b64 = new TextDecoder().decode(b64Bytes);

  // 3. Base64url decode
  const encrypted = unbase64url(b64);

  // 4. AES-256-GCM decrypt
  const iv = encrypted.slice(0, 12);
  const ct = encrypted.slice(12);
  const key = await importKey(keyStr);
  const compressed = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);

  // 5. Deflate decompress
  const html = await decompress(new Uint8Array(compressed));

  return new TextDecoder().decode(html);
}

