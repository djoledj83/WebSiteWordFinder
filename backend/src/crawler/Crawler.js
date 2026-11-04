import { createScope, isCrawlable, isInScope, normalizeUrl } from './urlPolicy.js';
import { parsePage } from './parsePage.js';
import { nextPageUrl } from './siteSearch.js';

const noop = () => {};

// How many "next page" follow-ups a crawl may make in total (results lists, catalogs).
const MAX_PAGED_FOLLOWUPS = 1000;

/**
 * Breadth-first crawl of one website.
 *
 * One instance is one crawl: it starts at `startUrl` (plus any seeds added
 * with `addSeeds`), follows links that urlPolicy accepts, and hands every
 * HTML page to `onPage`. A pool of `concurrency` workers pulls from a shared
 * queue; the crawl ends when the queue is exhausted, the page budget is
 * spent, or the signal aborts.
 *
 * The crawler knows nothing about phrases: whoever consumes `onPage`
 * decides what to do with the text, which keeps this reusable.
 */
export class Crawler {
  #fetcher;
  #startUrl;
  #scope;
  #scopeOptions;
  #maxPages;
  #maxDepth;
  #concurrency;
  #contentOnly;

  #queue = [];
  #seen = new Set();
  #scheduled = 0; // pages taken from the queue (the budget counts attempts)
  #scanned = 0; // HTML pages parsed
  #errors = 0; // could not be loaded
  #skipped = 0; // loaded but not a page (non-HTML, redirect out of scope...)
  #discovered = 0; // in-scope pages found through links
  #seeded = 0; // pages added through sitemaps, extra start URLs or the site's search
  #pagedFollowups = 0; // "next page" URLs derived from paged lists
  #inFlight = 0;
  #waiters = [];
  #signal;
  #started = false;
  #resolvedStartUrl = null;

  constructor({ fetcher, startUrl, includeSubdomains = false, contentOnly = true, maxPages, maxDepth, concurrency }) {
    const start = normalizeUrl(startUrl);
    if (!start) throw new Error(`Invalid start URL: ${startUrl}`);

    this.#fetcher = fetcher;
    this.#startUrl = start;
    this.#scopeOptions = { includeSubdomains };
    this.#scope = createScope(start, this.#scopeOptions);
    this.#maxPages = maxPages;
    this.#maxDepth = maxDepth;
    this.#concurrency = concurrency;
    this.#contentOnly = contentOnly;

    // The start URL skips the extension filter: the user asked for it explicitly.
    this.#seen.add(start);
    this.#queue.push({ url: start, depth: 0, isStart: true });
  }

  /** The site being crawled; changes only when the start URL redirects to another host. */
  get scope() {
    return this.#scope;
  }

