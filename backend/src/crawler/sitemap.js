import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';

/**
 * Finds the pages a site lists in its sitemaps, so coverage does not depend
 * on the site's menus: robots.txt may name sitemaps, otherwise /sitemap.xml
 * and /sitemap_index.xml are tried. Sitemap indexes are followed and .gz
 * sitemaps are unpacked. Everything is best effort: a missing or broken
 * sitemap simply yields no URLs.
 *
 * Only `fetchResource` from HttpFetcher is needed; sitemaps are static
 * files, so a browser is never involved.
 */
const DEFAULT_LIMITS = { maxSitemaps: 20, maxUrls: 50_000 };

export async function discoverSitemapUrls({ startUrl, fetchResource, signal, maxSitemaps = DEFAULT_LIMITS.maxSitemaps, maxUrls = DEFAULT_LIMITS.maxUrls }) {
  const origin = new URL(startUrl).origin;
  const fetchText = async (url) => {
    try {
      const resource = await fetchResource(url, { signal });
      if (resource.reason || !resource.body) return null;
      return { url: resource.url, contentType: resource.contentType, bytes: resource.body };
    } catch {
      return null; // unreachable or refused: treat as "no sitemap"
    }
  };

  const seen = new Set();
  const urls = new Set();
  const queue = [];
  let sitemapsRead = 0;

  // Reads one sitemap file; child sitemaps go to the queue, page URLs to the result.
  const readSitemap = async (sitemapUrl) => {
    if (seen.has(sitemapUrl)) return false;
    seen.add(sitemapUrl);
    const file = await fetchText(sitemapUrl);
    sitemapsRead += 1;
    const xml = file && toXml(file);
    if (!xml) return false;

    const parsed = parseSitemap(xml);
    queue.push(...parsed.sitemaps);
    for (const url of parsed.urls) {
      if (urls.size >= maxUrls) break;
      urls.add(url);
    }
    return true;
  };
  const budgetLeft = () => !signal?.aborted && sitemapsRead < maxSitemaps && urls.size < maxUrls;

  const named = await sitemapsNamedInRobots(origin, fetchText);
  if (named.length > 0) {
    queue.push(...named);
  } else {
    // Conventional locations, tried in turn until one is a real sitemap.
    for (const fallback of [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]) {
      if (!budgetLeft() || (await readSitemap(fallback))) break;
    }
  }

  while (queue.length > 0 && budgetLeft()) {
    await readSitemap(queue.shift());
  }

  return { urls: [...urls], sitemapsRead };
}

/** The "Sitemap:" lines of robots.txt, if the site has one. */
async function sitemapsNamedInRobots(origin, fetchText) {
  const robots = await fetchText(`${origin}/robots.txt`);
  if (!robots || looksLikeHtml(robots.bytes)) return [];
  const named = [];
  for (const line of robots.bytes.toString('utf-8').split(/\r?\n/)) {
    const match = /^\s*sitemap:\s*(\S+)/i.exec(line);
    if (match) named.push(match[1]);
  }
  return named;
}

/** Returns the XML text of a sitemap file, unpacking gzip, or null when it is not XML (e.g. an HTML fallback page). */
function toXml(file) {
  let bytes = file.bytes;
  const gzipped = /gzip/i.test(file.contentType) || file.url.toLowerCase().endsWith('.gz') || (bytes[0] === 0x1f && bytes[1] === 0x8b);
  if (gzipped) {
    try {
      bytes = gunzipSync(bytes);
    } catch {
      return null;
    }
  }
  if (looksLikeHtml(bytes)) return null;
  const text = bytes.toString('utf-8');
  return /<(urlset|sitemapindex)[\s>]/i.test(text) ? text : null;
}

/** @returns {{ urls: string[], sitemaps: string[] }} */
export function parseSitemap(xml) {
  const $ = cheerio.load(xml, { xml: true });
  const locs = (selector) =>
    $(selector)
      .map((_, element) => $(element).text().trim())
      .get()
      .filter((loc) => /^https?:\/\//i.test(loc));
  return {
    sitemaps: locs('sitemapindex > sitemap > loc'),
    urls: locs('urlset > url > loc'),
  };
}

function looksLikeHtml(bytes) {
  return /<(!doctype\s+html|html|head|body)[\s>]/i.test(bytes.subarray(0, 1024).toString('latin1'));
}
