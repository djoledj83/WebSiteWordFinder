import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * A small website served from memory, with the situations a crawler meets:
 * relative links, assets, external links, redirects (good, duplicate,
 * out of scope, looping), a 404, a non-HTML response without an extension,
 * a legacy charset, the phrase hidden in places a visitor never sees,
 * sitemaps (named in robots.txt, an index, a gzipped file), frames, a
 * meta-refresh page and a JavaScript-rendered page.
 *
 * The server listens on every interface, so the same site is reachable as
 * 127.0.0.1 and as localhost (two "hosts" for redirect tests).
 */
const html = (body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>Test site</title>${head}</head><body>${body}</body></html>`;

const pages = {
  '/': html(`
    <nav>
      <a href="/about">About</a>
      <a href="blog/">Blog</a>
      <a href="/contact">Contact</a>
      <a href="/assets/logo.png">Logo</a>
      <a href="/files/report.pdf">Report</a>
      <a href="https://other.example/x">Elsewhere</a>
      <a href="/redirect-dup">Dup redirect</a>
      <a href="/redirect-new">New redirect</a>
      <a href="/redirect-out">Out redirect</a>
      <a href="/loop-a">Loop</a>
      <a href="/missing">Missing</a>
      <a href="/image">Image without extension</a>
      <a href="mailto:someone@example.com">Mail</a>
      <a href="#top">Top</a>
      <a href="/about?utm=1#x">About again</a>
    </nav>
    <p>Welcome to the test site.</p>`),
  '/about': html(`<p>Our <b>Belgrade</b> terminal network is growing.</p><a href="/">Home</a>`),
  '/about?utm=1': html(`<p>Same page, tracked. Belgrade terminal.</p>`),
  '/blog/': html(`<a href="post-1">Post 1</a> <a href="post-2">Post 2</a> <a href="/about#team">Team</a>`),
  '/blog/post-1': html(`<p>In BELGRADE terminal installs doubled.</p><script>var hidden = "Belgrade terminal";</script>`),
  '/blog/post-2': html(`<h1>Belgrade</h1><p>terminal count: 5</p>`),
  '/new-page': html(`<p>Reached through a redirect: Belgrade terminal.</p>`),
  // only listed in sitemaps, no page links here
  '/orphan-1': html(`<p>Orphan one: Belgrade terminal.</p>`),
  '/orphan-2': html(`<p>Orphan two: Belgrade terminal.</p>`),
  // the phrase only in the menu, not in the content
  '/menu-only': html(`<nav><a href="/about">Belgrade terminal news</a></nav><main><p>Nothing to see.</p></main>`),
  // a classic search form (GET) and no links at all
  '/with-search': html(`<form action="/search"><input type="search" name="q" placeholder="Hledat"><button>Hledat</button></form><p>Welcome.</p>`),
  // a web-app search box: no form, the script navigates to a paged results URL on Enter
  '/spa-search': html(
    `<input id="q" type="text" placeholder="Vyhledávání bez filtru"><p>App home.</p>`,
    `<script>window.addEventListener('DOMContentLoaded', function () {
      document.getElementById('q').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') location.href = '/results?q=' + encodeURIComponent(event.target.value) + '&p=1';
      });
    });</script>`,
  ),
  // accented spelling
  '/accents': html(`<p>Doudleby - věže Vítkovice, Čačak, Đurđevac.</p>`),
  // frames and meta refresh
  '/frames': `<!doctype html><html><head><title>Frames</title></head><frameset cols="50%,50%"><frame src="/frame-a"><frame src="https://other.example/frame"></frameset></html>`,
  '/frame-a': html(`<p>Inside frame A: Belgrade terminal.</p>`),
  '/iframe-host': html(`<p>Host page.</p><iframe src="/frame-b"></iframe>`),
  '/frame-b': html(`<p>Inside iframe B: Belgrade terminal.</p>`),
  '/meta-refresh': html(`<p>Redirecting…</p>`, `<meta http-equiv="refresh" content="0; url=/refreshed">`),
  '/refreshed': html(`<p>After meta refresh: Belgrade terminal.</p>`),
  // a single-page app: the HTML is an empty shell, JavaScript builds the content and the links
  '/spa': html(
    `<div id="app">Loading…</div>`,
    `<script>setTimeout(function () { document.getElementById('app').innerHTML = '<p>Rendered by script: Belgrade terminal.</p><a href="/spa-child">child</a>'; }, 150);</script>`,
  ),
  '/spa-child': html(
    `<div id="app"></div>`,
    `<script>window.addEventListener('DOMContentLoaded', function () { document.getElementById('app').innerHTML = '<p>Child rendered: Belgrade terminal.</p>'; });</script>`,
  ),
  // an app whose library arrives slowly from the network (cold-start situation); async, so
  // DOMContentLoaded fires long before the library runs
  '/slow-app': html(`<div id="app">Loading…</div><script async src="/slow-library.js"></script>`),
};

const sitemapIndex = (base) => `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${base}/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>${base}/sitemap-old.xml.gz</loc></sitemap>
</sitemapindex>`;

const sitemapPages = (base) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/orphan-1</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc>${base}/about</loc></url>
  <url><loc>https://other.example/x</loc></url>
  <url><loc>${base}/files/doc.pdf</loc></url>
</urlset>`;

