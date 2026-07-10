// Zero-trust archive pipeline.
//   Create: html -> brotli q11 -> PGP encrypt (public key) -> base64
//   Read:   base64 -> PGP decrypt (seed regenerates the private key in WASM)
//                  -> brotli decompress -> html
//
// Encryption needs only the public key (no secret). Decryption needs the seed,
// which is used in-memory to regenerate the private key and is never stored or
// transmitted. The host stores only opaque ciphertext.

import { brotliCompress, brotliDecompress, pgpEncrypt, decryptWithSeed } from './wasm.js?v=1';

// Chunked base64 for large arrays (avoids call-stack overflow on big archives).
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

// html + armored public key -> base64 ciphertext blob for the worker.
export async function createArchive(html, publicKey) {
  if (!publicKey) throw new Error('missing public key');
  const compressed = await brotliCompress(new TextEncoder().encode(html), 11);
  const ciphertext = await pgpEncrypt(compressed, publicKey);
  return arrayToBase64(ciphertext);
}

// base64 ciphertext blob + seed -> html. Seed regenerates the private key
// on-device; a wrong seed throws (PGP decryption fails).
export async function readArchive(blob, seed) {
  if (!seed) throw new Error('missing seed');
  const ciphertext = base64ToArray(blob);
  const compressed = await decryptWithSeed(ciphertext, seed);
  const html = await brotliDecompress(compressed);
  return new TextDecoder().decode(html);
}
