import { captureUrl, fetchResources, store, checkArchive, requestSession, loadArchive, remove, WORKER_URL } from './storage.js?v=3';
import { assembleArchive } from './capture.js?v=1';
import { createArchive, readArchive, unwrapSessionKey } from './pipeline.js?v=3';

const $ = s => document.querySelector(s);

// --- URL fragment routing ---
// Plain text URLs in fragment (not encoded) for readability
// #https://example.com              → view archived page (via session)
// #a:https://example.com:token      → admin view after creation

// Normalize URL: re-add https:// if stripped, canonicalize via URL constructor
function normalizeUrl(raw) {
  const withProto = (raw.startsWith('http://') || raw.startsWith('https://')) ? raw : 'https://' + raw;
  try { return new URL(withProto).href; } // canonical form: trailing slash, lowercase host
  catch { return withProto; }
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
      const displayUrl = rest.slice(0, lastColon);
      const deleteToken = rest.slice(lastColon + 1);
      return { mode: 'admin', url: normalizeUrl(displayUrl), deleteToken };
    }
  }

  // View mode: #domain.com/path (no protocol prefix)
  return { mode: 'view', url: normalizeUrl(raw) };
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
  entry.innerHTML = `<span class="log-ts">${ts}</span>${msg.replace(/&/g,'&amp;').replace(/</g,'&lt;')}`;
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
// HOME MODE — URL input: archive new or view existing
// ============================================================

if (route.mode === 'home') {
  const urlInput = $('#url-input');
  const captureBtn = $('#capture-btn');

  captureBtn.addEventListener('click', async () => {
    let url = urlInput.value.trim();
    if (!url) return status('enter a URL', true);
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    // Display URL = strip https:// for cleanliness
    const displayUrl = url.replace(/^https?:\/\//, '');

    // Check if archive already exists
    status('checking for existing archive...');
    logEntry(`checking ${displayUrl}`);
    try {
      const check = await checkArchive(url);
      if (check.exists) {
        logEntry(`archive found: "${check.title}" — opening`);
        window.open(`${location.origin}/#${displayUrl}`, '_blank');
        status('archive exists — opened in new tab');
        return;
      }
    } catch { /* not found, continue */ }

    logEntry('no existing archive — capturing');

    // Open admin tab synchronously (before await)
    const adminTab = window.open('about:blank', '_blank');

    captureBtn.disabled = true;
    status('capturing...');

    try {
      // Step 1: Fetch HTML + discover resources
      logEntry(`fetching ${url}`);
      const captured = await captureUrl(url);
      const resourceCount = captured.resources.css.length + captured.resources.images.length + captured.resources.fonts.length;
      logEntry(`got HTML: ${fmtSize(captured.html.length)} | ${resourceCount} resources`);

      // Step 2: Batch-fetch resources
      const allUrls = [
        ...captured.resources.css,
        ...captured.resources.images,
        ...captured.resources.fonts,
      ];
      let allResources = {};

      if (allUrls.length > 0) {
        logEntry(`fetching ${allUrls.length} resources...`);
        for (let i = 0; i < allUrls.length; i += 40) {
          const batch = allUrls.slice(i, i + 40);
          const result = await fetchResources(batch);
          Object.assign(allResources, result.resources || {});
          if (result.failed?.length) logEntry(`${result.failed.length} resources failed`);
        }
        logEntry(`fetched ${Object.keys(allResources).length} resources`);
      }

      // Step 3: Assemble self-contained HTML
      logEntry('assembling...');
      const assembled = assembleArchive(captured.html, allResources, captured.baseUrl);
      logEntry(`assembled: ${fmtSize(assembled.length)}`);

      // Step 4: Compress + encrypt
      logEntry('compressing + encrypting...');
      const { blob, key } = await createArchive(assembled);
      logEntry(`encrypted: ${fmtSize(blob.length)}`);

      // Step 5: Store in R2
      logEntry('storing...');
      const title = captured.title || url;
      const result = await store(blob, { title, url, size: assembled.length, key });
      logEntry(`stored: ${result.id}`);

      // Step 6: Open admin tab (display URL without https://)
      const adminUrl = `${location.origin}/#a:${displayUrl}:${result.deleteToken}`;
      if (adminTab) {
        adminTab.location.href = adminUrl;
      } else {
        location.href = adminUrl;
      }

      status('archived — opened in new tab');
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
// VIEW MODE — session-based access (no key in URL)
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
    viewIframe.srcdoc = html;
    status('');
  }).catch(e => status(e.message, true));
}

// ============================================================
// ADMIN MODE — direct access (has key from creation)
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
    adminIframe.srcdoc = html;
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
