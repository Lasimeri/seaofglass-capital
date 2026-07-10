// Public-key management.
// The archive public key is derived from the seed once and cached (public data,
// safe to persist). The seed itself is NEVER stored: it is entered on demand,
// used to derive the public key (setup) or the private key in WASM (view), and
// discarded. Archiving uses only the cached public key, so it needs no secret.

import { pubkeyFromSeed } from './wasm.js?v=1';

const PUBKEY_KEY = 'capital.pubkey.v1';

export function getCachedPublicKey() {
  return localStorage.getItem(PUBKEY_KEY);
}

export function clearPublicKey() {
  localStorage.removeItem(PUBKEY_KEY);
}

// Derive the public key from a seed and cache it. Returns the armored key.
// The seed is consumed here and not retained.
export async function setupFromSeed(seed) {
  if (!seed) throw new Error('missing seed');
  const pub = await pubkeyFromSeed(seed);
  localStorage.setItem(PUBKEY_KEY, pub);
  return pub;
}
