import { captureUrl, fetchResources, store, checkArchive, loadArchive, remove, WORKER_URL } from './storage.js?v=4';
import { assembleArchive } from './capture.js?v=2';
import { createArchive, readArchive } from './pipeline.js?v=4';
import { prepareForDisplay } from './sanitize.js?v=1';
import { getCachedPublicKey, setupFromSeed } from './keys.js?v=1';

const $ = s => document.querySelector(s);

// --- URL fragment routing ---
// #https://example.com              → view archived page
// #a:https://example.com:token      → admin view after creation

// Normalize URL: re-add https:// if stripped, canonicalize via URL constructor.
// Returns null for anything that is not plain http(s).
function normalizeUrl(raw) {
  const withProto = (raw.startsWith('http://') || raw.startsWith('https://')) ? raw : 'https://' + raw;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href; // canonical form: trailing slash, lowercase host
  } catch { return null; }
}

function parseFragment() {
  const raw = location.hash.slice(1);
  if (!raw) return { mode: 'home' };

  // Admin mode: #a:domain.com/path:deleteToken
  if (raw.startsWith('a:')) {
    const rest = raw.slice(2);
    const lastColon = rest.lastIndexOf(':');
    if (lastColon > 0) {
      const url = normalizeUrl(rest.slice(0, lastColon));
      const deleteToken = rest.slice(lastColon + 1);
      if (url) return { mode: 'admin', url, deleteToken };
    }
    return { mode: 'home' };
  }

  // View mode: #domain.com/path (no protocol prefix)
  const url = normalizeUrl(raw);
  return url ? { mode: 'view', url } : { mode: 'home' };
}

const route = parseFragment();

// --- Shared helpers ---

function status(msg, isError) {
  const el = $('#status');
  if (el) { el.textContent = msg; el.className = isError ? 'status error' : 'status'; }
}

function logEntry(msg) {
  const log = $('#log');
  if (!log) return;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const tsSpan = document.createElement('span');
  tsSpan.className = 'log-ts';
  tsSpan.textContent = ts;
  entry.append(tsSpan, msg); // msg lands as a text node, never parsed as HTML
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// --- Seed entry (in-memory only) ---
// The seed is never written to storage; it lives only in the resolved promise
// value and is passed straight into WASM, then dropped.
function promptSeed(message) {
  return new Promise((resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:9999;padding:1rem';
    const box = document.createElement('div');
    box.style.cssText = 'background:#12121a;border:1px solid #1e1e2e;padding:1.25rem;max-width:440px;width:100%;font-family:monospace;color:#c4945a';
    const label = document.createElement('div');
    label.textContent = message || 'Enter your seed';
    label.style.cssText = 'font-size:.72rem;line-height:1.5;margin-bottom:.75rem;color:#8a6a3e';
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.style.cssText = 'width:100%;background:#0a0a0f;border:1px solid #1e1e2e;color:#c4945a;padding:.5rem;font:inherit;font-size:.8rem;outline:none;margin-bottom:.75rem';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:.5rem;justify-content:flex-end';
    const cancel = document.createElement('button');
    cancel.textContent = 'cancel';
    const ok = document.createElement('button');
    ok.textContent = 'unlock';
    for (const b of [cancel, ok]) b.style.cssText = 'background:none;border:1px solid #1e1e2e;color:#c4945a;padding:.3rem .8rem;font:inherit;font-size:.7rem;cursor:pointer';
    function done(val) { overlay.remove(); if (val == null) reject(new Error('cancelled')); else resolve(val); }
    ok.addEventListener('click', () => done(input.value));
    cancel.addEventListener('click', () => done(null));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') done(input.value);
      else if (e.key === 'Escape') done(null);
    });
    row.append(cancel, ok);
    box.append(label, input, row);
    overlay.append(box);
    document.body.append(overlay);
    input.focus();
  });
}

// Return the archive public key, deriving it from the seed on first use.
// Only the public key is cached; the seed is not retained.
async function ensurePublicKey() {
  const cached = getCachedPublicKey();
  if (cached) return cached;
  const seed = await promptSeed('First archive on this device: enter your seed. It derives your public key (cached locally) and is then discarded. The seed itself is never stored.');
  status('deriving public key...');
  return setupFromSeed(seed);
}

// ============================================================
// HOME MODE -- URL input: archive new or view existing
// ============================================================

