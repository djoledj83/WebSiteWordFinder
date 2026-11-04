import { FetchError, isHtmlContentType } from './PageFetcher.js';
import { looksLikeSearchInput } from '../siteSearch.js';

const INSTALL_HINT = 'In the backend folder run "npm install playwright" and then "npx playwright install chromium".';

// Not needed for text and links; skipping them makes rendering much faster.
const SKIPPED_RESOURCES = new Set(['image', 'media', 'font', 'stylesheet']);

// The DOM counts as settled after this long without a mutation.
const DOM_QUIET_MS = 300;

/** Runs inside the page: resolves when no DOM mutation happened for `quietMs`, or after `maxMs`. */
function waitForDomToSettle({ quietMs, maxMs }) {
  return new Promise((resolve) => {
    let quiet;
    const finish = () => {
      clearTimeout(quiet);
      clearTimeout(deadline);
      observer.disconnect();
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(finish, quietMs);
    });
    const deadline = setTimeout(finish, maxMs);
    quiet = setTimeout(finish, quietMs);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  });
}

export class BrowserUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserUnavailableError';
    this.code = 'BROWSER_UNAVAILABLE';
  }
}

/**
 * Loads pages in headless Chromium (Playwright) so that sites which build
 * their content with JavaScript can be searched. Implements the PageFetcher
 * contract, so the crawler does not know which fetcher it is using.
 *
 * Chromium starts lazily on first use and is shared by all pages; at most
 * `concurrency` pages render at a time. Images, fonts, media and
 * stylesheets are not downloaded, which makes rendering noticeably faster
 * and does not change the text or the links of a page.
 */
export class BrowserFetcher {
  #timeoutMs;
  #settleMs;
  #maxBodyBytes;
  #userAgent;
  #addressGuard;
  #concurrency;

  #browser = null;
  #context = null;
  #launching = null;
  #active = 0;
  #waiting = [];

  constructor({ timeoutMs, settleMs, maxBodyBytes, userAgent, addressGuard, concurrency }) {
    this.#timeoutMs = timeoutMs;
    this.#settleMs = settleMs;
    this.#maxBodyBytes = maxBodyBytes;
    this.#userAgent = userAgent;
    this.#addressGuard = addressGuard;
    this.#concurrency = concurrency;
  }

  /** True when the Playwright package can be loaded (Chromium itself is checked on launch). */
  static async isInstalled() {
    try {
      await import('playwright');
      return true;
    } catch {
      return false;
    }
  }

  /** Starts Chromium if needed; throws BrowserUnavailableError with install instructions when it cannot. */
  async ensureReady() {
    await this.#getContext();
  }

