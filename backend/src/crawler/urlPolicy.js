/**
 * URL rules for the crawler: how URLs are normalized, what "the same website"
 * means, and which links are not worth fetching. Pure functions, no I/O.
 *
 * To widen the scope later (subdomains, a path prefix, robots.txt) change
 * createScope / isInScope here; the crawler itself does not need to know.
 */

// Files that are clearly not HTML pages. Skipping them by extension saves a
// request; anything that slips through is still skipped by content type.
const SKIPPED_EXTENSIONS = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tif', 'tiff', 'avif',
  // documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'csv',
  // archives and binaries
  'zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'bz2', 'exe', 'msi', 'dmg', 'apk', 'bin', 'iso',
  // media
  'mp3', 'mp4', 'm4a', 'm4v', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm', 'ogg', 'wav',
  // assets and feeds
  'css', 'js', 'mjs', 'map', 'json', 'xml', 'rss', 'atom',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
]);

/**
 * Resolves `href` against `base` and returns a canonical absolute URL string,
 * or null when the result is not an http(s) URL (mailto:, tel:, javascript:,
 * data:, malformed...). Fragments and credentials are dropped; the URL API
 * already lowercases the host and removes default ports.
 */
export function normalizeUrl(href, base) {
  let url;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.href;
}

/**
 * The website a crawl is confined to, derived from the start URL.
 * Rule: same host, where "www.example.com" and "example.com" count as the
 * same site because most sites redirect between the two. With
 * `includeSubdomains`, "shop.example.com" and "en.example.com" belong too.
 */
export function createScope(startUrl, { includeSubdomains = false } = {}) {
  const url = new URL(startUrl);
  return { host: stripWww(url.hostname), includeSubdomains };
}

export function isInScope(urlString, scope) {
  const host = stripWww(new URL(urlString).hostname);
  if (host === scope.host) return true;
  return scope.includeSubdomains && host.endsWith(`.${scope.host}`);
}

/** Cheap pre-fetch filter: false when the path ends in an extension that is clearly not a page. */
export function looksLikePage(urlString) {
  const { pathname } = new URL(urlString);
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = lastSegment.lastIndexOf('.');
  if (dot === -1) return true;
  return !SKIPPED_EXTENSIONS.has(lastSegment.slice(dot + 1).toLowerCase());
}

/** Everything the crawler checks before putting a normalized URL in its queue. */
export function isCrawlable(urlString, scope) {
  return isInScope(urlString, scope) && looksLikePage(urlString);
}

function stripWww(hostname) {
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}
