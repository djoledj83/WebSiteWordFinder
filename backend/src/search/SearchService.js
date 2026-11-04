import { randomUUID } from 'node:crypto';
import { Crawler } from '../crawler/Crawler.js';
import { BrowserUnavailableError } from '../crawler/fetchers/BrowserFetcher.js';
import { parsePage } from '../crawler/parsePage.js';
import { expandSeedUrls } from '../crawler/seedUrls.js';
import { findSearchFormUrl } from '../crawler/siteSearch.js';
import { discoverSitemapUrls } from '../crawler/sitemap.js';
import { findPhraseInPage } from '../matching/phraseMatcher.js';
import { SearchJob } from './SearchJob.js';

const CLEANUP_INTERVAL_MS = 60 * 1000;
const SITEMAP_TIME_LIMIT_MS = 20 * 1000;
const SITE_SEARCH_TIME_LIMIT_MS = 45 * 1000;

/**
 * Use cases of the application: start a search, look it up, stop it.
 * Composes the crawler with a page fetcher and the phrase matcher and
 * records the outcome on the job. The HTTP layer only ever talks to this
 * class.
 */
export class SearchService {
  #repository;
  #fetchers;
  #crawlConfig;
  #jobTtlMs;
  #cleanupTimer;

  /**
   * @param {object} deps
   * @param {object} deps.repository        see searchRepository.js
   * @param {object} deps.fetchers          { http: HttpFetcher, browser?: BrowserFetcher }
   * @param {object} deps.crawlConfig       the `crawl` section of the config
   * @param {number} deps.jobTtlMs          how long finished searches stay available
   */
  constructor({ repository, fetchers, crawlConfig, jobTtlMs }) {
    this.#repository = repository;
    this.#fetchers = fetchers;
    this.#crawlConfig = crawlConfig;
    this.#jobTtlMs = jobTtlMs;
    this.#cleanupTimer = setInterval(() => this.#forgetOldSearches(), CLEANUP_INTERVAL_MS).unref();
  }

  /**
   * Creates the job and starts crawling in the background. Resolves as soon
   * as the crawl is under way; rejects with BrowserUnavailableError when
   * JavaScript rendering was requested but Chromium cannot be started.
   */
  async createSearch({ url, phrase, options = {} }) {
    const resolved = this.#resolveOptions(options);
    const fetcher = await this.#fetcherFor(resolved);

    const job = new SearchJob({ id: randomUUID(), input: { url, phrase, options: resolved } });
    this.#repository.save(job);
    this.#run(job, fetcher).catch((error) => job.fail(error));
    return job;
  }

  getSearch(id) {
    return this.#repository.get(id);
  }

  stopSearch(id) {
    const job = this.#repository.get(id);
    job?.stop();
    return job;
  }

  /** What the UI needs to know before starting a search. */
  async describeCapabilities() {
    const { maxPages, maxPagesLimit, maxExtraStartUrls } = this.#crawlConfig;
    const browser = this.#fetchers.browser;
    const installed = browser ? await browser.constructor.isInstalled() : false;
    return {
      maxPagesDefault: maxPages,
      maxPagesLimit,
      maxExtraStartUrls,
      javaScriptRendering: {
        available: installed,
        reason: installed ? null : 'Playwright is not installed on the server (see README: JavaScript rendering).',
      },
    };
  }

