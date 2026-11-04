# WebSiteWordFinder

Type a website and a word or phrase; the app crawls the site page by page and lists every URL where the phrase appears, live while the crawl runs.

- **Backend:** Node.js 22+ (ESM), Express 5, cheerio; optional Playwright for JavaScript-rendered sites. No database in v1.
- **Frontend:** React 19 with Vite, plain JavaScript (JSX).

## Requirements

Node.js 22 or newer (`node --version`). Chromium is needed only for the optional "Render JavaScript" mode (see below). For a server, Docker alone is enough — see "Run it in Docker".

## Run it in development

Two terminals, from this folder:

```bash
# terminal 1 – API on http://localhost:4000
cd backend
npm install
npm run dev

# terminal 2 – UI on http://localhost:5173 (proxies /api to the backend)
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The root `package.json` has shortcuts for the same commands (`npm run install:all`, `npm run dev:backend`, `npm run dev:frontend`).

Ports are set in `.env` files: `backend/.env` (`PORT`, default 4000) and `frontend/.env` (`PORT` of the dev server, default 5173, and `BACKEND_URL`, which must point at the backend's port). Copy the `.env.example` next to each and edit; without them the defaults apply.

## Run it as one process (production)

```bash
cd frontend && npm run build      # writes frontend/dist
cd ../backend && npm start        # serves the API and the built UI on http://localhost:4000
```

## Run it in Docker (server)

The repository contains a `Dockerfile` and a `docker-compose.yml`. The image builds the frontend, installs the backend and includes Chromium, so the server needs nothing but Docker.

```bash
# on the server, inside the project folder
docker compose up -d --build       # build the image and start it in the background
docker compose logs -f             # watch it start; stop watching with Ctrl+C
```

The app is then on `http://<server>:4000`. Useful commands:

```bash
docker compose ps                  # is it running, is it healthy
docker compose restart
docker compose down                # stop and remove the container (the image stays)
docker compose up -d --build       # after changing the code: rebuild and replace
```

Settings come from a `.env` file next to `docker-compose.yml` (copy `.env.example`): `HOST_PORT` is the port on the server, `PORT` the one inside the container, and every crawl option from `backend/.env.example` can be added there too. Without a `.env` the defaults apply (port 4000).

What the setup does and why:

- The runtime image is `mcr.microsoft.com/playwright:v1.63.0-noble` — Node.js plus Chromium and its system libraries. Its version tag must match the `playwright` version in `backend/package-lock.json`; bump both together.
- The process runs as the unprivileged `pwuser`. `init: true` reaps Chromium's helper processes; `shm_size: 1gb` and the `--disable-dev-shm-usage` flag keep Chromium from running out of shared memory; the memory limit (2 GB) fits three parallel rendered pages — raise it together with `BROWSER_CONCURRENCY`.
- A health check calls `/api/config` every 30 seconds, so `docker compose ps` shows `healthy`.
- Searches are kept in memory only; a restart forgets running searches, nothing else is stored.

Putting it behind a reverse proxy (nginx) works, with two things to keep in mind: the live updates are a long-lived response (server-sent events), so buffering must be off and the read timeout long; and the app has no login of its own, so restrict who can reach it (VPN, IP allow-list, or basic auth on the proxy).

```nginx
location / {
    proxy_pass         http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_buffering    off;      # server-sent events
    proxy_read_timeout 1h;       # a long crawl keeps the stream open
}
```

If the server itself sits behind a corporate proxy, add `NODE_USE_ENV_PROXY: "1"` and `HTTPS_PROXY: "http://proxy:port"` to the environment (plain-HTTP fetches); Chromium reads the same `HTTPS_PROXY` variable.

## JavaScript rendering (sites built as web apps)

Many modern sites send an almost empty HTML page and build their content and menus with JavaScript (React, Angular, Vue...). A plain HTTP fetch sees nothing there. With "Render JavaScript" turned on in the form, every page is loaded in a headless Chromium instead, so the crawler sees what a visitor sees. It is several times slower per page.

One-time setup in the backend folder:

```bash
npm install                        # installs the playwright package (listed as an optional dependency)
npx playwright install chromium    # downloads Chromium (~150 MB)
```

The UI's "Render JavaScript" checkbox is enabled when the server finds Playwright; if Chromium is missing, starting such a search returns a clear message with the command to run.

## How the crawler reaches "all content"

