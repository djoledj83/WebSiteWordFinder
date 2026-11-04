import { Router } from 'express';
import { createScope, isInScope, normalizeUrl } from '../crawler/urlPolicy.js';
import { expandSeedUrls } from '../crawler/seedUrls.js';
import { openEventStream } from './sse.js';

const MAX_PHRASE_LENGTH = 200;

/**
 * HTTP surface of the app. Routes validate input, call SearchService and
 * shape the response; no crawling logic lives here.
 *
 *   GET  /config                                          -> limits and capabilities for the UI
 *   POST /searches             { url, phrase, options? }  -> 201 { id, status }
 *        options: maxPages, caseSensitive, ignoreAccents, contentOnly, includeSubdomains,
 *                 renderJavaScript, useSiteSearch, extraStartUrls (lines; {1-100} ranges, {phrase})
 *   GET  /searches/:id                                    -> snapshot
 *   GET  /searches/:id/events                             -> SSE: snapshot, progress, match, page-error, done
 *   POST /searches/:id/stop                               -> 202 { id, status }
 */
export function createSearchRouter({ searchService, limits }) {
  const router = Router();

  router.get('/config', async (req, res) => {
    res.json(await searchService.describeCapabilities());
  });

  router.post('/searches', async (req, res) => {
    const { value, error } = validateSearchRequest(req.body, limits);
    if (error) return res.status(400).json({ error });
    try {
      const job = await searchService.createSearch(value);
      return res.status(201).json({ id: job.id, status: job.status });
    } catch (cause) {
      if (cause.code === 'BROWSER_UNAVAILABLE') {
        return res.status(400).json({ error: { code: cause.code, message: cause.message, field: 'options.renderJavaScript' } });
      }
      throw cause;
    }
  });

  router.get('/searches/:id', (req, res) => {
    const job = findJob(req, res);
    if (job) res.json(job.snapshot());
  });

  router.post('/searches/:id/stop', (req, res) => {
    const job = findJob(req, res);
    if (!job) return;
    searchService.stopSearch(job.id);
    res.status(202).json({ id: job.id, status: job.status });
  });

  router.get('/searches/:id/events', (req, res) => {
    const job = findJob(req, res);
    if (!job) return;

    const stream = openEventStream(res);
    // Late subscribers (or a reconnecting EventSource) first get the full state.
    stream.send('snapshot', job.snapshot());
    if (job.isFinished) {
      stream.close();
      return;
    }
    const unsubscribe = job.subscribe((event, data) => {
      stream.send(event, data);
      if (event === 'done') stream.close();
    });
    res.on('close', unsubscribe);
  });

  function findJob(req, res) {
    const job = searchService.getSearch(req.params.id);
    if (!job) res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such search' } });
    return job;
  }

  return router;
}

/**
 * Returns { value } with a cleaned-up request, or { error } describing the first problem.
 * `limits` = { maxPagesLimit, maxExtraStartUrls }.
 */
export function validateSearchRequest(body, { maxPagesLimit, maxExtraStartUrls = 5000 }) {
  const invalid = (message, field) => ({ error: { code: 'INVALID_INPUT', message, field } });
  if (!body || typeof body !== 'object') return invalid('Request body must be a JSON object');

  if (typeof body.url !== 'string' || !body.url.trim()) return invalid('A website URL is required', 'url');
  let url;
  try {
    url = new URL(withScheme(body.url.trim()));
  } catch {
    return invalid('The website URL is not valid', 'url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return invalid('Only http and https URLs are supported', 'url');

  const phrase = typeof body.phrase === 'string' ? body.phrase.trim() : '';
  if (!phrase) return invalid('A word or phrase to search for is required', 'phrase');
  if (phrase.length > MAX_PHRASE_LENGTH) return invalid(`The phrase is limited to ${MAX_PHRASE_LENGTH} characters`, 'phrase');

  const rawOptions = body.options ?? {};
  if (typeof rawOptions !== 'object' || Array.isArray(rawOptions)) return invalid('options must be an object', 'options');
  const options = {};

  if (rawOptions.maxPages !== undefined) {
    const maxPages = Number(rawOptions.maxPages);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > maxPagesLimit) {
      return invalid(`maxPages must be a whole number between 1 and ${maxPagesLimit}`, 'options.maxPages');
    }
    options.maxPages = maxPages;
  }

  for (const flag of ['caseSensitive', 'ignoreAccents', 'contentOnly', 'includeSubdomains', 'renderJavaScript', 'useSiteSearch']) {
    if (rawOptions[flag] === undefined) continue;
    if (typeof rawOptions[flag] !== 'boolean') return invalid(`${flag} must be true or false`, `options.${flag}`);
    options[flag] = rawOptions[flag];
  }

  if (rawOptions.extraStartUrls !== undefined) {
    const lines = Array.isArray(rawOptions.extraStartUrls)
      ? rawOptions.extraStartUrls
      : typeof rawOptions.extraStartUrls === 'string'
        ? rawOptions.extraStartUrls.split(/\r?\n/)
        : null;
    if (!lines || lines.some((line) => typeof line !== 'string')) {
      return invalid('extraStartUrls must be a list of URLs (one per line)', 'options.extraStartUrls');
    }
    const patterns = lines.map((line) => line.trim()).filter(Boolean).map(withScheme);
    let expanded;
    try {
      expanded = expandSeedUrls(patterns, { max: maxExtraStartUrls, phrase });
    } catch (cause) {
      return invalid(cause.message, 'options.extraStartUrls');
    }
    const scope = createScope(url.href, { includeSubdomains: options.includeSubdomains ?? false });
    for (const candidate of expanded) {
      const normalized = normalizeUrl(candidate);
      if (!normalized) return invalid(`"${candidate}" is not a valid http(s) URL`, 'options.extraStartUrls');
      if (!isInScope(normalized, scope)) return invalid(`"${candidate}" is not on the website being searched`, 'options.extraStartUrls');
    }
    if (patterns.length > 0) options.extraStartUrls = patterns;
  }

  return { value: { url: url.href, phrase, options } };
}

/** Lets users type "example.com" or "localhost:8080/x" instead of spelling out https://. */
function withScheme(url) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url; // already has a scheme
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(url)) return url; // mailto:, javascript:, ... left for validation to reject
  return `https://${url}`;
}