  /** Stops the cleanup timer and releases the fetchers (used by tests and on shutdown). */
  async close() {
    clearInterval(this.#cleanupTimer);
    await Promise.all(Object.values(this.#fetchers).map((fetcher) => fetcher.close?.()));
  }

  #resolveOptions({ maxPages, caseSensitive, ignoreAccents, contentOnly, includeSubdomains, renderJavaScript, useSiteSearch, extraStartUrls }) {
    const { maxPages: defaultMaxPages, maxPagesLimit, maxDepth } = this.#crawlConfig;
    return {
      maxPages: Math.min(Math.max(1, maxPages ?? defaultMaxPages), maxPagesLimit),
      maxDepth,
      caseSensitive: Boolean(caseSensitive),
      ignoreAccents: ignoreAccents ?? true,
      contentOnly: contentOnly ?? true,
      includeSubdomains: Boolean(includeSubdomains),
      renderJavaScript: Boolean(renderJavaScript),
      useSiteSearch: useSiteSearch ?? true,
      extraStartUrls: Array.isArray(extraStartUrls) ? extraStartUrls : [],
    };
  }

  async #fetcherFor({ renderJavaScript }) {
    if (!renderJavaScript) return this.#fetchers.http;
    const browser = this.#fetchers.browser;
    if (!browser) throw new BrowserUnavailableError('JavaScript rendering is not enabled on this server.');
    await browser.ensureReady();
    return browser;
  }

  async #run(job, fetcher) {
    const { url, phrase, options } = job.input;
    job.markRunning();

    const crawler = new Crawler({
      fetcher,
      startUrl: url,
      includeSubdomains: options.includeSubdomains,
      contentOnly: options.contentOnly,
      maxPages: options.maxPages,
      maxDepth: options.maxDepth,
      concurrency: this.#crawlConfig.concurrency,
    });

    await this.#seed(crawler, job, fetcher);
    if (job.isFinished) return; // stopped while seeding

    const matchOptions = { caseSensitive: options.caseSensitive, ignoreAccents: options.ignoreAccents };
    const { stoppedBy, resolvedStartUrl, ...finalProgress } = await crawler.run({
      signal: job.signal,
      onPage: (page) => {
        if (page.resultsPage) return; // the site's own hit list is a means, not a result
        const { count, snippets, inTitle } = findPhraseInPage(page, phrase, matchOptions);
        if (count > 0) job.addResult({ url: page.url, title: page.title, depth: page.depth, count, snippets, inTitle });
      },
      onProgress: (progress) => job.updateProgress(progress),
      onPageError: (failure) => {
        job.addPageError(failure);
        // Without the start page there is nothing to crawl from.
        if (failure.isStart) job.fail(new Error(`Could not load the start page: ${failure.message}`));
      },
    });

    if (job.isFinished) return; // it failed while crawling; 'done' was already sent
    job.setResolvedUrl(resolvedStartUrl);
    job.updateProgress(finalProgress);
    job.finish({ stoppedBy });
  }

  /** Entry points besides the start URL: the user's extra URLs, the site's own search, and its sitemaps. */
  async #seed(crawler, job, fetcher) {
    const { extraStartUrls, useSiteSearch } = job.input.options;
    if (extraStartUrls.length > 0) {
      const urls = expandSeedUrls(extraStartUrls, { max: this.#crawlConfig.maxExtraStartUrls, phrase: job.input.phrase });
      crawler.addSeeds(urls, { explicit: true, paged: true });
    }

    if (useSiteSearch) {
      job.setSiteSearch(await this.#searchSite(crawler, job, fetcher));
      if (job.isFinished) return;
    }

    const signal = AbortSignal.any([job.signal, AbortSignal.timeout(SITEMAP_TIME_LIMIT_MS)]);
    const { urls, sitemapsRead } = await discoverSitemapUrls({
      startUrl: job.input.url,
      fetchResource: (url, options) => this.#fetchers.http.fetchResource(url, options),
      signal,
    });
    crawler.addSeeds(urls);
    job.setSitemapInfo({ sitemapsRead, urlsListed: urls.length });
    job.updateProgress(crawler.progress());
  }

  /**
   * Submits the phrase through the site's own search box and seeds the crawl
   * with the results: the results URL (paged through automatically) or, when
   * the results were rendered in place, the links they contain.
   * Returns a description for the UI; never fails the search.
   */
  async #searchSite(crawler, job, fetcher) {
    const { url, phrase } = job.input;
    const signal = AbortSignal.any([job.signal, AbortSignal.timeout(SITE_SEARCH_TIME_LIMIT_MS)]);
    try {
      let found = null;
      if (typeof fetcher.searchSite === 'function') {
        found = await fetcher.searchSite(url, phrase, { signal });
      } else {
        const page = await fetcher.fetch(url, { signal });
        const formUrl = page.html && findSearchFormUrl(page.html, page.url, phrase);
        if (formUrl) found = { url: formUrl, html: null };
      }

      if (!found) return { used: false, reason: 'No search box was found on the start page.' };
      if (found.url) {
        const added = crawler.addSeeds([found.url], { explicit: true, paged: true, resultsPage: true });
        return added > 0
          ? { used: true, url: found.url }
          : { used: false, reason: 'The search results page is outside the website being searched.' };
      }
      // results drawn into the same page: use whatever they link to
      const { links } = parsePage(found.html, url, { contentOnly: false });
      const added = crawler.addSeeds(links);
      return { used: true, url: null, linksAdded: added };
    } catch (error) {
      if (job.signal.aborted) return { used: false, reason: 'Stopped.' };
      return { used: false, reason: `The site's search could not be used: ${error.message}` };
    }
  }

  #forgetOldSearches() {
    const cutoff = Date.now() - this.#jobTtlMs;
    for (const job of this.#repository.all()) {
      if (job.isFinished && job.finishedAt.getTime() < cutoff) this.#repository.delete(job.id);
    }
  }
}
