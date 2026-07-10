// Client-side capture assembly.
// Takes raw HTML from the worker, sanitizes it, discovers every referenced
// resource in the DOM and in fetched CSS (recursively), fetches them through
// the worker, and inlines everything into one self-contained document.
// Worker-side discovery is treated as a seed list only; the client re-derives
// the full set so lazy-loaded images, srcset, @import chains, and fonts
// survive regardless of what the worker found.

import { sanitizeDoc } from './sanitize.js?v=1';

const MAX_RESOURCES = 400; // total fetched resources per archive
const MAX_CSS_DEPTH = 3;   // stylesheet -> @import -> assets
const BATCH = 40;

export async function assembleArchive(html, baseUrl, seedUrls, fetchResources, log) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Base tag so anything left unresolved at least resolves consistently
  const base = doc.createElement('base');
  base.href = baseUrl;
  doc.head.prepend(base);

  unwrapNoscript(doc);
  promoteLazyAttributes(doc);
  sanitizeDoc(doc);

  const resources = {};
  const attempted = new Set();
  let capped = false;

  const fetchAll = async urls => {
    const list = [];
    for (const u of urls) {
      const r = normalize(u, baseUrl);
      if (!r || attempted.has(r)) continue;
      if (attempted.size >= MAX_RESOURCES) { capped = true; break; }
      attempted.add(r);
      list.push(r);
    }
    for (let i = 0; i < list.length; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      try {
        const result = await fetchResources(batch);
        Object.assign(resources, result.resources || {});
        if (result.failed?.length) log?.(`${result.failed.length} resources failed`);
      } catch (e) {
        log?.(`resource batch failed: ${e.message}`);
      }
    }
    return list.length;
  };

  // Round 1: document-level resources (worker seed list + own DOM discovery)
  await fetchAll([...(seedUrls || []), ...discoverDocumentUrls(doc, baseUrl)]);

  // Rounds 2..n: assets referenced from fetched CSS (@import chains, fonts,
  // background images). Each round only fetches URLs not yet attempted.
  for (let depth = 0; depth < MAX_CSS_DEPTH; depth++) {
    const cssRefs = [];
    for (const [url, res] of Object.entries(resources)) {
      if (res.type === 'text/css') cssRefs.push(...extractCssUrls(res.data, url));
    }
    if (await fetchAll(cssRefs) === 0) break;
  }

  if (capped) log?.(`resource cap reached (${MAX_RESOURCES}), some assets skipped`);

  inlineAll(doc, resources, baseUrl);

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

// --- Pre-processing ---

// DOMParser parses with scripting disabled, so <noscript> children are real
// elements. Unwrap them: they usually hold the non-JS <img> fallbacks that
// lazy-loading pages provide, which is exactly what a scriptless archive needs.
function unwrapNoscript(doc) {
  doc.querySelectorAll('noscript').forEach(ns => {
    while (ns.firstChild) ns.parentNode.insertBefore(ns.firstChild, ns);
    ns.remove();
  });
}

// Lazy-loading pages keep the real URL in data-* attributes and rely on JS
// to promote it. The archive has no JS, so promote here.
const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original', 'data-lazyload'];
const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset'];

function promoteLazyAttributes(doc) {
  doc.querySelectorAll('img, source').forEach(el => {
    for (const a of LAZY_SRC) {
      const v = el.getAttribute(a);
      if (v && !v.startsWith('data:')) { el.setAttribute('src', v); break; }
    }
    for (const a of LAZY_SRCSET) {
      const v = el.getAttribute(a);
      if (v) { el.setAttribute('srcset', v); break; }
    }
  });
}

// --- Discovery ---

function discoverDocumentUrls(doc, baseUrl) {
  const urls = [];
  const push = v => { if (v) urls.push(v); };

  doc.querySelectorAll('link[rel="stylesheet"][href]').forEach(el => push(el.getAttribute('href')));
  doc.querySelectorAll('link[rel~="icon"][href]').forEach(el => push(el.getAttribute('href')));
  doc.querySelectorAll('img[src], input[type="image"][src]').forEach(el => push(el.getAttribute('src')));
  doc.querySelectorAll('video[poster]').forEach(el => push(el.getAttribute('poster')));
  doc.querySelectorAll('img[srcset], source[srcset]').forEach(el => push(bestSrcsetCandidate(el.getAttribute('srcset'))));
  doc.querySelectorAll('svg image').forEach(el => push(el.getAttribute('href') || el.getAttribute('xlink:href')));
  doc.querySelectorAll('style').forEach(el => urls.push(...extractCssUrls(el.textContent, baseUrl)));
  doc.querySelectorAll('[style]').forEach(el => urls.push(...extractCssUrls(el.getAttribute('style'), baseUrl)));

  return urls;
}

const CSS_URL_RE = /url\(\s*["']?([^)"']+)["']?\s*\)/g;
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*["']?([^)"']+)["']?\s*\)|["']([^"']+)["'])/g;

