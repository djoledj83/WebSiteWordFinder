import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { Crawler } from '../src/crawler/Crawler.js';
import { AddressGuard } from '../src/crawler/fetchers/addressGuard.js';
import { BrowserFetcher } from '../src/crawler/fetchers/BrowserFetcher.js';
import { HttpFetcher } from '../src/crawler/fetchers/HttpFetcher.js';
import { SearchService } from '../src/search/SearchService.js';
import { createInMemorySearchRepository } from '../src/search/searchRepository.js';
import { readEvents } from './helpers/sse.js';
import { startTestSite } from './helpers/testSite.js';

/**
 * These tests need Playwright and Chromium. When they are not installed the
 * suite is skipped, so `npm test` still works on a machine without them.
 */
const makeBrowserFetcher = () =>
  new BrowserFetcher({
    timeoutMs: 10_000,
    settleMs: 800,
    maxBodyBytes: 5 * 1024 * 1024,
    userAgent: 'test-browser',
    addressGuard: new AddressGuard({ allowPrivateAddresses: true }),
    concurrency: 2,
  });

async function browserAvailable() {
  if (!(await BrowserFetcher.isInstalled())) return false;
  const probe = makeBrowserFetcher();
  try {
    await probe.ensureReady();
    return true;
  } catch {
    return false;
  } finally {
    await probe.close();
  }
}

const available = await browserAvailable();

describe('BrowserFetcher (Playwright)', { skip: available ? false : 'Playwright/Chromium not installed' }, () => {
  let site;
  let fetcher;
  before(async () => {
    site = await startTestSite();
    fetcher = makeBrowserFetcher();
  });
  after(async () => {
    await fetcher.close();
    await site.close();
  });

  it('renders JavaScript-built content and links', async () => {
    const pages = [];
    const crawler = new Crawler({ fetcher, startUrl: `${site.url}/spa`, maxPages: 10, maxDepth: 3, concurrency: 2 });
    const summary = await crawler.run({ onPage: (page) => pages.push(page) });

    const byPath = Object.fromEntries(pages.map((page) => [page.url.replace(site.url, ''), page.text]));
    assert.deepEqual(byPath, {
      '/spa': 'Rendered by script: Belgrade terminal.\nchild',
      '/spa-child': 'Child rendered: Belgrade terminal.',
    });
    assert.equal(summary.discovered, 1);
  });

  it('waits for slow libraries before reading the page (cold start)', async () => {
    const result = await fetcher.fetch(`${site.url}/slow-app`);
    assert.match(result.html, /Rendered after the library arrived: Belgrade terminal/);
  });

  it('finds a web-app search box, submits the phrase and reports where it landed', async () => {
    const found = await fetcher.searchSite(`${site.url}/spa-search`, 'orphan');
    assert.equal(found.url, `${site.url}/results?q=orphan&p=1`);
    assert.match(found.html, /Results page 1 for orphan/);
    assert.equal(await fetcher.searchSite(`${site.url}/about`, 'orphan'), null);
  });

  it('follows allowed redirects and reports the final URL', async () => {
    const result = await fetcher.fetch(`${site.url}/redirect-new`);
    assert.equal(result.url, `${site.url}/new-page`);
    assert.equal(result.status, 200);
    assert.match(result.html, /Reached through a redirect/);
  });

  it('refuses redirects the crawl does not allow', async () => {
    const result = await fetcher.fetch(`${site.url}/redirect-dup`, { allow: () => false });
    assert.equal(result.reason, 'redirect-not-allowed');
    assert.equal(result.html, null);
  });

  it('classifies non-HTML responses and HTTP errors like the HTTP fetcher', async () => {
    assert.equal((await fetcher.fetch(`${site.url}/image`)).reason, 'not-html');
    assert.equal((await fetcher.fetch(`${site.url}/files/doc.pdf`)).reason, 'not-html');
    const missing = await fetcher.fetch(`${site.url}/missing`);
    assert.equal(missing.reason, 'http-status');
    assert.equal(missing.status, 404);
  });

  it('turns connection failures into FetchErrors', async () => {
    await assert.rejects(fetcher.fetch('http://127.0.0.1:1/'), (error) => error.name === 'FetchError');
  });

  it('can be aborted mid-crawl', async () => {
    const controller = new AbortController();
    let scanned = 0;
    const crawler = new Crawler({ fetcher, startUrl: `${site.url}/gen/1`, maxPages: 100, maxDepth: 100, concurrency: 1 });
    const summary = await crawler.run({
      signal: controller.signal,
      onPage: () => {
        scanned += 1;
        if (scanned === 2) controller.abort();
      },
    });
    assert.equal(summary.stoppedBy, 'abort');
    assert.equal(scanned, 2);
  });
});

describe('API with JavaScript rendering', { skip: available ? false : 'Playwright/Chromium not installed' }, () => {
  let site;
  let server;
  let api;
  let searchService;

  before(async () => {
    site = await startTestSite();
    const crawlConfig = { maxPages: 50, maxPagesLimit: 100, maxDepth: 10, maxExtraStartUrls: 20, concurrency: 3, timeoutMs: 1000, maxBodyBytes: 1024 * 1024, userAgent: 'test' };
    const addressGuard = new AddressGuard({ allowPrivateAddresses: true });
    searchService = new SearchService({
      repository: createInMemorySearchRepository(),
      fetchers: { http: new HttpFetcher({ ...crawlConfig, addressGuard }), browser: makeBrowserFetcher() },
      crawlConfig,
      jobTtlMs: 60_000,
    });
    const app = createApp({ searchService, limits: { maxPagesLimit: 100, maxExtraStartUrls: 20 } });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    api = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    await searchService.close();
    await new Promise((resolve) => server.close(resolve));
    await site.close();
  });

  it('reports JavaScript rendering as available', async () => {
    const config = await (await fetch(`${api}/config`)).json();
    assert.deepEqual(config.javaScriptRendering, { available: true, reason: null });
  });

  it('finds the phrase on a single-page app when renderJavaScript is on', async () => {
    const start = (renderJavaScript) =>
      fetch(`${api}/searches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: `${site.url}/spa`, phrase: 'belgrade terminal', options: { renderJavaScript } }),
      }).then((response) => response.json());

    const spaMatches = (events) =>
      events
        .filter((e) => e.name === 'match')
        .map((e) => e.data.url.replace(site.url, ''))
        .filter((path) => path.startsWith('/spa'))
        .sort();

    // the sitemaps lead to the rest of the site either way; only the app pages differ
    const plain = await start(false);
    assert.deepEqual(spaMatches(await readEvents(`${api}/searches/${plain.id}/events`)), []);

    const rendered = await start(true);
    const events = await readEvents(`${api}/searches/${rendered.id}/events`);
    assert.deepEqual(spaMatches(events), ['/spa', '/spa-child']);
    assert.equal(events.at(-1).data.status, 'completed');
  });

  it('searches through the web app\'s own search box and pages through the results', async () => {
    const created = await fetch(`${api}/searches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${site.url}/spa-search`, phrase: 'orphan', options: { renderJavaScript: true } }),
    }).then((response) => response.json());
    const events = await readEvents(`${api}/searches/${created.id}/events`);
    const done = events.at(-1).data;
    assert.deepEqual(done.siteSearch, { used: true, url: `${site.url}/results?q=orphan&p=1` });
    const matched = events.filter((e) => e.name === 'match').map((e) => e.data.url.replace(site.url, '')).sort();
    assert.deepEqual(matched, ['/orphan-1', '/orphan-2']);
    assert.equal(done.progress.listPages, 1);
  });
});
