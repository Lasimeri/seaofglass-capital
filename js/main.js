import { captureUrl, fetchResources, store, checkArchive, loadArchive, remove, WORKER_URL } from './storage.js?v=4';
import { assembleArchive } from './capture.js?v=2';
import { createArchive, readArchive } from './pipeline.js?v=6';
import { prepareForDisplay } from './sanitize.js?v=1';
import { generateKey, pubkeyFromSeed } from './wasm.js?v=3';
import { downloadPDF } from './pdf.js?v=1';

const $ = s => document.querySelector(s);

// --- URL fragment routing ---
// Each archive has its OWN key, carried in the #fragment (never sent to the
// server, so the host cannot decrypt). The link IS the decryption capability.
//   #k:<seed>:<displayUrl>              → view/share (key in link)
//   #a:<seed>:<token>:<displayUrl>      → admin (key + delete token, creator)
// seed and token are colon-free (base64url / UUID), so index splitting is exact.

function normalizeUrl(raw) {
  const withProto = (raw.startsWith('http://') || raw.startsWith('https://')) ? raw : 'https://' + raw;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch { return null; }
}

function parseFragment() {
  const raw = location.hash.slice(1);
  if (!raw) return { mode: 'home' };

  if (raw.startsWith('a:')) {
    const rest = raw.slice(2);
    const i1 = rest.indexOf(':');
    const i2 = rest.indexOf(':', i1 + 1);
    if (i1 > 0 && i2 > i1) {
      const seed = rest.slice(0, i1);
      const deleteToken = rest.slice(i1 + 1, i2);
      const url = normalizeUrl(rest.slice(i2 + 1));
      if (url) return { mode: 'admin', url, seed, deleteToken };
    }
    return { mode: 'home' };
  }

  if (raw.startsWith('k:')) {
    const rest = raw.slice(2);
    const i1 = rest.indexOf(':');
    if (i1 > 0) {
      const seed = rest.slice(0, i1);
      const url = normalizeUrl(rest.slice(i1 + 1));
      if (url) return { mode: 'view', url, seed };
    }
    return { mode: 'home' };
  }

  return { mode: 'home' };
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
  entry.append(tsSpan, msg);
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

// --- PDF export ---

function openAndPrint(preparedHtml) {
  const w = window.open('', '_blank');
  if (!w) { status('popup blocked; allow popups to print', true); return; }
  w.document.open();
  w.document.write(preparedHtml);
  w.document.close();
  const go = () => { try { w.focus(); w.print(); } catch { /* user can print manually */ } };
  w.onload = go;
  setTimeout(go, 800);
}

function extractText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript').forEach(e => e.remove());
  doc.querySelectorAll('p, div, br, li, tr, h1, h2, h3, h4, h5, h6, section, article, header, footer, blockquote')
    .forEach(el => el.append('\n'));
  const title = doc.querySelector('title')?.textContent?.trim() || '';
  const body = (doc.body?.textContent || '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return (title ? title + '\n\n' : '') + body;
}

function addPdfToolbar(iframeSel, rawHtml, preparedHtml) {
  const iframe = $(iframeSel);
  if (!iframe) return;
  const frame = iframe.closest('.archive-frame') || iframe.parentElement;
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:.5rem;margin-bottom:.5rem;flex-wrap:wrap';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'background:none;border:1px solid #1e1e2e;color:#c4945a;padding:.3rem .8rem;font-family:monospace;font-size:.7rem;cursor:pointer';
    b.addEventListener('click', fn);
    return b;
  };
  bar.append(
    mk('save PDF (page)', () => openAndPrint(preparedHtml)),
    mk('save PDF (text)', () => {
      const t = extractText(rawHtml);
      const title = (t.split('\n')[0] || 'archive').slice(0, 60);
      downloadPDF(t, 'archive.pdf', { title });
    }),
  );
  frame.parentElement.insertBefore(bar, frame);
}

// ============================================================
// HOME MODE -- archive a URL (mints a unique per-page key)
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

    // This page's unique key + its public key.
    let seed, publicKey;
    status('generating key...');
    try {
      seed = await generateKey();
      publicKey = await pubkeyFromSeed(seed);
    } catch (e) { return status('key generation failed: ' + e.message, true); }

    logEntry('capturing');
    const adminTab = window.open('about:blank', '_blank');
    captureBtn.disabled = true;
    status('capturing...');

    try {
      logEntry(`fetching ${url}`);
      const captured = await captureUrl(url);
      const seedUrls = [
        ...(captured.resources?.css || []),
        ...(captured.resources?.images || []),
        ...(captured.resources?.fonts || []),
      ];
      logEntry(`got HTML: ${fmtSize(captured.html.length)} | ${seedUrls.length} seed resources`);

      logEntry('assembling (discovering + fetching resources)...');
      const assembled = await assembleArchive(captured.html, captured.baseUrl, seedUrls, fetchResources, logEntry);
      logEntry(`assembled: ${fmtSize(assembled.length)}`);

      logEntry('compressing + encrypting...');
      const blob = await createArchive(assembled, publicKey);
      logEntry(`encrypted: ${fmtSize(blob.length)}`);

      logEntry('storing...');
      const title = captured.title || url;
      const result = await store(blob, { title, url, size: assembled.length });
      logEntry(`stored: ${result.id}`);

      // Admin link carries the key + delete token; view/share link carries the key.
      const adminUrl = `${location.origin}/#a:${seed}:${result.deleteToken}:${displayUrl}`;
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
// VIEW / ADMIN -- key comes from the link fragment
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

  status('decrypting...');
  try {
    const html = await readArchive(data.blob, route.seed);
    const prepared = prepareForDisplay(html);
    $(iframeSel).srcdoc = prepared;
    addPdfToolbar(iframeSel, html, prepared);
    if (onLoaded) onLoaded();
    status('');
  } catch (e) {
    status('could not decrypt — this link may be from an older version; re-archive the page', true);
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
  // Share link carries the key (no delete token).
  adminShareLink.value = `${location.origin}/#k:${route.seed}:${displayUrl}`;

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
