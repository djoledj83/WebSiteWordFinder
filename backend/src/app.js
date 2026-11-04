import path from 'node:path';
import express from 'express';
import { createSearchRouter } from './api/routes.js';

/**
 * Assembles the Express app from its dependencies. Kept apart from
 * server.js so tests can build an app around their own service and fetcher.
 *
 * @param {object} deps
 * @param {object} deps.searchService
 * @param {object} deps.limits            { maxPagesLimit, maxExtraStartUrls } for request validation
 * @param {string|null} [deps.staticDir]  Built frontend to serve (production), or null.
 */
export function createApp({ searchService, limits, staticDir = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' })); // extra start URLs can be a long list

  app.use('/api', createSearchRouter({ searchService, limits }));
  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` } });
  });

  if (staticDir) {
    app.use(express.static(staticDir));
    app.use((req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars -- Express recognizes error handlers by their arity
  app.use((error, req, res, next) => {
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
    }
    console.error(error);
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected server error' } });
  });

  return app;
}