1. **Links.** From the start page it follows every link (`<a>`, image maps, frames, iframes, meta-refresh) that stays on the same website, breadth-first, up to the page limit and depth limit.
2. **Sitemaps.** Before crawling it reads `robots.txt` for `Sitemap:` lines, then `/sitemap.xml` and `/sitemap_index.xml`, follows sitemap indexes and unpacks `.gz` sitemaps. Every listed page on the site joins the queue, so coverage does not depend on the menus.
3. **Redirected start URL.** If the start URL redirects to another host (example.rs → example.com, http → https on www), the crawl adopts that host as the website.
4. **Subdomains** (option). `shop.example.com`, `en.example.com` and so on count as the same website.
5. **The site's own search box** (option, on by default). The crawler looks for a search box on the start page — a GET form in plain HTML, or any visible input that looks like one (`type="search"`, or a name/placeholder/label such as *search*, *hledat*, *pretraga*, *suche*) when rendering JavaScript — types the phrase into it and presses Enter. The page it lands on is used as a seed, and when its URL carries a page number (`?p=1`, `?page=2`, …) the following pages are fetched as well until a page shows nothing new. That is how records in archives, catalogs and other web apps are reached, where nothing links to them. The hit list itself is crawled for links but not reported as a match.
6. **Additional start URLs** (option). For pages no link leads to, typically paged lists in web apps whose paging is made of buttons. One URL per line; `{1-100}` expands to a numeric range (`{01-12}` keeps the zero padding) and `{phrase}` is replaced by the URL-encoded search phrase, which lets a specific results page seed the crawl:

   ```
   https://example.com/catalog?page={1-100}
   https://example.com/archive/{2015-2026}
   https://example.com/search?q={phrase}&page={1-5}
   ```

7. **JavaScript rendering** (option), described above.

When only the start page could be scanned, the result panel says so and names the likely reason; when the crawl ran out of links it says that too, and whether the site's search could be used. The form remembers the last values you submitted (in your browser only).

### Example: an archive portal built as a web app

Sites like ARON (`aron.vychodoceskearchivy.cz`) render everything with JavaScript, keep their records behind trees and button-paged lists, and have no sitemap — a link crawl reaches only a few hundred pages. With "Render JavaScript" on, the crawler finds the portal's search box, searches the phrase there, pages through the hit list and verifies every record page it links to. Nothing else needs to be configured; if you prefer to control it, the same can be done by hand with an additional start URL such as `https://aron.vychodoceskearchivy.cz/apu?q={phrase}&s=100&p={1-10}`.

## How matching works

- Case-insensitive unless "Match case exactly" is on.
- Accent-insensitive unless "Ignore accents" is turned off: `Vitkovice` finds `Vítkovice`, `Cacak` finds `Čačak`, `Durdevac` finds `Đurđevac`, `strasse` finds `straße`. The highlighted snippet always shows the page's own spelling.
- Whitespace in the phrase is normalized, and a phrase never matches across two blocks (a heading and the paragraph after it).
- With "Search page content only" (on by default) menus, sidebars, footers and navigation trees are left out of the searched text, so a word that sits in the menu of every page does not turn every page into a match. Their links are still followed. The page title is always searched.

## Configuration

Three optional `.env` files, each with an `.env.example` next to it: `backend/.env` (port and crawl settings when running with Node), `frontend/.env` (dev-server port and backend address), and `.env` in the project root (Docker: server port and the same crawl settings). Every value has a default.

Backend settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 4000 | HTTP port of the API (and of the UI in production) |
| `MAX_PAGES` | 200 | Default page budget of a search |
| `MAX_PAGES_LIMIT` | 20000 | Highest page budget a user may request from the form |
| `MAX_DEPTH` | 10 | Link hops to follow from the start URL |
| `MAX_EXTRA_START_URLS` | 5000 | How many URLs the "additional start URLs" option may expand to |
| `CONCURRENCY` | 5 | Pages fetched in parallel (plain HTTP) |
| `TIMEOUT_MS` | 10000 | Per-request timeout (plain HTTP) |
| `MAX_BODY_BYTES` | 5242880 | Pages larger than this are skipped |
| `USER_AGENT` | Mozilla/5.0 (compatible; WebSiteWordFinder/1.0) | Sent with every request |
| `BROWSER_CONCURRENCY` | 3 | Pages rendered at the same time (JavaScript rendering) |
| `BROWSER_TIMEOUT_MS` | 20000 | Time allowed for a page to load (JavaScript rendering) |
| `BROWSER_SETTLE_MS` | 2500 | Time allowed for the page's own API calls and rendering after it loaded |
| `ALLOW_PRIVATE_ADDRESSES` | false | Allow crawling localhost / intranet addresses (see Security) |
| `JOB_TTL_MS` | 1800000 | Finished searches are forgotten after this long (30 min) |

## Tests

```bash
cd backend && npm test
```

Unit tests cover the URL rules, page parsing, phrase matching (case, accents, snippets), range expansion, sitemap parsing and the address guard; integration tests crawl a small local site (redirects, a 404, non-HTML responses, a legacy charset, sitemaps, frames, meta refresh, a JavaScript-rendered page) through the crawler and through the HTTP API, including the live event stream and Stop. The Playwright tests are skipped automatically when Chromium is not installed.

## How it works

