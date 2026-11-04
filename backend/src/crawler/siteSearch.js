import * as cheerio from 'cheerio';

/**
 * Lets a site's own search box do the hard part of finding pages.
 *
 * Many sites keep their content behind lists, trees and search forms that
 * a link crawler cannot reach. Nearly all of them have a search box, and
 * submitting the phrase there lands on a results page that links to exactly
 * the pages we want. This module finds that box: in server-rendered HTML as
 * a GET form (the URL can be built directly), and in a rendered page as an
 * input the browser fetcher can type into.
 *
 * It also recognises paged result URLs (?page=2, ?p=3, ...) so the crawler
 * can keep turning pages until they run out.
 */

// Words that mark a search box in the languages the tool is likely to meet.
const SEARCH_WORDS = /search|find|query|hled|vyhled|such|cerca|busca|recherch|szukaj|keres|zoek|s[öo]k|etsi|arama|поиск|претраг|pretra|iskanje|traž|traz/i;

// Query parameters that carry a page number.
const PAGE_PARAMS = new Set(['p', 'page', 'pg', 'pagina', 'strana', 'stranka', 'seite', 'pageno', 'pagenum', 'page_no', 'page_number', 'pagenumber']);

/** True when an input's attributes say "this is a search box". */
export function looksLikeSearchInput({ type = '', name = '', id = '', placeholder = '', ariaLabel = '', className = '', role = '' }) {
  if (['hidden', 'password', 'email', 'number', 'checkbox', 'radio', 'submit', 'button', 'file', 'tel', 'url', 'date'].includes(type.toLowerCase())) return false;
  if (type.toLowerCase() === 'search' || role.toLowerCase() === 'searchbox') return true;
  return SEARCH_WORDS.test(`${name} ${id} ${placeholder} ${ariaLabel} ${className}`);
}

/**
 * Finds a GET search form in server-rendered HTML and returns the URL that
 * submitting `phrase` through it would open, or null.
 */
export function findSearchFormUrl(html, pageUrl, phrase) {
  const $ = cheerio.load(html);
  const forms = $('form').toArray();
  for (const form of forms) {
    const $form = $(form);
    if (($form.attr('method') ?? 'get').toLowerCase() !== 'get') continue;

    const input = $form
      .find('input')
      .toArray()
      .find((element) => {
        const $input = $(element);
        return $input.attr('name') && looksLikeSearchInput({
          type: $input.attr('type') ?? 'text',
          name: $input.attr('name'),
          id: $input.attr('id'),
          placeholder: $input.attr('placeholder'),
          ariaLabel: $input.attr('aria-label'),
          className: $input.attr('class'),
          role: $input.attr('role'),
        });
      });
    if (!input) continue;

    let url;
    try {
      url = new URL($form.attr('action') || pageUrl, pageUrl);
    } catch {
      continue;
    }
    $form.find('input[type="hidden"][name]').each((_, hidden) => {
      url.searchParams.set($(hidden).attr('name'), $(hidden).attr('value') ?? '');
    });
    url.searchParams.set($(input).attr('name'), phrase);
    url.hash = '';
    return url.href;
  }
  return null;
}

/**
 * For a URL with a page-number parameter, the URL of the following page;
 * null when the URL is not paged. "?p=1&s=100" -> "?p=2&s=100".
 */
export function nextPageUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }
  for (const [name, value] of url.searchParams) {
    if (PAGE_PARAMS.has(name.toLowerCase()) && /^\d+$/.test(value)) {
      url.searchParams.set(name, String(Number(value) + 1));
      return url.href;
    }
  }
  return null;
}
