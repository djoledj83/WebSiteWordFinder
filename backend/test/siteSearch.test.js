import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findSearchFormUrl, looksLikeSearchInput, nextPageUrl } from '../src/crawler/siteSearch.js';

describe('looksLikeSearchInput', () => {
  it('recognises search boxes by type, role, name, placeholder or label, in several languages', () => {
    assert.ok(looksLikeSearchInput({ type: 'search' }));
    assert.ok(looksLikeSearchInput({ type: 'text', role: 'searchbox' }));
    assert.ok(looksLikeSearchInput({ type: 'text', name: 'q', placeholder: 'Vyhledávání bez filtru' }));
    assert.ok(looksLikeSearchInput({ type: 'text', name: 'query' }));
    assert.ok(looksLikeSearchInput({ type: 'text', ariaLabel: 'Pretraga' }));
    assert.ok(looksLikeSearchInput({ type: 'text', className: 'form-control search-field' }));
  });

  it('ignores inputs that cannot be search boxes', () => {
    assert.equal(looksLikeSearchInput({ type: 'text', name: 'email' }), false);
    assert.equal(looksLikeSearchInput({ type: 'password', name: 'search' }), false);
    assert.equal(looksLikeSearchInput({ type: 'hidden', name: 'q' }), false);
  });
});

describe('findSearchFormUrl', () => {
  it('builds the URL a GET search form would open, keeping hidden fields', () => {
    const html = `
      <form action="/login" method="post"><input name="user"><input type="password" name="pass"></form>
      <form action="/hledat"><input type="hidden" name="lang" value="cs"><input type="text" name="q" placeholder="Hledat"><button>OK</button></form>`;
    assert.equal(findSearchFormUrl(html, 'https://x.com/home', 'věže Vítkovice'), 'https://x.com/hledat?lang=cs&q=v%C4%9B%C5%BEe+V%C3%ADtkovice');
  });

  it('uses the page itself when the form has no action, and returns null without a search form', () => {
    assert.equal(findSearchFormUrl('<form><input type="search" name="s"></form>', 'https://x.com/?a=1', 'pos'), 'https://x.com/?a=1&s=pos');
    assert.equal(findSearchFormUrl('<form method="post"><input type="search" name="s"></form>', 'https://x.com/', 'pos'), null);
    assert.equal(findSearchFormUrl('<p>no forms</p>', 'https://x.com/', 'pos'), null);
  });
});

describe('nextPageUrl', () => {
  it('increments a page-number parameter and leaves everything else alone', () => {
    assert.equal(nextPageUrl('https://x.com/apu?p=1&s=100&q=V%C3%ADtkovice'), 'https://x.com/apu?p=2&s=100&q=V%C3%ADtkovice');
    assert.equal(nextPageUrl('https://x.com/list?page=9'), 'https://x.com/list?page=10');
    assert.equal(nextPageUrl('https://x.com/list?Strana=3'), 'https://x.com/list?Strana=4');
  });

  it('returns null for URLs without a page number', () => {
    assert.equal(nextPageUrl('https://x.com/list?q=abc'), null);
    assert.equal(nextPageUrl('https://x.com/list?page=last'), null);
    assert.equal(nextPageUrl('not a url'), null);
  });
});
