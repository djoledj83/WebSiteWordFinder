import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createScope, isCrawlable, isInScope, looksLikePage, normalizeUrl } from '../src/crawler/urlPolicy.js';

describe('normalizeUrl', () => {
  it('resolves relative links against the page URL', () => {
    assert.equal(normalizeUrl('../about', 'https://example.com/blog/post/'), 'https://example.com/blog/about');
    assert.equal(normalizeUrl('/contact', 'https://example.com/blog/'), 'https://example.com/contact');
    assert.equal(normalizeUrl('?page=2', 'https://example.com/list'), 'https://example.com/list?page=2');
  });

  it('drops fragments and credentials, lowercases the host, removes default ports', () => {
    assert.equal(normalizeUrl('HTTPS://User:Pw@Example.COM:443/Path#section'), 'https://example.com/Path');
    assert.equal(normalizeUrl('http://example.com:8080/a'), 'http://example.com:8080/a');
  });

  it('rejects anything that is not http(s)', () => {
    for (const href of ['mailto:a@b.c', 'tel:+381', 'javascript:void(0)', 'ftp://x/y', 'data:text/plain,hi']) {
      assert.equal(normalizeUrl(href, 'https://example.com/'), null, href);
    }
    assert.equal(normalizeUrl('not a url'), null);
    // an empty href is the page itself, as in a browser
    assert.equal(normalizeUrl('', 'https://example.com/page'), 'https://example.com/page');
  });

  it('keeps the path as given (no trailing-slash guessing)', () => {
    assert.equal(normalizeUrl('https://example.com/docs/'), 'https://example.com/docs/');
    assert.equal(normalizeUrl('https://example.com/docs'), 'https://example.com/docs');
  });
});

describe('scope', () => {
  const scope = createScope('https://www.example.com/start');

  it('treats www and non-www as the same site', () => {
    assert.ok(isInScope('https://example.com/other', scope));
    assert.ok(isInScope('http://www.example.com/other', scope));
  });

  it('excludes other hosts and subdomains', () => {
    assert.equal(isInScope('https://blog.example.com/', scope), false);
    assert.equal(isInScope('https://example.org/', scope), false);
    assert.equal(isInScope('https://notexample.com/', scope), false);
  });

  it('includes subdomains when asked, but never look-alike hosts', () => {
    const wide = createScope('https://www.example.com/', { includeSubdomains: true });
    assert.ok(isInScope('https://blog.example.com/post', wide));
    assert.ok(isInScope('https://a.b.example.com/', wide));
    assert.ok(isInScope('https://example.com/', wide));
    assert.equal(isInScope('https://notexample.com/', wide), false);
    assert.equal(isInScope('https://example.com.evil.net/', wide), false);
  });
});

describe('looksLikePage', () => {
  it('skips obvious non-page files by extension', () => {
    for (const url of ['https://x.com/a.pdf', 'https://x.com/img/logo.PNG', 'https://x.com/app.js?v=2', 'https://x.com/data.json']) {
      assert.equal(looksLikePage(url), false, url);
    }
  });

  it('keeps pages, including dynamic ones and paths with dots in folders', () => {
    for (const url of ['https://x.com/', 'https://x.com/about', 'https://x.com/index.php?id=3', 'https://x.com/v1.2/docs', 'https://x.com/page.html']) {
      assert.ok(looksLikePage(url), url);
    }
  });
});

describe('isCrawlable', () => {
  it('combines scope and page checks', () => {
    const scope = createScope('https://example.com/');
    assert.ok(isCrawlable('https://example.com/a', scope));
    assert.equal(isCrawlable('https://example.com/a.zip', scope), false);
    assert.equal(isCrawlable('https://other.com/a', scope), false);
  });
});
