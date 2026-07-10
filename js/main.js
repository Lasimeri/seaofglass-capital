import { captureUrl, fetchResources, store, checkArchive, requestSession, loadArchive, remove, WORKER_URL } from './storage.js?v=3';
import { assembleArchive } from './capture.js?v=2';
import { createArchive, readArchive, unwrapSessionKey } from './pipeline.js?v=3';
import { prepareForDisplay } from './sanitize.js?v=1';

const $ = s => document.querySelector(s);

// --- URL fragment routing ---
// Plain text URLs in fragment (not encoded) for readability
// #https://example.com              → view archived page (via session)
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
  // Delete token is a UUID (8-4-4-4-12 hex), use lastIndexOf to split
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

    // Display URL = strip https:// for cleanliness
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

    logEntry('no existing archive, capturing');

    // Open admin tab synchronously (before await)
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

      // Step 3: Compress + encrypt
      logEntry('compressing + encrypting...');
      const { blob, key } = await createArchive(assembled);
      logEntry(`encrypted: ${fmtSize(blob.length)}`);

      // Step 4: Store in R2
      logEntry('storing...');
      const title = captured.title || url;
      const result = await store(blob, { title, url, size: assembled.length, key });
      logEntry(`stored: ${result.id}`);

      // Step 5: Open admin tab (display URL without https://)
      const adminUrl = `${location.origin}/#a:${displayUrl}:${result.deleteToken}`;
      if (adminTab) {
        adminTab.location.href = adminUrl;
      } else {
        location.href = adminUrl;
      }

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
// VIEW MODE -- session-based access (no key in URL)
// ============================================================

if (route.mode === 'view') {
  const homeSection = $('#home-section');
  const viewSection = $('#view-section');
  homeSection.classList.add('hidden');
  viewSection.classList.remove('hidden');

  const viewTitle = $('#view-title');
  const viewUrl = $('#view-url');
  const viewDate = $('#view-date');
  const viewIframe = $('#view-iframe');

  status('requesting session...');

  // Use session endpoint: worker wraps the key, client unwraps with session secret
  requestSession(route.url).then(async data => {
    if (data.meta) {
      if (data.meta.title) viewTitle.textContent = data.meta.title;
      if (data.meta.url) viewUrl.textContent = data.meta.url;
      if (data.meta.capturedAt) viewDate.textContent = fmtDate(data.meta.capturedAt);
    }

    status('unwrapping key...');
    // Unwrap the real encryption key using the session secret
    const realKey = await unwrapSessionKey(
      data.session.wrappedKey,
      data.session.secret,
      data.session.id,
    );

    status('decrypting...');
    const html = await readArchive(data.blob, realKey);
    viewIframe.srcdoc = prepareForDisplay(html);
    status('');
  }).catch(e => status(e.message, true));
}

// ============================================================
// ADMIN MODE -- direct access (has key from creation)
// ============================================================

if (route.mode === 'admin') {
  const homeSection = $('#home-section');
  const adminSection = $('#admin-section');
  homeSection.classList.add('hidden');
  adminSection.classList.remove('hidden');

  const adminTitle = $('#admin-title');
  const adminUrl = $('#admin-url');
  const adminDate = $('#admin-date');
  const adminIframe = $('#admin-iframe');
  const adminShareLink = $('#admin-share-link');
  const adminCopyLink = $('#admin-copy-link');
  const adminDeleteBtn = $('#admin-delete');
  const adminContent = $('#admin-content');

  status('loading archive...');

  // Share link = display URL (no https://)
  const displayUrl = route.url.replace(/^https?:\/\//, '');
  adminShareLink.value = `${location.origin}/#${displayUrl}`;

  // Admin uses direct load (key comes from R2 metadata)
  loadArchive(route.url).then(async data => {
    if (data.meta) {
      if (data.meta.title) adminTitle.textContent = data.meta.title;
      if (data.meta.url) adminUrl.textContent = data.meta.url;
      if (data.meta.capturedAt) adminDate.textContent = fmtDate(data.meta.capturedAt);
    }

    status('decrypting...');
    const html = await readArchive(data.blob, data.meta.key);
    adminIframe.srcdoc = prepareForDisplay(html);
    adminContent.classList.remove('hidden');
    status('');
  }).catch(e => status(e.message, true));

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

  function revokeToken() {
    if (deleted) return;
    const body = JSON.stringify({ token: route.deleteToken });
    navigator.sendBeacon(`${WORKER_URL}/revoke?url=${encodeURIComponent(route.url)}`, new Blob([body], { type: 'application/json' }));
  }
  window.addEventListener('pagehide', revokeToken);
}