  /**
   * Adds entry points besides the start URL (sitemap entries, user-supplied
   * list pages, the site's search results). Only in-scope URLs are
   * accepted; `explicit` ones skip the extension filter like the start URL
   * does. `paged` ones are lists: when such a page yields new links and its
   * URL carries a page number, the following page is fetched as well, until
   * a page yields nothing new. `resultsPage` marks the site's own search
   * results, which are handed to `onPage` with that flag so they can be
   * crawled for links but not reported as matches. Returns how many were added.
   */
  addSeeds(urls, { explicit = false, paged = false, resultsPage = false } = {}) {
    let added = 0;
    for (const candidate of urls) {
      if (this.#enqueueSeed(candidate, { explicit, paged, resultsPage })) added += 1;
    }
    this.#seeded += added;
    this.#notifyChange();
    return added;
  }

  #enqueueSeed(candidate, { explicit, paged, resultsPage = false, previousLinks = null }) {
    const url = normalizeUrl(candidate);
    if (!url || this.#seen.has(url)) return false;
    if (!(explicit ? isInScope(url, this.#scope) : isCrawlable(url, this.#scope))) return false;
    this.#seen.add(url);
    this.#queue.push({ url, depth: 0, paged, resultsPage, previousLinks });
    return true;
  }

  /**
   * @param {object} handlers
   * @param {(page: {url: string, requestedUrl: string, depth: number, title: string, text: string}) => void} handlers.onPage
   * @param {(progress: object) => void} [handlers.onProgress]  After every finished page.
   * @param {(failure: {url: string, depth: number, isStart: boolean, message: string, code: string}) => void} [handlers.onPageError]
   * @param {AbortSignal} [handlers.signal]  Stops the crawl; in-flight requests are cancelled.
   * @returns {Promise<object>} the final progress plus `stoppedBy` ('exhausted' | 'page-budget' | 'abort') and `resolvedStartUrl`
   */
  async run({ onPage, onProgress = noop, onPageError = noop, signal } = {}) {
    if (this.#started) throw new Error('A Crawler instance runs only once');
    this.#started = true;
    this.#signal = signal;

    const handlers = { onPage, onProgress, onPageError };
    await Promise.all(Array.from({ length: this.#concurrency }, () => this.#worker(handlers)));

    return { ...this.progress(), stoppedBy: this.#stoppedBy(), resolvedStartUrl: this.#resolvedStartUrl ?? this.#startUrl };
  }

  progress() {
    return {
      scanned: this.#scanned,
      errors: this.#errors,
      skipped: this.#skipped,
      discovered: this.#discovered,
      seeded: this.#seeded,
      listPages: this.#pagedFollowups,
      queued: this.#queue.length,
      inFlight: this.#inFlight,
    };
  }

  async #worker(handlers) {
    for (;;) {
      if (this.#signal?.aborted || this.#scheduled >= this.#maxPages) return;

      const item = this.#queue.shift();
      if (!item) {
        if (this.#inFlight === 0) return; // nothing queued and nobody can add more
        await this.#waitForChange(); // another worker may still discover links
        continue;
      }

      this.#scheduled += 1;
      this.#inFlight += 1;
      try {
        await this.#visit(item, handlers);
      } finally {
        this.#inFlight -= 1;
        this.#notifyChange();
      }
      handlers.onProgress(this.progress());
    }
  }

  async #visit({ url, depth, isStart = false, paged = false, resultsPage = false, previousLinks = null }, { onPage, onPageError }) {
    let result;
    try {
      result = await this.#fetcher.fetch(url, {
        allow: (target) => (isStart ? this.#allowStartRedirect(target) : this.#allowRedirect(target)),
        signal: this.#signal,
      });
    } catch (error) {
      if (this.#signal?.aborted) return;
      this.#errors += 1;
      onPageError({ url, depth, isStart, message: error.message, code: error.code ?? 'FETCH_FAILED' });
      return;
    }

    if (result.html === null) {
      if (result.reason === 'http-status') {
        this.#errors += 1;
        onPageError({ url, depth, isStart, message: `HTTP ${result.status}`, code: 'HTTP_STATUS' });
      } else {
        this.#skipped += 1;
      }
      return;
    }

    if (isStart) this.#adoptStart(result.url);

    const page = parsePage(result.html, result.url, { contentOnly: this.#contentOnly });
    this.#scanned += 1;

    if (depth < this.#maxDepth) {
      for (const link of page.links) this.#enqueue(link, depth + 1);
    }

    // A list page is followed to its next page as long as it still shows
    // links the previous page of the list did not (menus repeat, results don't).
    if (paged && this.#pagedFollowups < MAX_PAGED_FOLLOWUPS) {
      const links = new Set(page.links.map((link) => normalizeUrl(link)).filter((link) => link && link !== url && isCrawlable(link, this.#scope)));
      const novel = [...links].some((link) => !previousLinks?.has(link));
      const next = novel ? nextPageUrl(url) : null;
      if (next && this.#enqueueSeed(next, { explicit: true, paged: true, resultsPage, previousLinks: links })) {
        this.#pagedFollowups += 1;
        this.#seeded += 1;
      }
    }

    onPage({ url: result.url, requestedUrl: url, depth, title: page.title, text: page.text, resultsPage });
  }

  #enqueue(href, depth) {
    const url = normalizeUrl(href);
    if (!url || this.#seen.has(url) || !isCrawlable(url, this.#scope)) return false;
    this.#seen.add(url);
    this.#queue.push({ url, depth });
    this.#discovered += 1;
    return true;
  }

  /** Redirects may only lead to in-scope pages that have not been fetched yet. */
  #allowRedirect(target) {
    const url = normalizeUrl(target);
    if (!url || this.#seen.has(url) || !isInScope(url, this.#scope)) return false;
    this.#seen.add(url);
    return true;
  }

  /** The start URL may redirect anywhere (example.rs -> example.com); the site is then the one it lands on. */
  #allowStartRedirect(target) {
    const url = normalizeUrl(target);
    if (!url || this.#seen.has(url)) return false;
    this.#seen.add(url);
    return true;
  }

  #adoptStart(finalUrl) {
    this.#resolvedStartUrl = finalUrl;
    if (!isInScope(finalUrl, this.#scope)) this.#scope = createScope(finalUrl, this.#scopeOptions);
  }

  #stoppedBy() {
    if (this.#signal?.aborted) return 'abort';
    if (this.#queue.length > 0 && this.#scheduled >= this.#maxPages) return 'page-budget';
    return 'exhausted';
  }

  #waitForChange() {
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #notifyChange() {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}