const sitemapOld = (base) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/orphan-2</loc></url></urlset>`;

export async function startTestSite() {
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const base = `http://${req.headers.host}`;
    const url = new URL(req.url, base);
    const key = url.pathname + url.search;
    requests.push(key);

    const redirect = (to) => {
      res.writeHead(302, { location: to });
      res.end();
    };
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };

    switch (key) {
      case '/redirect-dup':
        return redirect('/about');
      case '/redirect-new':
        return redirect('/new-page');
      case '/redirect-out':
        return redirect('https://other.example/landing');
      case '/loop-a':
        return redirect('/loop-b');
      case '/loop-b':
        return redirect('/loop-a');
      case '/go-elsewhere':
        // same server, other hostname: the "site" changes
        return redirect(`http://localhost:${server.address().port}/about`);
      case '/image':
        return send(200, 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case '/files/report.pdf':
      case '/files/doc.pdf':
        return send(200, 'application/pdf', Buffer.from('%PDF-1.4 Belgrade terminal'));
      case '/robots.txt':
        return send(200, 'text/plain', `User-agent: *\nDisallow: /private\nSitemap: ${base}/sitemap-index.xml\n`);
      case '/sitemap-index.xml':
        return send(200, 'application/xml', sitemapIndex(base));
      case '/sitemap-pages.xml':
        return send(200, 'application/xml', sitemapPages(base));
      case '/sitemap-old.xml.gz':
        return send(200, 'application/x-gzip', gzipSync(Buffer.from(sitemapOld(base))));
      case '/contact': {
        // "Terminal u Čačku radi." in windows-1250 (Č = 0xC8, č = 0xE8); charset only in a <meta> tag
        const ascii = (text) => Buffer.from(text, 'latin1');
        const bytes = Buffer.concat([
          ascii('<!doctype html><html><head><meta charset="windows-1250"></head><body><p>Terminal u '),
          Buffer.from([0xc8]), ascii('a'), Buffer.from([0xe8]), ascii('ku radi.</p></body></html>'),
        ]);
        return send(200, 'text/html', bytes);
      }
      case '/slow':
        await sleep(1500);
        return send(200, 'text/html; charset=utf-8', html('<p>slow page</p>'));
      case '/slow-library.js':
        await sleep(1500);
        return send(200, 'application/javascript', `document.getElementById('app').innerHTML = '<p>Rendered after the library arrived: Belgrade terminal.</p>';`);
      default:
        break;
    }

    // /gen/N: an endless chain of pages, each linking to the next (for budget and stop tests)
    const chain = /^\/gen\/(\d+)$/.exec(url.pathname);
    if (chain) {
      const n = Number(chain[1]);
      await sleep(20);
      return send(200, 'text/html; charset=utf-8', html(`<p>Generated page ${n} mentions Belgrade terminal.</p><a href="/gen/${n + 1}">next</a>`));
    }

    // /list?p=N: paged list whose paging is not made of links (like many web apps)
    if (url.pathname === '/list') {
      const p = Number(url.searchParams.get('p') ?? 1);
      return send(200, 'text/html; charset=utf-8', html(`<p>List page ${p}: Belgrade terminal.</p><button>next</button>`));
    }

    // /search?q=...: the site's own search, listing the pages that mention the query
    const hitsFor = (q) => Object.entries(pages).filter(([, body]) => body.toLowerCase().includes(q.toLowerCase())).map(([path]) => path);
    if (url.pathname === '/search') {
      const q = url.searchParams.get('q') ?? '';
      return send(200, 'text/html; charset=utf-8', html(`<p>Results for ${q}</p>${hitsFor(q).map((h) => `<a href="${h}">${h}</a>`).join(' ')}`));
    }

    // /results?q=...&p=N: the same, two hits per page, paged by a number in the URL
    if (url.pathname === '/results') {
      const q = url.searchParams.get('q') ?? '';
      const p = Number(url.searchParams.get('p') ?? 1);
      const pageHits = hitsFor(q).slice((p - 1) * 2, p * 2);
      const body = pageHits.length ? pageHits.map((h) => `<a href="${h}">${h}</a>`).join(' ') : '<p>No more results.</p>';
      return send(200, 'text/html; charset=utf-8', html(`<p>Results page ${p} for ${q}</p>${body}<button>next</button>`));
    }

    if (pages[key]) return send(200, 'text/html; charset=utf-8', pages[key]);

    return send(404, 'text/html', html('<p>Not found</p>'));
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    altUrl: `http://localhost:${port}`,
    port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
