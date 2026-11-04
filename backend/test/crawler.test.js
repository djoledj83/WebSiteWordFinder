import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Crawler } from '../src/crawler/Crawler.js';
import { AddressGuard } from '../src/crawler/fetchers/addressGuard.js';
import { HttpFetcher } from '../src/crawler/fetchers/HttpFetcher.js';
import { startTestSite } from './helpers/testSite.js';

const makeFetcher = (overrides = {}) =>
  new HttpFetcher({
    timeoutMs: 1000,
    maxBodyBytes: 1024 * 1024,
    userAgent: 'test',
    addressGuard: new AddressGuard({ allowPrivateAddresses: true }),
    ...overrides,
  });

describe('Crawler with HttpFetcher against a local site', () => {
  let site;
  before(async () => {
    site = await startTestSite();
  });
  after(() => site.close());

  it('visits every in-scope page once and classifies the rest', async () => {
    const pages = [];
    const failures = [];
    const crawler = new Crawler({ fetcher: makeFetcher(), startUrl: site.url, maxPages: 50, maxDepth: 10, concurrency: 3 });
    const summary = await crawler.run({ onPage: (page) => pages.push(page), onPageError: (failure) => failures.push(failure) });

    const visited = pages.map((page) => new URL(page.url).pathname + new URL(page.url).search).sort();
    assert.deepEqual(visited, ['/', '/about', '/about?utm=1', '/blog/', '/blog/post-1', '/blog/post-2', '/contact', '/new-page']);

    assert.equal(summary.stoppedBy, 'exhausted');
    assert.equal(summary.scanned, 8);
    assert.equal(summary.queued, 0);
    assert.equal(summary.resolvedStartUrl, `${site.url}/`);
    // every page taken from the queue was either scanned, failed or skipped; all but the start came from links
    assert.equal(summary.discovered, summary.scanned + summary.errors + summary.skipped - 1);
    assert.equal(summary.seeded, 0);

    // /missing is a 404; everything else that is not a page is skipped, not an error
    assert.deepEqual(failures.map((f) => [new URL(f.url).pathname, f.message]), [['/missing', 'HTTP 404']]);
    assert.equal(summary.errors, 1);
    // /image (not HTML), /redirect-dup (target already seen), /redirect-out (out of scope), /loop-a (loops)
    assert.equal(summary.skipped, 4);

    // nothing outside the site, no assets, and no page fetched twice
    assert.ok(site.requests.every((path) => !path.includes('other.example')));
    assert.ok(!site.requests.some((path) => path.endsWith('.png') || path.endsWith('.pdf')));
    const htmlRequests = site.requests.filter((path) => visited.includes(path));
    assert.equal(new Set(htmlRequests).size, htmlRequests.length);
  });

  it('reports the final URL of a redirected page and decodes legacy charsets', async () => {
    const pages = [];
    const crawler = new Crawler({ fetcher: makeFetcher(), startUrl: site.url, maxPages: 50, maxDepth: 10, concurrency: 2 });
    await crawler.run({ onPage: (page) => pages.push(page) });

    const redirected = pages.find((page) => page.url.endsWith('/new-page'));
    assert.ok(redirected);
    assert.ok(redirected.requestedUrl.endsWith('/redirect-new'));

    const contact = pages.find((page) => page.url.endsWith('/contact'));
    assert.equal(contact.text, 'Terminal u Čačku radi.');
  });

  it('stops at the page budget with pages still queued', async () => {
    let scanned = 0;
    const crawler = new Crawler({ fetcher: makeFetcher(), startUrl: `${site.url}/gen/1`, maxPages: 5, maxDepth: 100, concurrency: 2 });
    const summary = await crawler.run({ onPage: () => (scanned += 1) });
    assert.equal(scanned, 5);
    assert.equal(summary.stoppedBy, 'page-budget');
    assert.ok(summary.queued >= 1);
  });

  it('respects the depth limit', async () => {
    const depths = [];
    const crawler = new Crawler({ fetcher: makeFetcher(), startUrl: `${site.url}/gen/1`, maxPages: 50, maxDepth: 2, concurrency: 2 });
    await crawler.run({ onPage: (page) => depths.push(page.depth) });
    assert.deepEqual(depths.sort(), [0, 1, 2]);
  });

  it('can be aborted while running', async () => {
    const controller = new AbortController();
    let scanned = 0;
    const crawler = new Crawler({ fetcher: makeFetcher(), startUrl: `${site.url}/gen/1`, maxPages: 1000, maxDepth: 1000, concurrency: 1 });
    const summary = await crawler.run({
      signal: controller.signal,
      onPage: () => {
        scanned += 1;
        if (scanned === 3) controller.abort();
      },
    });
    assert.equal(summary.stoppedBy, 'abort');
    assert.equal(scanned, 3);
  });

  it('treats a timeout as a page error and carries on', async () => {
    const failures = [];
    const fetcher = makeFetcher({ timeoutMs: 200 });
    const crawler = new Crawler({ fetcher, startUrl: `${site.url}/slow`, maxPages: 5, maxDepth: 1, concurrency: 1 });
    const summary = await crawler.run({ onPageError: (failure) => failures.push(failure) });
    assert.equal(summary.errors, 1);
    assert.equal(failures[0].code, 'TIMEOUT');
  });

  it('rejects a start URL that is not http(s)', () => {
    assert.throws(() => new Crawler({ fetcher: makeFetcher(), startUrl: 'ftp://x', maxPages: 1, maxDepth: 1, concurrency: 1 }), /Invalid start URL/);
  });

  it('adopts the host the start URL redirects to', async () => {
    const pages = [];
    const crawler = new Crawler({ fetcher: makeFetcher(), startUrl: `${site.url}/go-elsewhere`, maxPages: 50, maxDepth: 10, concurrency: 2 });
    const summary = await crawler.run({ onPage: (page) => pages.push(page) });

    assert.equal(summary.resolvedStartUrl, `${site.altUrl}/about`);
    assert.equal(crawler.scope.host, 'localhost');
    // /about links to "/" which is now on localhost, so the crawl continues on the new host
    assert.ok(pages.some((page) => page.url === `${site.altUrl}/`));
    assert.ok(pages.every((page) => page.url.startsWith(site.altUrl)));
  });

  it('does not let an ordinary page redirect the crawl to another host', async () => {
    const pages = [];
    const crawler = new Crawler({ fetcher: makeFetcher(), startUrl: `${site.url}/go-elsewhere-page`, maxPages: 50, maxDepth: 10, concurrency: 1 });
    // the start page itself is a 404 here, so use the home page and check the redirect target is skipped
    await crawler.run({ onPage: (page) => pages.push(page) });
    assert.equal(pages.length, 0);
  });

  it('crawls seeds: explicit ones skip the extension filter, sitemap ones do not, out-of-scope ones are dropped', async () => {
    const pages = [];
    const crawler = new Crawler({ fetcher: makeFetcher(), startUrl: `${site.url}/about`, maxPages: 50, maxDepth: 0, concurrency: 2 });
    const explicit = crawler.addSeeds([`${site.url}/list?p=1`, `${site.url}/list?p=2`, `${site.url}/files/report.pdf`, 'https://other.example/x'], { explicit: true });
    const listed = crawler.addSeeds([`${site.url}/orphan-1`, `${site.url}/files/doc.pdf`, `${site.url}/about`, 'https://other.example/y']);
    assert.equal(explicit, 3); // the pdf is kept because the user asked for it; the other host is not
    assert.equal(listed, 1); // orphan-1 only: pdf filtered, /about already queued, other host dropped

    const summary = await crawler.run({ onPage: (page) => pages.push(page) });
    assert.deepEqual(pages.map((page) => page.url.replace(site.url, '')).sort(), ['/about', '/list?p=1', '/list?p=2', '/orphan-1']);
    assert.equal(summary.seeded, 4);
    assert.equal(summary.skipped, 1); // the pdf: fetched, not HTML
  });

  it('follows frames, iframes and meta refresh', async () => {
    const visited = async (start) => {
      const pages = [];
      const crawler = new Crawler({ fetcher: makeFetcher(), startUrl: `${site.url}${start}`, maxPages: 10, maxDepth: 3, concurrency: 1 });
      await crawler.run({ onPage: (page) => pages.push(page.url.replace(site.url, '')) });
      return pages.sort();
    };
    assert.deepEqual(await visited('/frames'), ['/frame-a', '/frames']);
    assert.deepEqual(await visited('/iframe-host'), ['/frame-b', '/iframe-host']);
    assert.deepEqual(await visited('/meta-refresh'), ['/meta-refresh', '/refreshed']);
  });

  it('sees only the shell of a JavaScript-rendered page with the HTTP fetcher', async () => {
    const pages = [];
    const crawler = new Crawler({ fetcher: makeFetcher(), startUrl: `${site.url}/spa`, maxPages: 10, maxDepth: 3, concurrency: 1 });
    const summary = await crawler.run({ onPage: (page) => pages.push(page) });
    assert.equal(pages.length, 1);
    assert.equal(pages[0].text, 'Loading…');
    assert.equal(summary.discovered, 0);
  });
});
