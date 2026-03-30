// Client-side HTML assembly after worker fetches resources
// Assembles a self-contained HTML document from raw HTML + fetched resources

export function assembleArchive(html, resources, baseUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Add base tag for unresolved URLs
  const base = doc.createElement('base');
  base.href = baseUrl;
  doc.head.prepend(base);

  // Strip scripts
  doc.querySelectorAll('script, noscript').forEach(el => el.remove());

  // Strip event handlers
  const events = [
    'onclick', 'onload', 'onerror', 'onmouseover', 'onmouseout',
    'onsubmit', 'onchange', 'onfocus', 'onblur', 'onkeydown', 'onkeyup',
    'onkeypress', 'ondblclick', 'oncontextmenu', 'onscroll', 'onresize', 'oninput'
  ];
  doc.querySelectorAll('*').forEach(el => {
    events.forEach(attr => el.removeAttribute(attr));
  });

  // Strip forms, keep inputs visible but disabled
  doc.querySelectorAll('form').forEach(el => el.remove());
  doc.querySelectorAll('input, button, select, textarea').forEach(el => {
    el.setAttribute('disabled', '');
    el.removeAttribute('name');
    el.removeAttribute('action');
  });

  // Inline external stylesheets
  doc.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
    const href = resolveUrl(link.getAttribute('href'), baseUrl);
    const res = resources[href];
    if (res && res.type === 'text/css') {
      const style = doc.createElement('style');
      style.textContent = inlineCssUrls(res.data, href, resources);
      link.replaceWith(style);
    }
  });

  // Inline images
  doc.querySelectorAll('img[src]').forEach(img => {
    const src = resolveUrl(img.getAttribute('src'), baseUrl);
    const res = resources[src];
    if (res && res.data) img.setAttribute('src', res.data);
  });

  // Inline CSS background images and fonts in <style> tags
  doc.querySelectorAll('style').forEach(style => {
    style.textContent = inlineCssUrls(style.textContent, baseUrl, resources);
  });

  // Inline CSS background images in inline styles
  doc.querySelectorAll('[style]').forEach(el => {
    const s = el.getAttribute('style');
    el.setAttribute('style', inlineCssUrls(s, baseUrl, resources));
  });

  // Remove link preloads, prefetches, modulepreloads
  doc.querySelectorAll(
    'link[rel="preload"], link[rel="prefetch"], link[rel="modulepreload"], ' +
    'link[rel="dns-prefetch"], link[rel="preconnect"]'
  ).forEach(el => el.remove());

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

function resolveUrl(href, base) {
  if (!href) return '';
  try { return new URL(href, base).href; }
  catch { return href; }
}

function inlineCssUrls(css, baseUrl, resources) {
  return css.replace(/url\(["']?([^)"']+)["']?\)/g, (match, url) => {
    if (url.startsWith('data:')) return match;
    const resolved = resolveUrl(url, baseUrl);
    const res = resources[resolved];
    if (res && res.data) return `url(${res.data})`;
    return match;
  });
}