1. `POST /api/searches` validates the URL, phrase and options, creates a search job and starts the crawl in the background (sitemaps first, then pages).
2. The UI opens `GET /api/searches/:id/events`, a server-sent events stream, and receives `snapshot`, `progress`, `match`, `page-error` and `done` events. `POST /api/searches/:id/stop` cancels; `GET /api/searches/:id` returns the full state; `GET /api/config` tells the UI the limits and whether JavaScript rendering is available.
3. The crawler walks the site breadth-first with a small worker pool, staying on the website (`www.` and non-`www.` count as the same site), skipping obvious non-page links (images, PDFs, archives, scripts) and non-HTML responses, and following redirects only while they stay in scope.
4. Each page's visible text is extracted (scripts, styles, hidden templates and page furniture removed, block elements kept apart) and searched for the phrase, ignoring case and accents by default. Matching pages are reported with the number of occurrences and highlighted snippets.

### Code layout

```
Dockerfile, docker-compose.yml, .env.example   one image: frontend build + backend + Chromium
backend/src/
  server.js                      composition root: wires config, fetchers, service, app
  app.js                         Express app (API + static frontend in production)
  config.js                      environment -> validated config
  api/routes.js, api/sse.js      HTTP endpoints, request validation and the SSE writer
  search/SearchService.js        use cases: create / get / stop a search; seeds sitemaps and extra URLs
  search/SearchJob.js            state and live events of one search
  search/searchRepository.js     in-memory store (replace this file for a database)
  crawler/Crawler.js             breadth-first crawl with a worker pool
  crawler/urlPolicy.js           URL normalization, scope (subdomains), skip rules
  crawler/parsePage.js           links + visible text from HTML (page furniture left out)
  lib/text.js                    whitespace and accent folding helpers
  crawler/sitemap.js             robots.txt / sitemap discovery
  crawler/siteSearch.js          search-box detection, GET form URLs, paged-URL stepping
  crawler/seedUrls.js            {1-100} range expansion for additional start URLs
  crawler/fetchers/PageFetcher.js   the fetcher contract shared by both fetchers
  crawler/fetchers/HttpFetcher.js   plain HTTP fetcher
  crawler/fetchers/BrowserFetcher.js headless Chromium fetcher (Playwright)
  crawler/fetchers/addressGuard.js  refuses private / loopback addresses
  matching/phraseMatcher.js      pure phrase search with snippets
frontend/src/
  App.jsx                        one screen: form, progress, results
  api/searchApi.js               the only module that talks to the backend
  hooks/useSearchJob.js          lifecycle of a search on the client
  hooks/useServerConfig.js       limits and capabilities from GET /api/config
  components/                    SearchForm, ProgressPanel, ResultsList, ResultItem
```

### Where to extend

- **Persist searches:** implement `save/get/delete/all` on a database and pass it to `SearchService` instead of the in-memory repository.
- **Another way of loading pages:** implement `fetch(url, { allow, signal })` from `crawler/fetchers/PageFetcher.js` and wire it in `server.js`.
- **Scope rules, robots.txt:** `crawler/urlPolicy.js`.
- **Whole-word or regex matching:** add an option to `matching/phraseMatcher.js`.

## Security

A crawler fetches whatever URL a user types, so by default the backend refuses addresses that resolve to private or loopback ranges (localhost, 10.x, 192.168.x, 169.254.x, ...). To search a site on your own machine or intranet, start the backend with `ALLOW_PRIVATE_ADDRESSES=true`.

The app has no authentication: anyone who can reach the port can start crawls. Keep it on a private network or put it behind something that authenticates.

## Troubleshooting

- **Only the start page was scanned.** The start page has no links the crawler can see and the site has no sitemap. Turn on "Render JavaScript" for sites built as web apps, "Include subdomains" if the pages live on another subdomain, or add the list pages under "Additional start URLs".
- **The crawl finished with far fewer pages than the site has.** Everything reachable through links was scanned, but the site keeps its content behind lists paged with buttons or trees that expand on click (archives, catalogs, web apps). Make sure "Use the site's own search box" is on (and "Render JavaScript" for web apps); the result panel says whether a search box was found. If the site has none on its start page, add its list pages under "Additional start URLs", or its results page with `{phrase}`, for example `https://example.com/search?q={phrase}&page={1-5}`.
- **A word you can see on a page was not found.** Check that the page was actually scanned (the counters and the results list), and whether the spelling differs by accent — with "Ignore accents" on, `Vitkovice` and `Vítkovice` are the same.
- **"Could not load the start page: getaddrinfo ENOTFOUND ..."** — the host does not resolve from the server. Check the URL, or DNS/VPN on the machine running the backend.
- **"JavaScript rendering is not installed" / "Chromium could not be started"** — run `npm install` and `npx playwright install chromium` in the backend folder, then restart it.
- **Behind a corporate proxy:** Node's `fetch` ignores proxy settings by default. Set `NODE_USE_ENV_PROXY=1` together with `HTTPS_PROXY=http://proxy:port` when starting the backend.
- **Crawl stops with pages still queued:** the page budget was reached. Raise "Max pages" in the form (up to `MAX_PAGES_LIMIT`).
- **Very large crawls (thousands of pages with JavaScript rendering):** expect roughly one to two seconds per page per browser slot; raise `BROWSER_CONCURRENCY` if the machine has spare CPU and memory.
# WebSiteWordFinder
