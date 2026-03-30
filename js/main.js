import { captureUrl, fetchResources, store, loadArchive, remove, WORKER_URL } from './storage.js?v=1';
import { assembleArchive } from './capture.js?v=1';
import { createArchive, readArchive } from './pipeline.js?v=1';

const $ = s => document.querySelector(s);

// --- URL fragment routing ---
// #https://example.com         → view archived page
// #a:https://example.com:token → admin view after creation

function parseFragment() {
  const hash = location.hash.slice(1);
  if (!hash) return { mode: 'home' };

  // Admin mode: #a:url:deleteToken
  if (hash.startsWith('a:')) {
    const rest = hash.slice(2);
    const lastColon = rest.lastIndexOf(':');
    if (lastColon > 0) {
      const url = rest.slice(0, lastColon);
      const deleteToken = rest.slice(lastColon + 1);
      return { mode: 'admin', url: decodeURIComponent(url), deleteToken };
    }
  }

  // View mode: #url
  return { mode: 'view', url: decodeURIComponent(hash) };
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
  entry.textContent = `[${ts}] ${msg}`;
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
// HOME MODE — URL input, archive or view
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

    // First check if archive already exists
    status('checking for existing archive...');
    try {
      const existing = await loadArchive(url);
      if (existing && existing.blob) {
        // Archive exists — navigate to it
        location.hash = '#' + encodeURIComponent(url);
        location.reload();
        return;
      }
    } catch {
      // Not found — proceed to capture
    }

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
          if (result.failed?.length) {
            logEntry(`${result.failed.length} resources failed`);
          }
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

      // Step 5: Store in R2 (key goes in metadata — all archives are public)
      logEntry('storing...');
      const title = captured.title || url;
      const result = await store(blob, {
        title,
        url,
        size: assembled.length,
        key,
      });
      logEntry(`stored: ${result.id}`);

      // Step 6: Open admin tab
      const adminUrl = `${location.origin}/#a:${encodeURIComponent(url)}:${result.deleteToken}`;
      if (adminTab) {
        adminTab.location.href = adminUrl;
      } else {
        location.href = adminUrl;
      }

      status('archived');
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
// VIEW MODE — display an archived page
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

  status('loading archive...');

  loadArchive(route.url).then(async data => {
    if (data.meta) {
      if (data.meta.title) viewTitle.textContent = data.meta.title;
      if (data.meta.url) viewUrl.textContent = data.meta.url;
      if (data.meta.capturedAt) viewDate.textContent = fmtDate(data.meta.capturedAt);
    }

    status('decrypting...');
    const html = await readArchive(data.blob, data.meta.key);
    viewIframe.srcdoc = html;
    status('');
  }).catch(e => status(e.message, true));
}

// ============================================================
// ADMIN MODE — after creation, shows archive + share link + delete
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

  // Share link = just the URL fragment (no key needed — key is in R2 metadata)
  const shareUrl = `${location.origin}/#${encodeURIComponent(route.url)}`;
  adminShareLink.value = shareUrl;

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

  // Copy link
  adminCopyLink.addEventListener('click', () => {
    navigator.clipboard.writeText(adminShareLink.value);
    adminCopyLink.textContent = 'copied';
    setTimeout(() => adminCopyLink.textContent = 'copy', 1500);
  });

  // Delete
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

  // Revoke delete token on tab close
  function revokeToken() {
    if (deleted) return;
    const body = JSON.stringify({ token: route.deleteToken });
    navigator.sendBeacon(`${WORKER_URL}/revoke?url=${encodeURIComponent(route.url)}`, new Blob([body], { type: 'application/json' }));
  }
  window.addEventListener('pagehide', revokeToken);
}
