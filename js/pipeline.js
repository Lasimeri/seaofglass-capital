// Zero-trust archive pipeline.
//   Create: html -> brotli q11 -> AES-256-GCM(key = SHA-256(seed)) -> base64
//   Read:   base64 -> AES-256-GCM decrypt -> brotli decompress -> html
//
// The per-archive seed rides in the link's #fragment (never sent to the server,
// so the host cannot decrypt). The key is derived on-device from the seed via
// SHA-256; a wrong seed fails the GCM auth tag. AES-GCM handles any size.
//
// Blob format (base64 of): [12-byte iv][aes-gcm ciphertext+tag]

import { brotliCompress, brotliDecompress } from './wasm.js?v=4';

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

async function aesKeyFromSeed(seed, usage) {
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('capital-aes-v1' + seed));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, [usage]);
}

export async function createArchive(html, seed) {
  if (!seed) throw new Error('missing key');
  const compressed = await brotliCompress(new TextEncoder().encode(html), 11);
  const key = await aesKeyFromSeed(seed, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return arrayToBase64(out);
}

export async function readArchive(blob, seed) {
  if (!seed) throw new Error('missing key');
  const buf = base64ToArray(blob);
  const iv = buf.subarray(0, 12);
  const ct = buf.subarray(12);
  const key = await aesKeyFromSeed(seed, 'decrypt');
  const compressed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
  const html = await brotliDecompress(compressed);
  return new TextDecoder().decode(html);
}
