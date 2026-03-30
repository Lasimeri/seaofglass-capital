// AES-256-GCM encrypt/decrypt
// Pipeline: plaintext -> compress (deflate) -> encrypt -> base64url
// Compression UNDER encryption so ciphertext is smaller

// --- Key management ---

export async function generateKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return base64url(new Uint8Array(raw));
}

export async function importKey(encoded) {
  const raw = unbase64url(encoded);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
}

// --- Link/public mode: random key ---

export async function encrypt(plaintext, key) {
  const compressed = await compress(new TextEncoder().encode(plaintext));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return base64url(out);
}

export async function decrypt(encoded, key) {
  const buf = unbase64url(encoded);
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(await decompress(new Uint8Array(decrypted)));
}

// --- Compression (deflate) ---

export async function compress(data) {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  w.write(data);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

export async function decompress(data) {
  const ds = new DecompressionStream('deflate');
  const w = ds.writable.getWriter();
  w.write(data);
  w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

// --- Size estimation ---

export async function estimateSizes(plaintext) {
  const raw = new TextEncoder().encode(plaintext);
  const compressed = await compress(raw);
  const encrypted = compressed.byteLength + 12 + 16; // iv + auth tag
  const encoded = Math.ceil(encrypted * 4 / 3);
  return { raw: raw.byteLength, compressed: compressed.byteLength, encrypted, encoded };
}

// --- Base64url encoding (chunked for large arrays) ---

export function base64url(buf) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
  }
  return btoa(binary)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unbase64url(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s + '='.repeat((4 - s.length % 4) % 4);
  return Uint8Array.from(atob(pad), c => c.charCodeAt(0));
}
