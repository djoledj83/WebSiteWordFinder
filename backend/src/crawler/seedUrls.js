/**
 * "Additional start URLs" let a user point the crawler at pages that no
 * link leads to, typically paged lists in web apps whose paging buttons are
 * not links: /catalog?page=2, /catalog?page=3, ...
 *
 * A pattern may contain numeric ranges in braces, which are expanded:
 *   https://example.com/list?p={1-100}      -> p=1 ... p=100
 *   https://example.com/a/{01-12}/index     -> 01 ... 12 (zero-padded like the bounds)
 *   https://example.com/{1-3}/{1..2}        -> every combination (3 x 2 URLs)
 *   https://example.com/search?q={phrase}   -> the search phrase, URL-encoded
 */
const RANGE = /\{(\d+)(?:-|\.\.)(\d+)\}/;

/** Expands one pattern. Throws when the expansion would exceed `max` URLs. */
export function expandUrlRange(pattern, { max = 5000 } = {}) {
  const match = RANGE.exec(pattern);
  if (!match) return [pattern];

  const [placeholder, fromText, toText] = match;
  const from = Number(fromText);
  const to = Number(toText);
  if (to < from) throw new RangeError(`Range ${placeholder} must count upwards`);
  if (to - from + 1 > max) throw new RangeError(`Range ${placeholder} expands to more than ${max} URLs`);

  const width = fromText.startsWith('0') && fromText.length === toText.length ? fromText.length : 0;
  const results = [];
  for (let n = from; n <= to; n += 1) {
    const value = width ? String(n).padStart(width, '0') : String(n);
    for (const expanded of expandUrlRange(pattern.replace(placeholder, value), { max })) {
      results.push(expanded);
      if (results.length > max) throw new RangeError(`"${pattern}" expands to more than ${max} URLs`);
    }
  }
  return results;
}

/**
 * Expands a list of patterns (one URL or pattern per entry) into a
 * de-duplicated list, capped at `max`. `{phrase}` in a pattern is replaced
 * by the URL-encoded search phrase, which lets a site's own search page
 * seed the crawl: https://example.com/search?q={phrase}&page={1-5}
 */
export function expandSeedUrls(patterns, { max = 5000, phrase = '' } = {}) {
  const urls = new Set();
  for (const pattern of patterns) {
    const withPhrase = pattern.replace(/\{phrase\}/gi, encodeURIComponent(phrase));
    for (const url of expandUrlRange(withPhrase, { max })) {
      urls.add(url);
      if (urls.size > max) throw new RangeError(`Additional start URLs expand to more than ${max} URLs`);
    }
  }
  return [...urls];
}
