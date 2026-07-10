// Shared DOM sanitization for archived pages.
// Runs at capture time (before storing) and again at render time (before
// srcdoc), so archives stored by older versions get the same protections
// when displayed.

// CSP injected into every displayed archive: no network, no scripts,
// data:-inlined assets and inline styles only. Combined with the parent
// page CSP (inherited by srcdoc) and the empty iframe sandbox, all three
// layers must fail before archived content can execute or phone home.
const ARCHIVE_CSP = [
  "default-src 'none'",
  "img-src data:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "media-src data:",
].join('; ');

const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'data'];
const DANGEROUS_URL = /^\s*(javascript:|vbscript:|data:text\/html)/i;

// Remove active content from a parsed document, in place.
export function sanitizeDoc(doc) {
  doc.querySelectorAll('script, object, embed, applet, frame, frameset, template, portal')
    .forEach(el => el.remove());

  // Nested browsing contexts load arbitrary remote content; replace with a
  // visible placeholder so the layout does not silently lose a region
  doc.querySelectorAll('iframe').forEach(el => {
    const ph = doc.createElement('div');
    ph.setAttribute('style', 'border:1px dashed #888;padding:8px;font:12px monospace;color:#888;overflow:hidden');
    ph.textContent = `[embedded frame removed: ${el.getAttribute('src') || 'inline'}]`;
    el.replaceWith(ph);
  });

  // Event handlers and script-scheme URLs: match by prefix on every
  // attribute, not a fixed handler list (SVG/pointer/animation handlers
  // number in the hundreds)
  doc.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if (URL_ATTRS.includes(name) && DANGEROUS_URL.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  });

  // Meta directives that redirect the viewer or alter the policy context
  doc.querySelectorAll('meta[http-equiv]').forEach(m => {
    const v = (m.getAttribute('http-equiv') || '').trim().toLowerCase();
    if (['refresh', 'content-security-policy', 'content-type', 'set-cookie'].includes(v)) m.remove();
  });

  // Neutralize forms but keep their children: many pages wrap their entire
  // layout in a form, removing the element would drop visible content
  doc.querySelectorAll('form').forEach(f => {
    f.removeAttribute('action');
    f.removeAttribute('method');
    f.removeAttribute('target');
  });
  doc.querySelectorAll('input, button, select, textarea').forEach(el => {
    el.setAttribute('disabled', '');
    el.removeAttribute('name');
    el.removeAttribute('formaction');
  });

  // Resource hints trigger network fetches at render
  doc.querySelectorAll(
    'link[rel="preload"], link[rel="prefetch"], link[rel="modulepreload"], ' +
    'link[rel="dns-prefetch"], link[rel="preconnect"], link[rel="manifest"], link[rel="import"]'
  ).forEach(el => el.remove());
}

// Render-time hardening: re-sanitize the decrypted document and inject the
// archive CSP + no-referrer policy as the first children of <head>, then
// serialize for iframe srcdoc.
export function prepareForDisplay(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  sanitizeDoc(doc);

  const referrer = doc.createElement('meta');
  referrer.setAttribute('name', 'referrer');
  referrer.setAttribute('content', 'no-referrer');
  doc.head.insertBefore(referrer, doc.head.firstChild);

  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', ARCHIVE_CSP);
  doc.head.insertBefore(csp, doc.head.firstChild);

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}
