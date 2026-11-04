/**
 * The contract every page fetcher implements. The crawler only ever calls
 * `fetch(url, { allow, signal })`, so a different way of loading pages (for
 * example a headless browser that executes JavaScript) is a new class with
 * this one method, and nothing else changes. See HttpFetcher (plain HTTP)
 * and BrowserFetcher (Playwright).
 *
 * @typedef {object} FetchResult
 * @property {string} url          Final URL after redirects.
 * @property {number} status       HTTP status of the final response (0 if none).
 * @property {string|null} html    The document, or null when `reason` says why not.
 * @property {?('http-status'|'not-html'|'redirect-not-allowed'|'too-many-redirects')} reason
 * @property {string} [contentType]
 *
 * @typedef {object} FetchOptions
 * @property {(url: string) => boolean|Promise<boolean>} [allow]  Asked before following a redirect.
 * @property {AbortSignal} [signal]                                 Cancels the request.
 *
 * @typedef {object} PageFetcher
 * @property {(url: string, options?: FetchOptions) => Promise<FetchResult>} fetch
 *   Resolves with a FetchResult for anything that produced a response, and
 *   rejects with a FetchError for transport failures (DNS, timeout, refused
 *   connection, response too large, address not allowed).
 * @property {() => Promise<void>} [close]   Releases resources (browsers...).
 */

export class FetchError extends Error {
  constructor(message, code = 'FETCH_FAILED') {
    super(message);
    this.name = 'FetchError';
    this.code = code;
  }
}

export function isHtmlContentType(contentType) {
  const mediaType = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return mediaType === 'text/html' || mediaType === 'application/xhtml+xml';
}
