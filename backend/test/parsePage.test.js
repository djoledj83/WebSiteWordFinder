import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePage } from '../src/crawler/parsePage.js';

describe('parsePage', () => {
  it('extracts the title, visible text and links', () => {
    const html = `
      <html><head><title> My  Site </title><style>.x{color:red}</style></head>
      <body>
        <nav><a href="/about">About</a> <a href="contact.html">Contact</a></nav>
        <h1>Welcome</h1>
        <p>Payment <b>ter</b>minals in <span>Belgrade</span>.</p>
        <script>var secret = "Belgrade terminal";</script>
        <noscript>Enable JavaScript</noscript>
      </body></html>`;
    const page = parsePage(html, 'https://example.com/blog/index.html');

    assert.equal(page.title, 'My Site');
    // the <nav> is page furniture: its links are collected, its text is not searched
    assert.equal(page.text, 'Welcome\nPayment terminals in Belgrade.');
    assert.deepEqual(page.links, ['https://example.com/about', 'https://example.com/blog/contact.html']);

    const everything = parsePage(html, 'https://example.com/blog/index.html', { contentOnly: false });
    assert.equal(everything.text, 'About Contact\nWelcome\nPayment terminals in Belgrade.');
  });

  it('leaves out menus, sidebars, footers and navigation trees but keeps content headers', () => {
    const html = `
      <body>
        <header class="site"><a href="/">Site name</a> <a href="/login">Login</a></header>
        <div role="navigation">Products Contact</div>
        <ul role="tree"><li role="treeitem">Sibling record</li></ul>
        <main>
          <article>
            <header><h1>Article title</h1></header>
            <p>Body text.</p>
            <aside>Related links</aside>
            <footer>Posted yesterday</footer>
          </article>
        </main>
        <footer class="site">© 2026 Company, Belgrade</footer>
      </body>`;
    const page = parsePage(html, 'https://x.com/');
    assert.equal(page.text, 'Article title\nBody text.\nPosted yesterday');
    assert.deepEqual(page.links, ['https://x.com/', 'https://x.com/login']);
  });

  it('falls back to the whole text when nothing but furniture is left', () => {
    const page = parsePage('<nav><p>Only a menu: Belgrade</p></nav>', 'https://x.com/');
    assert.equal(page.text, 'Only a menu: Belgrade');
  });

  it('separates block elements with a line break and keeps inline text joined', () => {
    const page = parsePage('<h1>Belgrade</h1><p>terminal</p><p><em>Pay</em>ten</p>', 'https://x.com/');
    assert.equal(page.text, 'Belgrade\nterminal\nPayten');
  });

  it('turns source line breaks and non-breaking spaces inside a paragraph into single spaces', () => {
    const page = parsePage('<p>Belgrade\n   terminal&nbsp;network</p>', 'https://x.com/');
    assert.equal(page.text, 'Belgrade terminal network');
  });

  it('honors <base href> when resolving links', () => {
    const page = parsePage('<head><base href="https://x.com/docs/"></head><body><a href="intro">Intro</a></body>', 'https://x.com/other/');
    assert.deepEqual(page.links, ['https://x.com/docs/intro']);
  });

  it('keeps non-http links for the policy layer to reject and ignores unparsable ones', () => {
    const page = parsePage('<a href="mailto:a@b.c">m</a><a href="http://[bad">b</a><a href="">e</a>', 'https://x.com/');
    assert.deepEqual(page.links, ['mailto:a@b.c']);
  });

  it('also follows image maps, iframes and meta refresh', () => {
    const html = `
      <head><meta http-equiv="Refresh" content="5; URL='/landing'"></head>
      <body>
        <map><area href="/map-target"></map>
        <iframe src="/embedded"></iframe>
      </body>`;
    const page = parsePage(html, 'https://x.com/dir/');
    assert.deepEqual(page.links.sort(), ['https://x.com/embedded', 'https://x.com/landing', 'https://x.com/map-target']);
  });

  it('follows the frames of a frameset document', () => {
    const html = `<html><head><title>Frames</title></head><frameset cols="*,*"><frame src="frame.html"><frame src="/other"></frameset></html>`;
    const page = parsePage(html, 'https://x.com/dir/');
    assert.deepEqual(page.links.sort(), ['https://x.com/dir/frame.html', 'https://x.com/other']);
  });

  it('copes with a document that has no body or title', () => {
    const page = parsePage('just text', 'https://x.com/');
    assert.equal(page.title, '');
    assert.equal(page.text, 'just text');
    assert.deepEqual(page.links, []);
  });
});
