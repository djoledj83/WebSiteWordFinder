import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { validateSearchRequest } from '../src/api/routes.js';
import { AddressGuard } from '../src/crawler/fetchers/addressGuard.js';
import { BrowserUnavailableError } from '../src/crawler/fetchers/BrowserFetcher.js';
import { HttpFetcher } from '../src/crawler/fetchers/HttpFetcher.js';
import { SearchService } from '../src/search/SearchService.js';
import { createInMemorySearchRepository } from '../src/search/searchRepository.js';
import { readEvents } from './helpers/sse.js';
import { startTestSite } from './helpers/testSite.js';

const crawlConfig = { maxPages: 50, maxPagesLimit: 100, maxDepth: 10, maxExtraStartUrls: 20, concurrency: 3, timeoutMs: 1000, maxBodyBytes: 1024 * 1024, userAgent: 'test' };
const limits = { maxPagesLimit: crawlConfig.maxPagesLimit, maxExtraStartUrls: crawlConfig.maxExtraStartUrls };

/** Stands in for a BrowserFetcher whose Chromium is missing. */
class MissingBrowserFetcher {
  static async isInstalled() {
    return false;
  }
  async ensureReady() {
    throw new BrowserUnavailableError('Chromium could not be started (test). Install it.');
  }
  async close() {}
}

