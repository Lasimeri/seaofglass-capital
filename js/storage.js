// Worker API client for archive-tax

export const WORKER_URL = 'https://archive-tax.seaofglass.workers.dev';

export async function captureUrl(url) {
  const res = await fetch(`${WORKER_URL}/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'capture failed');
  return res.json();
}

export async function fetchResources(urls) {
  const res = await fetch(`${WORKER_URL}/fetch-resources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'fetch failed');
  return res.json();
}

export async function store(blob, meta) {
  const res = await fetch(`${WORKER_URL}/store`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blob, meta }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'store failed');
  return res.json();
}

// Check if an archive exists (lightweight, no blob)
export async function checkArchive(url) {
  const res = await fetch(`${WORKER_URL}/check?url=${encodeURIComponent(url)}`);
  if (!res.ok) return { exists: false };
  return res.json();
}

// Load an archive's ciphertext blob + non-secret metadata. No key is returned;
// decryption happens on-device from the seed.
export async function loadArchive(url) {
  const res = await fetch(`${WORKER_URL}/archive?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'not found');
  return res.json();
}

export async function remove(url, token) {
  const res = await fetch(`${WORKER_URL}/archive?url=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'delete failed');
}
