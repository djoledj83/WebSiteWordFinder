import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { AddressGuard } from './crawler/fetchers/addressGuard.js';
import { BrowserFetcher } from './crawler/fetchers/BrowserFetcher.js';
import { HttpFetcher } from './crawler/fetchers/HttpFetcher.js';
import { SearchService } from './search/SearchService.js';
import { createInMemorySearchRepository } from './search/searchRepository.js';

/**
 * Composition root: the only place that knows which concrete pieces are
 * wired together. Swapping a fetcher or the repository happens here.
 */
const config = loadConfig();

const addressGuard = new AddressGuard({ allowPrivateAddresses: config.crawl.allowPrivateAddresses });
const fetchers = {
  http: new HttpFetcher({ ...config.crawl, addressGuard }),
  // Starts Chromium only when a search asks for JavaScript rendering.
  browser: new BrowserFetcher({
    ...config.browser,
    maxBodyBytes: config.crawl.maxBodyBytes,
    userAgent: config.crawl.userAgent,
    addressGuard,
  }),
};
const searchService = new SearchService({
  repository: createInMemorySearchRepository(),
  fetchers,
  crawlConfig: config.crawl,
  jobTtlMs: config.jobs.ttlMs,
});

// In production the backend also serves the built frontend, if it exists.
const frontendDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
const staticDir = existsSync(frontendDist) ? frontendDist : null;

const app = createApp({
  searchService,
  limits: { maxPagesLimit: config.crawl.maxPagesLimit, maxExtraStartUrls: config.crawl.maxExtraStartUrls },
  staticDir,
});

const server = app.listen(config.port, async () => {
  console.log(`WebSiteWordFinder API listening on http://localhost:${config.port}`);
  console.log(staticDir ? `Serving frontend from ${staticDir}` : 'No frontend build found; run the Vite dev server for the UI');
  if (config.crawl.allowPrivateAddresses) console.log('Private addresses are allowed (ALLOW_PRIVATE_ADDRESSES=true)');
  const { javaScriptRendering } = await searchService.describeCapabilities();
  console.log(javaScriptRendering.available ? 'JavaScript rendering available (Playwright found)' : `JavaScript rendering unavailable: ${javaScriptRendering.reason}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await searchService.close();
    server.close(() => process.exit(0));
  });
}
