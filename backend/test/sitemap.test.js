import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { AddressGuard } from '../src/crawler/fetchers/addressGuard.js';
import { HttpFetcher } from '../src/crawler/fetchers/HttpFetcher.js';
import { discoverSitemapUrls, parseSitemap } from '../src/crawler/sitemap.js';
import { startTestSite } from './helpers/testSite.js';

describe('parseSitemap', () => {
  it('reads url sets and sitemap indexes', () => {
    const index = parseSitemap('<sitemapindex><sitemap><loc>https://x.com/a.xml</loc></sitemap><sitemap><loc>ftp://nope</loc></sitemap></sitemapindex>');
    assert.deepEqual(index, { sitemaps: ['https://x.com/a.xml'], urls: [] });
    const urlset = parseSitemap('<urlset><url><loc> https://x.com/p1 </loc></url><url><loc>https://x.com/p2</loc></url></urlset>');
    assert.deepEqual(urlset, { sitemaps: [], urls: ['https://x.com/p1', 'https://x.com/p2'] });
  });
});

describe('discoverSitemapUrls', () => {
  const fakeFetcher = (files) => async (url) => {
    const file = files[new URL(url).pathname];
    if (!file) return { url, status: 404, contentType: 'text/html', body: null, reason: 'http-status' };
    return { url, status: 200, contentType: file.type ?? 'application/xml', body: Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body), reason: null };
  };

  it('uses the sitemaps named in robots.txt', async () => {
    const fetchResource = fakeFetcher({
      '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nSitemap: https://x.com/custom.xml\n' },
      '/custom.xml': { body: '<urlset><url><loc>https://x.com/a</loc></url></urlset>' },
      '/sitemap.xml': { body: '<urlset><url><loc>https://x.com/not-used</loc></url></urlset>' },
    });
    const { urls, sitemapsRead } = await discoverSitemapUrls({ startUrl: 'https://x.com/start', fetchResource });
    assert.deepEqual(urls, ['https://x.com/a']);
    assert.equal(sitemapsRead, 1);
  });

  it('falls back to /sitemap.xml, following indexes and unpacking gzip', async () => {
    const fetchResource = fakeFetcher({
      '/sitemap.xml': { body: '<sitemapindex><sitemap><loc>https://x.com/part.xml.gz</loc></sitemap></sitemapindex>' },
      '/part.xml.gz': { type: 'application/octet-stream', body: gzipSync('<urlset><url><loc>https://x.com/z</loc></url></urlset>') },
      '/sitemap_index.xml': { body: '<urlset><url><loc>https://x.com/not-tried</loc></url></urlset>' },
    });
    const { urls, sitemapsRead } = await discoverSitemapUrls({ startUrl: 'https://x.com/', fetchResource });
    assert.deepEqual(urls, ['https://x.com/z']);
    assert.equal(sitemapsRead, 2);
  });

  it('tries /sitemap_index.xml when /sitemap.xml is missing', async () => {
    const fetchResource = fakeFetcher({
      '/sitemap_index.xml': { body: '<urlset><url><loc>https://x.com/y</loc></url></urlset>' },
    });
    const { urls, sitemapsRead } = await discoverSitemapUrls({ startUrl: 'https://x.com/', fetchResource });
    assert.deepEqual(urls, ['https://x.com/y']);
    assert.equal(sitemapsRead, 2);
  });

  it('ignores HTML served in place of a sitemap (single-page apps answer every URL with the app)', async () => {
    const shell = '<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>';
    const fetchResource = fakeFetcher({
      '/robots.txt': { type: 'text/html', body: shell },
      '/sitemap.xml': { type: 'text/html', body: shell },
      '/sitemap_index.xml': { type: 'text/html', body: shell },
    });
    const { urls } = await discoverSitemapUrls({ startUrl: 'https://x.com/', fetchResource });
    assert.deepEqual(urls, []);
  });

  it('stops after the configured number of sitemap files and URLs', async () => {
    const files = { '/sitemap.xml': { body: `<sitemapindex>${Array.from({ length: 50 }, (_, i) => `<sitemap><loc>https://x.com/s${i}.xml</loc></sitemap>`).join('')}</sitemapindex>` } };
    for (let i = 0; i < 50; i += 1) files[`/s${i}.xml`] = { body: `<urlset><url><loc>https://x.com/p${i}a</loc></url><url><loc>https://x.com/p${i}b</loc></url></urlset>` };
    const { urls, sitemapsRead } = await discoverSitemapUrls({ startUrl: 'https://x.com/', fetchResource: fakeFetcher(files), maxSitemaps: 4, maxUrls: 5 });
    assert.equal(sitemapsRead, 4);
    assert.equal(urls.length, 5);
  });

  describe('against the test site', () => {
    let site;
    before(async () => {
      site = await startTestSite();
    });
    after(() => site.close());

    it('reads robots.txt, the index, a plain and a gzipped sitemap over HTTP', async () => {
      const fetcher = new HttpFetcher({ timeoutMs: 1000, maxBodyBytes: 1024 * 1024, userAgent: 'test', addressGuard: new AddressGuard({ allowPrivateAddresses: true }) });
      const { urls, sitemapsRead } = await discoverSitemapUrls({ startUrl: `${site.url}/`, fetchResource: (url, options) => fetcher.fetchResource(url, options) });
      assert.equal(sitemapsRead, 3);
      assert.deepEqual(urls.map((u) => new URL(u).pathname).sort(), ['/about', '/files/doc.pdf', '/orphan-1', '/orphan-2', '/x']);
    });
  });
});
