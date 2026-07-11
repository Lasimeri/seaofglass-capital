// WASM bootstrap for the archive pipeline.
//   ink-brotli — brotli q11 compression / decompression
//   ink-seed   — per-archive key generation
// Encryption is WebCrypto AES-256-GCM (native), keyed by SHA-256 of the seed,
// so no PGP is involved. (PGP was dropped: rPGP corrupts large messages and,
// with the key carried in the link, asymmetric crypto adds no security here.)

import initBrotli, { brotli_compress, brotli_decompress } from './wasm/ink_brotli.js?v=2';
import initSeed, { generate_key } from './wasm/ink_seed.js?v=2';

let ready = null;

export function initWasm() {
  if (!ready) {
    ready = Promise.all([
      initBrotli(new URL('./wasm/ink_brotli_bg.wasm?v=2', import.meta.url)),
      initSeed(new URL('./wasm/ink_seed_bg.wasm?v=2', import.meta.url)),
    ]);
  }
  return ready;
}

export async function brotliCompress(bytes, quality = 11) {
  await initWasm();
  return brotli_compress(bytes, quality);
}

export async function brotliDecompress(bytes) {
  await initWasm();
  return brotli_decompress(bytes);
}

// Fresh per-archive key (256-bit, base64url) from the Rust CSPRNG.
export async function generateKey() {
  await initWasm();
  return generate_key();
}
