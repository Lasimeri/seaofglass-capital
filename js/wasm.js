// WASM bootstrap for the archive crypto pipeline.
// Two wasm-bindgen (--target web) modules, built from audited source:
//   ink-pgp    — seed-derived Ed25519/X25519 PGP (encrypt / decrypt-with-seed)
//   ink-brotli — brotli q11 compression / decompression
// Loaded once, memoized. All crypto runs on-device; the seed never leaves here.

import initPgp, {
  pgp_encrypt,
  pgp_pubkey_from_seed,
  pgp_decrypt_with_seed,
} from './wasm/ink_pgp.js';
import initBrotli, {
  brotli_compress,
  brotli_decompress,
} from './wasm/ink_brotli.js';
import initSeed, { generate_key } from './wasm/ink_seed.js';

let ready = null;

export function initWasm() {
  if (!ready) {
    ready = Promise.all([
      initPgp(new URL('./wasm/ink_pgp_bg.wasm', import.meta.url)),
      initBrotli(new URL('./wasm/ink_brotli_bg.wasm', import.meta.url)),
      initSeed(new URL('./wasm/ink_seed_bg.wasm', import.meta.url)),
    ]);
  }
  return ready;
}

// Fresh per-archive key (256-bit, base64url) from the Rust CSPRNG.
export async function generateKey() {
  await initWasm();
  return generate_key();
}

export async function brotliCompress(bytes, quality = 11) {
  await initWasm();
  return brotli_compress(bytes, quality);
}

export async function brotliDecompress(bytes) {
  await initWasm();
  return brotli_decompress(bytes);
}

export async function pgpEncrypt(bytes, armoredPublicKey) {
  await initWasm();
  return pgp_encrypt(bytes, armoredPublicKey);
}

// Derive the armored PUBLIC key from a seed (public data; safe to cache).
export async function pubkeyFromSeed(seed) {
  await initWasm();
  return pgp_pubkey_from_seed(new TextEncoder().encode(seed));
}

// Decrypt by regenerating the private key from the seed inside WASM.
// The seed and private key exist only for the duration of this call.
export async function decryptWithSeed(bytes, seed) {
  await initWasm();
  return pgp_decrypt_with_seed(bytes, new TextEncoder().encode(seed));
}