if (route.mode === 'home') {
  const urlInput = $('#url-input');
  const captureBtn = $('#capture-btn');

  captureBtn.addEventListener('click', async () => {
    const input = urlInput.value.trim();
    if (!input) return status('enter a URL', true);
    const url = normalizeUrl(input);
    if (!url) return status('invalid URL (http/https only)', true);

    const displayUrl = url.replace(/^https?:\/\//, '');

    // Check if archive already exists
    status('checking for existing archive...');
    logEntry(`checking ${displayUrl}`);
    try {
      const check = await checkArchive(url);
      if (check.exists) {
        logEntry(`archive found: "${check.title}" -- opening`);
        window.open(`${location.origin}/#${displayUrl}`, '_blank');
        status('archive exists, opened in new tab');
        return;
      }
    } catch { /* not found, continue */ }

    // Resolve the public key up front (may prompt for the seed once).
    let publicKey;
    try { publicKey = await ensurePublicKey(); }
    catch { return status('cancelled', true); }

    logEntry('no existing archive, capturing');
    const adminTab = window.open('about:blank', '_blank');
    captureBtn.disabled = true;
    status('capturing...');

    try {
      // Step 1: Fetch HTML + worker-side resource discovery (seed list)
      logEntry(`fetching ${url}`);
      const captured = await captureUrl(url);
      const seedUrls = [
        ...(captured.resources?.css || []),
        ...(captured.resources?.images || []),
        ...(captured.resources?.fonts || []),
      ];
      logEntry(`got HTML: ${fmtSize(captured.html.length)} | ${seedUrls.length} seed resources`);

      // Step 2: Sanitize, discover + fetch all resources, inline everything
      logEntry('assembling (discovering + fetching resources)...');
      const assembled = await assembleArchive(captured.html, captured.baseUrl, seedUrls, fetchResources, logEntry);
      logEntry(`assembled: ${fmtSize(assembled.length)}`);

      // Step 3: brotli compress -> PGP encrypt (to your public key)
      logEntry('compressing + encrypting...');
      const blob = await createArchive(assembled, publicKey);
      logEntry(`encrypted: ${fmtSize(blob.length)}`);

      // Step 4: Store ciphertext in R2 (no key leaves the device)
      logEntry('storing...');
      const title = captured.title || url;
      const result = await store(blob, { title, url, size: assembled.length });
      logEntry(`stored: ${result.id}`);

      // Step 5: Open admin tab
      const adminUrl = `${location.origin}/#a:${displayUrl}:${result.deleteToken}`;
      if (adminTab) adminTab.location.href = adminUrl;
      else location.href = adminUrl;

      status('archived, opened in new tab');
      urlInput.value = '';
    } catch (e) {
      status(e.message, true);
      logEntry(`error: ${e.message}`);
      if (adminTab) adminTab.close();
    } finally {
      captureBtn.disabled = false;
    }
  });
}

// ============================================================
// VIEW / ADMIN -- load ciphertext, decrypt on-device with the seed
// ============================================================

async function displayArchive({ iframeSel, titleSel, urlSel, dateSel, onLoaded }) {
  status('loading archive...');
  let data;
  try { data = await loadArchive(route.url); }
  catch (e) { return status(e.message, true); }

  if (data.meta) {
    if (data.meta.title && titleSel) $(titleSel).textContent = data.meta.title;
    if (data.meta.url && urlSel) $(urlSel).textContent = data.meta.url;
    if (data.meta.capturedAt && dateSel) $(dateSel).textContent = fmtDate(data.meta.capturedAt);
  }

  let seed;
  try { seed = await promptSeed('Enter your seed to decrypt this archive. It regenerates your private key on this device; a wrong seed simply fails.'); }
  catch { return status('locked', true); }

  status('decrypting...');
  try {
    const html = await readArchive(data.blob, seed);
    $(iframeSel).srcdoc = prepareForDisplay(html);
    if (onLoaded) onLoaded();
    status('');
  } catch (e) {
    status('decryption failed (wrong seed?)', true);
  }
}

if (route.mode === 'view') {
  $('#home-section').classList.add('hidden');
  $('#view-section').classList.remove('hidden');
  displayArchive({
    iframeSel: '#view-iframe',
    titleSel: '#view-title',
    urlSel: '#view-url',
    dateSel: '#view-date',
  });
}

if (route.mode === 'admin') {
  $('#home-section').classList.add('hidden');
  $('#admin-section').classList.remove('hidden');

  const adminShareLink = $('#admin-share-link');
  const adminCopyLink = $('#admin-copy-link');
  const adminDeleteBtn = $('#admin-delete');
  const adminContent = $('#admin-content');

  const displayUrl = route.url.replace(/^https?:\/\//, '');
  adminShareLink.value = `${location.origin}/#${displayUrl}`;

  displayArchive({
    iframeSel: '#admin-iframe',
    titleSel: '#admin-title',
    urlSel: '#admin-url',
    dateSel: '#admin-date',
    onLoaded: () => adminContent.classList.remove('hidden'),
  });

  adminCopyLink.addEventListener('click', () => {
    navigator.clipboard.writeText(adminShareLink.value);
    adminCopyLink.textContent = 'copied';
    setTimeout(() => adminCopyLink.textContent = 'copy', 1500);
  });

  let deleted = false;
  adminDeleteBtn.addEventListener('click', async () => {
    adminDeleteBtn.disabled = true;
    status('deleting...');
    try {
      await remove(route.url, route.deleteToken);
      deleted = true;
      status('archive deleted');
      adminContent.classList.add('hidden');
      adminShareLink.value = '';
      adminDeleteBtn.classList.add('hidden');
    } catch (e) {
      status(e.message, true);
      adminDeleteBtn.disabled = false;
    }
  });

  window.addEventListener('pagehide', () => {
    if (deleted) return;
    const body = JSON.stringify({ token: route.deleteToken });
    navigator.sendBeacon(`${WORKER_URL}/revoke?url=${encodeURIComponent(route.url)}`, new Blob([body], { type: 'application/json' }));
  });
}