function extractCssUrls(css, base) {
  const out = [];
  for (const re of [CSS_URL_RE, CSS_IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(css || ''))) {
      const raw = m[1] || m[2];
      if (!raw || raw.startsWith('data:') || raw.startsWith('#')) continue;
      try { out.push(new URL(raw, base).href); } catch { /* unparseable, skip */ }
    }
  }
  return out;
}

// Highest-resolution srcset candidate: rank by w descriptor, then x density
function bestSrcsetCandidate(srcset) {
  let best = null, bestScore = -1;
  for (const part of (srcset || '').split(',')) {
    const bits = part.trim().split(/\s+/);
    const url = bits[0];
    if (!url) continue;
    const d = bits[1] || '';
    let score = 1;
    if (d.endsWith('w')) score = parseFloat(d) || 1;
    else if (d.endsWith('x')) score = (parseFloat(d) || 1) * 1000;
    if (score > bestScore) { bestScore = score; best = url; }
  }
  return best;
}

// Resolve against base, http(s) only, hash stripped (dedupes #iefix fonts)
function normalize(href, base) {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

// --- Inlining ---

function inlineAll(doc, resources, baseUrl) {
  const lookup = href => {
    const key = normalize(href, baseUrl);
    return key ? resources[key] : undefined;
  };

  // External stylesheets -> <style>, with @imports spliced in and asset
  // urls converted to data URIs. Unfetched stylesheets are removed so the
  // render never attempts a network fetch.
  doc.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
    const key = normalize(link.getAttribute('href'), baseUrl);
    const res = key && resources[key];
    if (res && res.type === 'text/css') {
      const style = doc.createElement('style');
      style.textContent = inlineCss(res.data, key, resources, new Set([key]));
      link.replaceWith(style);
    } else {
      link.remove();
    }
  });

  doc.querySelectorAll('link[rel~="icon"]').forEach(link => {
    const res = lookup(link.getAttribute('href'));
    if (res?.data?.startsWith('data:')) link.setAttribute('href', res.data);
    else link.remove();
  });

  doc.querySelectorAll('img[src], input[type="image"][src]').forEach(el => {
    const res = lookup(el.getAttribute('src'));
    if (res?.data) el.setAttribute('src', res.data);
  });

  // Collapse srcset to the best fetched candidate; the render environment
  // is a fixed iframe, responsive candidates only add dead URLs
  doc.querySelectorAll('img[srcset]').forEach(img => {
    const best = bestSrcsetCandidate(img.getAttribute('srcset'));
    const res = best && lookup(best);
    if (res?.data) img.setAttribute('src', res.data);
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
  });
  doc.querySelectorAll('picture source').forEach(el => el.remove());

  doc.querySelectorAll('video[poster]').forEach(el => {
    const res = lookup(el.getAttribute('poster'));
    if (res?.data) el.setAttribute('poster', res.data);
  });

  doc.querySelectorAll('svg image').forEach(el => {
    const res = lookup(el.getAttribute('href') || el.getAttribute('xlink:href'));
    if (res?.data) {
      el.setAttribute('href', res.data);
      el.removeAttribute('xlink:href');
    }
  });

  doc.querySelectorAll('style').forEach(style => {
    style.textContent = inlineCss(style.textContent, baseUrl, resources, new Set());
  });
  doc.querySelectorAll('[style]').forEach(el => {
    el.setAttribute('style', inlineCss(el.getAttribute('style'), baseUrl, resources, new Set()));
  });

  // integrity hashes no longer match inlined content; crossorigin is
  // meaningless on data: URIs and can block loads
  doc.querySelectorAll('[integrity], [crossorigin]').forEach(el => {
    el.removeAttribute('integrity');
    el.removeAttribute('crossorigin');
  });
}

// Inline a CSS string: splice @imported stylesheets in (recursively, cycle
// guarded via `seen`, media conditions preserved), then convert url() refs
// to data URIs. Unfetched @imports are dropped so nothing fetches at render.
function inlineCss(css, cssBase, resources, seen) {
  if (!css) return css;

  css = css.replace(
    /@import\s+(?:url\(\s*["']?([^)"']+)["']?\s*\)|["']([^"']+)["'])\s*([^;]*);?/g,
    (match, u1, u2, media) => {
      const target = normalize(u1 || u2, cssBase);
      const res = target && resources[target];
      if (!res || res.type !== 'text/css' || seen.has(target)) return '';
      seen.add(target);
      const inner = inlineCss(res.data, target, resources, seen);
      return media && media.trim() ? `@media ${media.trim()} { ${inner} }` : inner;
    },
  );

  return css.replace(CSS_URL_RE, (match, url) => {
    if (url.startsWith('data:') || url.startsWith('#')) return match;
    const target = normalize(url, cssBase);
    const res = target && resources[target];
    if (res?.data?.startsWith('data:')) return `url(${res.data})`;
    return match;
  });
}