  async fetch(urlString, { allow = () => true, signal } = {}) {
    const url = new URL(urlString);
    await this.#addressGuard.assertAllowed(url);
    const context = await this.#getContext();

    await this.#acquireSlot();
    const page = await context.newPage();
    const abort = () => page.close().catch(() => {});
    signal?.addEventListener('abort', abort, { once: true });

    // Server-side redirects are checked hop by hop, like HttpFetcher does.
    let blockedRedirect = null;
    let allowedRedirect = null;
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (SKIPPED_RESOURCES.has(request.resourceType())) return route.abort();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && request.redirectedFrom()) {
        if (!(await allow(request.url()))) {
          blockedRedirect = request.url();
          return route.abort('blockedbyclient');
        }
        allowedRedirect = request.url();
      }
      return route.continue();
    });

    try {
      let response;
      try {
        // 'load' means every script tag has been downloaded and run — on a cold
        // start an app's libraries can take seconds, and reading the page before
        // that would return the empty shell.
        response = await page.goto(url.href, { waitUntil: 'load', timeout: this.#timeoutMs });
      } catch (error) {
        if (blockedRedirect) return { url: url.href, status: 0, html: null, reason: 'redirect-not-allowed', contentType: '' };
        if (/ERR_ABORTED|Download is starting/.test(error.message)) {
          return { url: url.href, status: 0, html: null, reason: 'not-html', contentType: '' }; // a file download, not a page
        }
        throw toFetchError(error, this.#timeoutMs);
      }
      if (!response) throw new FetchError('The browser received no page for this URL', 'NO_RESPONSE');

      await this.#settle(page);
      if (signal?.aborted) throw new FetchError('Cancelled', 'ABORTED');

      const finalUrl = page.url();
      const status = response.status();
      const contentType = (await response.headerValue('content-type')) ?? '';
      const result = (reason) => ({ url: finalUrl, status, html: null, reason, contentType });

      // Client-side navigation (history.pushState) must stay within the crawl too.
      if (finalUrl !== url.href && finalUrl !== allowedRedirect && !(await allow(finalUrl))) return result('redirect-not-allowed');
      if (status >= 400) return result('http-status');
      if (!isHtmlContentType(contentType)) return result('not-html');

      const html = await page.content();
      if (html.length > this.#maxBodyBytes) throw new FetchError(`Rendered page is larger than ${this.#maxBodyBytes} bytes`, 'TOO_LARGE');
      return { url: finalUrl, status, html, reason: null, contentType };
    } finally {
      signal?.removeEventListener('abort', abort);
      await page.close().catch(() => {});
      this.#releaseSlot();
    }
  }

  /**
   * Opens `urlString`, finds the site's search box, types `phrase` and
   * presses Enter. Resolves with { url, html } of the page that results:
   * `url` is the new address when the search navigated (the usual case, and
   * the one that can be paged through), null when results were rendered in
   * place; `html` is the rendered results page either way. Resolves null
   * when no search box could be found.
   */
  async searchSite(urlString, phrase, { signal } = {}) {
    const url = new URL(urlString);
    await this.#addressGuard.assertAllowed(url);
    const context = await this.#getContext();

    await this.#acquireSlot();
    const page = await context.newPage();
    const abort = () => page.close().catch(() => {});
    signal?.addEventListener('abort', abort, { once: true });
    await page.route('**/*', (route) => (SKIPPED_RESOURCES.has(route.request().resourceType()) ? route.abort() : route.continue()));

    try {
      await page.goto(url.href, { waitUntil: 'load', timeout: this.#timeoutMs });
      await this.#settle(page);

      const box = await findSearchBox(page);
      if (!box) return null;

      const before = page.url();
      const navigated = page
        .waitForURL((next) => next.href !== before, { timeout: this.#settleMs * 2 })
        .then(() => true)
        .catch(() => false);
      await box.fill(phrase);
      await box.press('Enter');
      const moved = await navigated;
      await this.#settle(page);
      if (signal?.aborted) throw new FetchError('Cancelled', 'ABORTED');

      return { url: moved ? page.url() : null, html: await page.content() };
    } catch (error) {
      throw toFetchError(error, this.#timeoutMs);
    } finally {
      signal?.removeEventListener('abort', abort);
      await page.close().catch(() => {});
      this.#releaseSlot();
    }
  }

  async close() {
    const browser = this.#browser;
    this.#browser = null;
    this.#context = null;
    this.#launching = null;
    await browser?.close().catch(() => {});
  }

  /**
   * Gives the app time to call its API and render: wait for the network to go
   * quiet, then for the DOM to stop changing, each within the settle budget.
   */
  async #settle(page) {
    await page.waitForLoadState('networkidle', { timeout: this.#settleMs }).catch(() => {});
    await page.evaluate(waitForDomToSettle, { quietMs: DOM_QUIET_MS, maxMs: this.#settleMs }).catch(() => {});
  }

  #getContext() {
    if (this.#context) return Promise.resolve(this.#context);
    if (!this.#launching) {
      this.#launching = this.#launch().catch((error) => {
        this.#launching = null;
        throw error;
      });
    }
    return this.#launching;
  }

  async #launch() {
    let playwright;
    try {
      playwright = await import('playwright');
    } catch {
      throw new BrowserUnavailableError(`JavaScript rendering is not installed. ${INSTALL_HINT}`);
    }

    let browser;
    try {
      browser = await playwright.chromium.launch({
        headless: true,
        // /dev/shm is tiny inside Docker; let Chromium use ordinary temp files instead
        args: ['--disable-dev-shm-usage'],
      });
    } catch (error) {
      throw new BrowserUnavailableError(`Chromium could not be started (${firstLine(error.message)}). ${INSTALL_HINT}`);
    }

    const context = await browser.newContext({ userAgent: this.#userAgent, viewport: { width: 1280, height: 900 } });
    browser.on('disconnected', () => {
      if (this.#browser === browser) {
        this.#browser = null;
        this.#context = null;
        this.#launching = null;
      }
    });

    this.#browser = browser;
    this.#context = context;
    return context;
  }

  #acquireSlot() {
    if (this.#active < this.#concurrency) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiting.push(resolve)).then(() => {
      this.#active += 1;
    });
  }

  #releaseSlot() {
    this.#active -= 1;
    this.#waiting.shift()?.();
  }
}

/** The first visible input on the page that looks like a search box, or null. */
async function findSearchBox(page) {
  for (const handle of await page.$$('input, textarea, [role="searchbox"], [contenteditable="true"]')) {
    const attributes = await handle.evaluate((element) => ({
      type: element.type ?? '',
      name: element.name ?? '',
      id: element.id ?? '',
      placeholder: element.placeholder ?? '',
      ariaLabel: element.getAttribute('aria-label') ?? '',
      className: typeof element.className === 'string' ? element.className : '',
      role: element.getAttribute('role') ?? '',
      visible: Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
    }));
    if (attributes.visible && looksLikeSearchInput(attributes)) return handle;
  }
  return null;
}

function toFetchError(error, timeoutMs) {
  if (error instanceof FetchError) return error;
  if (error.name === 'TimeoutError') return new FetchError(`Timed out after ${timeoutMs} ms`, 'TIMEOUT');
  const message = firstLine(error.message);
  const code = /net::([A-Z_]+)/.exec(message)?.[1];
  return new FetchError(code ? `${code.replace(/^ERR_/, '').toLowerCase().replace(/_/g, ' ')} (${code})` : message, code ?? 'NETWORK');
}

function firstLine(text) {
  return String(text).split('\n')[0].trim();
}
