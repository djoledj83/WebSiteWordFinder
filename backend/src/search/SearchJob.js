import { EventEmitter } from 'node:events';

export const JobStatus = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  STOPPED: 'stopped',
  FAILED: 'failed',
});

const FINISHED = new Set([JobStatus.COMPLETED, JobStatus.STOPPED, JobStatus.FAILED]);
const MAX_STORED_ERRORS = 20;

/**
 * The state of one search: what was asked, how far the crawl is, which pages
 * matched, and how it ended. It also broadcasts live events ('progress',
 * 'match', 'page-error', 'done') to subscribers, which is what the SSE
 * endpoint relays.
 *
 * The job holds state only; SearchService drives it.
 */
export class SearchJob {
  #events = new EventEmitter();
  #abort = new AbortController();

  constructor({ id, input }) {
    this.id = id;
    this.input = input; // { url, phrase, options }
    this.status = JobStatus.PENDING;
    this.createdAt = new Date();
    this.finishedAt = null;
    this.progress = { scanned: 0, errors: 0, skipped: 0, discovered: 0, seeded: 0, listPages: 0, queued: 0, inFlight: 0, found: 0 };
    this.results = [];
    this.errors = []; // first few page failures, for display
    this.error = null; // why the whole search failed, if it did
    this.stoppedBy = null; // 'exhausted' | 'page-budget' | 'abort'
    this.resolvedUrl = null; // where the start URL ended up after redirects
    this.sitemap = null; // { sitemapsRead, urlsListed }
    this.siteSearch = null; // { used, url?, linksAdded?, reason? }
    this.#events.setMaxListeners(0);
  }

  setResolvedUrl(url) {
    this.resolvedUrl = url;
  }

  setSitemapInfo(info) {
    this.sitemap = info;
  }

  setSiteSearch(info) {
    this.siteSearch = info;
  }

  /** Aborts the crawl when the job is stopped or fails. */
  get signal() {
    return this.#abort.signal;
  }

  get isFinished() {
    return FINISHED.has(this.status);
  }

  markRunning() {
    this.status = JobStatus.RUNNING;
  }

  updateProgress(crawlProgress) {
    this.progress = { ...this.progress, ...crawlProgress, found: this.results.length };
    this.#events.emit('progress', this.progress);
  }

  addResult(result) {
    if (this.results.some((existing) => existing.url === result.url)) return;
    this.results.push(result);
    this.progress.found = this.results.length;
    this.#events.emit('match', result);
  }

  addPageError(failure) {
    if (this.errors.length >= MAX_STORED_ERRORS) return;
    this.errors.push(failure);
    this.#events.emit('page-error', failure);
  }

  /** Requests a stop; the status becomes 'stopped' once the crawl loop has exited. */
  stop() {
    if (!this.isFinished) this.#abort.abort();
  }

  finish({ stoppedBy }) {
    if (this.isFinished) return;
    this.status = this.signal.aborted ? JobStatus.STOPPED : JobStatus.COMPLETED;
    this.stoppedBy = stoppedBy;
    this.#end();
  }

  fail(error) {
    if (this.isFinished) return;
    this.status = JobStatus.FAILED;
    this.error = error.message;
    this.#abort.abort();
    this.#end();
  }

  /**
   * Listens to live events. `listener(eventName, data)` receives 'progress',
   * 'match', 'page-error' and 'done'. Returns a function that unsubscribes.
   */
  subscribe(listener) {
    const handlers = ['progress', 'match', 'page-error', 'done'].map((name) => [name, (data) => listener(name, data)]);
    for (const [name, handler] of handlers) this.#events.on(name, handler);
    return () => {
      for (const [name, handler] of handlers) this.#events.off(name, handler);
    };
  }

  /** Everything a client needs to render the search, e.g. after a page refresh. */
  snapshot() {
    return {
      id: this.id,
      status: this.status,
      input: this.input,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
      progress: this.progress,
      results: this.results,
      errors: this.errors,
      error: this.error,
      stoppedBy: this.stoppedBy,
      resolvedUrl: this.resolvedUrl,
      sitemap: this.sitemap,
      siteSearch: this.siteSearch,
    };
  }

  #end() {
    this.finishedAt = new Date();
    this.#events.emit('done', {
      status: this.status,
      progress: this.progress,
      error: this.error,
      stoppedBy: this.stoppedBy,
      resolvedUrl: this.resolvedUrl,
      sitemap: this.sitemap,
      siteSearch: this.siteSearch,
    });
  }
}