describe('HTTP API', () => {
  let site;
  let server;
  let api;
  let searchService;

  before(async () => {
    site = await startTestSite();
    const http = new HttpFetcher({ ...crawlConfig, addressGuard: new AddressGuard({ allowPrivateAddresses: true }) });
    searchService = new SearchService({
      repository: createInMemorySearchRepository(),
      fetchers: { http, browser: new MissingBrowserFetcher() },
      crawlConfig,
      jobTtlMs: 60_000,
    });
    const app = createApp({ searchService, limits });
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

  const post = (path, body) =>
    fetch(`${api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('describes limits and capabilities', async () => {
    const config = await (await fetch(`${api}/config`)).json();
    assert.deepEqual(config, {
      maxPagesDefault: 50,
      maxPagesLimit: 100,
      maxExtraStartUrls: 20,
      javaScriptRendering: { available: false, reason: 'Playwright is not installed on the server (see README: JavaScript rendering).' },
    });
  });

  it('runs a search and streams snapshot, progress, match, page-error and done events', async () => {
    const created = await post('/searches', { url: site.url, phrase: 'belgrade terminal' });
    assert.equal(created.status, 201);
    const { id } = await created.json();

    const events = await readEvents(`${api}/searches/${id}/events`);
    const names = events.map((event) => event.name);
    assert.equal(names[0], 'snapshot');
    assert.equal(names.at(-1), 'done');
    assert.ok(names.includes('progress'));

    // linked pages plus the two pages only the sitemaps know about
    const matchedPaths = events.filter((e) => e.name === 'match').map((e) => pathOf(e.data.url)).sort();
    assert.deepEqual(matchedPaths, ['/about', '/about?utm=1', '/blog/post-1', '/new-page', '/orphan-1', '/orphan-2']);

    const about = events.find((e) => e.name === 'match' && e.data.url.endsWith('/about'));
    assert.equal(about.data.count, 1);
    assert.equal(about.data.snippets[0].match, 'Belgrade terminal');

    const pageErrors = events.filter((e) => e.name === 'page-error').map((e) => [pathOf(e.data.url), e.data.message]);
    assert.deepEqual(pageErrors, [['/missing', 'HTTP 404']]);

    const done = events.at(-1).data;
    assert.equal(done.status, 'completed');
    assert.equal(done.progress.scanned, 10);
    assert.equal(done.progress.found, 6);
    assert.equal(done.progress.seeded, 3); // orphan-1, orphan-2 and /about from the sitemaps
    assert.deepEqual(done.sitemap, { sitemapsRead: 3, urlsListed: 5 });
    assert.equal(done.resolvedUrl, `${site.url}/`);

    const snapshot = await (await fetch(`${api}/searches/${id}`)).json();
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.results.length, 6);
    assert.equal(snapshot.stoppedBy, 'exhausted');
    assert.deepEqual(snapshot.input.options, {
      maxPages: 50,
      maxDepth: 10,
      caseSensitive: false,
      ignoreAccents: true,
      contentOnly: true,
      includeSubdomains: false,
      renderJavaScript: false,
      useSiteSearch: true,
      extraStartUrls: [],
    });
    assert.deepEqual(snapshot.siteSearch, { used: false, reason: 'No search box was found on the start page.' });
  });

  it('uses the site\'s own search form when the start page has one', async () => {
    const created = await post('/searches', { url: `${site.url}/with-search`, phrase: 'Orphan' });
    const { id } = await created.json();
    const events = await readEvents(`${api}/searches/${id}/events`);
    const done = events.at(-1).data;
    assert.deepEqual(done.siteSearch, { used: true, url: `${site.url}/search?q=Orphan` });
    // the hit list itself mentions the phrase but is not reported: only real pages are
    const matched = events.filter((e) => e.name === 'match').map((e) => pathOf(e.data.url)).sort();
    assert.deepEqual(matched, ['/orphan-1', '/orphan-2']);
  });

  it('turns the pages of a paged list until one brings nothing new', async () => {
    const created = await post('/searches', {
      url: `${site.url}/menu-only`,
      phrase: 'orphan',
      options: { useSiteSearch: false, extraStartUrls: `${site.url}/results?q={phrase}&p=1` },
    });
    const { id } = await created.json();
    const events = await readEvents(`${api}/searches/${id}/events`);
    const matched = events.filter((e) => e.name === 'match').map((e) => pathOf(e.data.url)).sort();
    assert.deepEqual(matched, ['/orphan-1', '/orphan-2', '/results?q=orphan&p=1', '/results?q=orphan&p=2']);
    assert.ok(site.requests.includes('/results?q=orphan&p=2'));
    assert.ok(!site.requests.includes('/results?q=orphan&p=3'));
    assert.equal(events.at(-1).data.progress.listPages, 1);
  });

  it('ignores accents and page furniture by default, and can be told not to', async () => {
    const search = async (phrase, options) => {
      const created = await post('/searches', { url: `${site.url}/menu-only`, phrase, options });
      const { id } = await created.json();
      const events = await readEvents(`${api}/searches/${id}/events`);
      return events.filter((e) => e.name === 'match').map((e) => pathOf(e.data.url)).sort();
    };
    const seeds = { extraStartUrls: `${site.url}/accents` };

    assert.deepEqual(await search('vitkovice', seeds), ['/accents']);
    assert.deepEqual(await search('vitkovice', { ...seeds, ignoreAccents: false }), []);
    assert.deepEqual(await search('durdevac', seeds), ['/accents']);

    assert.deepEqual(await search('terminal news', seeds), []);
    assert.deepEqual(await search('terminal news', { ...seeds, contentOnly: false }), ['/menu-only']);
  });

  it('seeds the crawl from the site\'s own search page through {phrase}', async () => {
    const created = await post('/searches', {
      url: `${site.url}/menu-only`,
      phrase: 'Orphan',
      options: { extraStartUrls: `${site.url}/search?q={phrase}` },
    });
    const { id } = await created.json();
    const events = await readEvents(`${api}/searches/${id}/events`);
    const matched = events.filter((e) => e.name === 'match').map((e) => pathOf(e.data.url)).sort();
    assert.deepEqual(matched, ['/orphan-1', '/orphan-2', '/search?q=Orphan']);
  });

  it('honors caseSensitive and maxPages options', async () => {
    const created = await post('/searches', { url: site.url, phrase: 'Belgrade terminal', options: { caseSensitive: true, maxPages: 20 } });
    const { id } = await created.json();
    const events = await readEvents(`${api}/searches/${id}/events`);
    const matched = events.filter((e) => e.name === 'match').map((e) => pathOf(e.data.url)).sort();
    assert.deepEqual(matched, ['/about', '/about?utm=1', '/new-page', '/orphan-1', '/orphan-2']);
    const snapshot = await (await fetch(`${api}/searches/${id}`)).json();
    assert.equal(snapshot.input.options.maxPages, 20);
  });

  it('crawls additional start URLs, expanding ranges', async () => {
    const created = await post('/searches', {
      url: `${site.url}/about`,
      phrase: 'belgrade terminal',
      options: { extraStartUrls: `${site.url}/list?p={1-3}\n\n${site.url}/orphan-1\n` },
    });
    assert.equal(created.status, 201);
    const { id } = await created.json();
    const events = await readEvents(`${api}/searches/${id}/events`);
    const matched = events.filter((e) => e.name === 'match').map((e) => pathOf(e.data.url)).sort();
    assert.deepEqual(matched, ['/about', '/about?utm=1', '/blog/post-1', '/list?p=1', '/list?p=2', '/list?p=3', '/new-page', '/orphan-1', '/orphan-2']);
    const snapshot = await (await fetch(`${api}/searches/${id}`)).json();
    assert.deepEqual(snapshot.input.options.extraStartUrls, [`${site.url}/list?p={1-3}`, `${site.url}/orphan-1`]);
  });

  it('reports the site the start URL redirected to', async () => {
    const created = await post('/searches', { url: `${site.url}/go-elsewhere`, phrase: 'belgrade' });
    const { id } = await created.json();
    const events = await readEvents(`${api}/searches/${id}/events`);
    assert.equal(events.at(-1).data.resolvedUrl, `${site.altUrl}/about`);
  });

  it('can be stopped while running', async () => {
    const created = await post('/searches', { url: `${site.url}/gen/1`, phrase: 'belgrade', options: { maxPages: 100 } });
    const { id } = await created.json();

    const events = await readEvents(`${api}/searches/${id}/events`, async (event) => {
      if (event.name === 'match') await post(`/searches/${id}/stop`, {});
    });

    assert.equal(events.at(-1).data.status, 'stopped');
    const snapshot = await (await fetch(`${api}/searches/${id}`)).json();
    assert.equal(snapshot.status, 'stopped');
    assert.ok(snapshot.progress.scanned < 100);
  });

  it('fails when the start page cannot be loaded', async () => {
    const created = await post('/searches', { url: `${site.url}/missing`, phrase: 'belgrade' });
    const { id } = await created.json();
    const events = await readEvents(`${api}/searches/${id}/events`);
    const done = events.at(-1).data;
    assert.equal(done.status, 'failed');
    assert.match(done.error, /Could not load the start page: HTTP 404/);
  });

  it('sends only a snapshot for a search that already finished', async () => {
    const created = await post('/searches', { url: `${site.url}/about`, phrase: 'belgrade' });
    const { id } = await created.json();
    await readEvents(`${api}/searches/${id}/events`);
    const again = await readEvents(`${api}/searches/${id}/events`);
    assert.deepEqual(again.map((e) => e.name), ['snapshot']);
    assert.equal(again[0].data.status, 'completed');
  });

  it('refuses JavaScript rendering with a clear message when Chromium is missing', async () => {
    const response = await post('/searches', { url: site.url, phrase: 'x', options: { renderJavaScript: true } });
    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.equal(error.code, 'BROWSER_UNAVAILABLE');
    assert.match(error.message, /Chromium could not be started/);
  });

  it('validates input', async () => {
    const cases = [
      [{ phrase: 'x' }, 'url'],
      [{ url: 'http://[bad', phrase: 'x' }, 'url'],
      [{ url: 'ftp://x.com', phrase: 'x' }, 'url'],
      [{ url: 'x.com', phrase: '   ' }, 'phrase'],
      [{ url: 'x.com', phrase: 'x'.repeat(201) }, 'phrase'],
      [{ url: 'x.com', phrase: 'x', options: { maxPages: 0 } }, 'options.maxPages'],
      [{ url: 'x.com', phrase: 'x', options: { maxPages: 101 } }, 'options.maxPages'],
      [{ url: 'x.com', phrase: 'x', options: { caseSensitive: 'yes' } }, 'options.caseSensitive'],
      [{ url: 'x.com', phrase: 'x', options: { ignoreAccents: 0 } }, 'options.ignoreAccents'],
      [{ url: 'x.com', phrase: 'x', options: { contentOnly: 'no' } }, 'options.contentOnly'],
      [{ url: 'x.com', phrase: 'x', options: { useSiteSearch: 'yes' } }, 'options.useSiteSearch'],
      [{ url: 'x.com', phrase: 'x', options: { includeSubdomains: 1 } }, 'options.includeSubdomains'],
      [{ url: 'x.com', phrase: 'x', options: { renderJavaScript: 'true' } }, 'options.renderJavaScript'],
      [{ url: 'x.com', phrase: 'x', options: { extraStartUrls: 'https://other.com/list' } }, 'options.extraStartUrls'],
      [{ url: 'x.com', phrase: 'x', options: { extraStartUrls: 'https://x.com/list?p={1-500}' } }, 'options.extraStartUrls'],
      [{ url: 'x.com', phrase: 'x', options: { extraStartUrls: 'mailto:a@x.com' } }, 'options.extraStartUrls'],
      [{ url: 'x.com', phrase: 'x', options: { extraStartUrls: 42 } }, 'options.extraStartUrls'],
    ];
    for (const [body, field] of cases) {
      const response = await post('/searches', body);
      assert.equal(response.status, 400, JSON.stringify(body));
      const { error } = await response.json();
      assert.equal(error.code, 'INVALID_INPUT');
      assert.equal(error.field, field, JSON.stringify(body));
    }

    const malformed = await fetch(`${api}/searches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
  });

  it('cleans up valid input: adds https://, trims, keeps only known options', () => {
    assert.equal(validateSearchRequest({ url: 'localhost:8080/x', phrase: 'a' }, limits).value.url, 'https://localhost:8080/x');
    const { value, error } = validateSearchRequest(
      {
        url: '  example.com/path ',
        phrase: '  pos terminal ',
        options: { maxPages: 10, other: 1, includeSubdomains: true, extraStartUrls: ['shop.example.com/list?p={1-2}', ' '] },
      },
      limits,
    );
    assert.equal(error, undefined);
    assert.deepEqual(value, {
      url: 'https://example.com/path',
      phrase: 'pos terminal',
      options: { maxPages: 10, includeSubdomains: true, extraStartUrls: ['https://shop.example.com/list?p={1-2}'] },
    });
  });

  it('returns 404 for unknown searches and routes', async () => {
    assert.equal((await fetch(`${api}/searches/nope`)).status, 404);
    assert.equal((await fetch(`${api}/searches/nope/events`)).status, 404);
    assert.equal((await post('/searches/nope/stop', {})).status, 404);
    assert.equal((await fetch(`${api}/what`)).status, 404);
  });
});

const pathOf = (url) => new URL(url).pathname + new URL(url).search;
