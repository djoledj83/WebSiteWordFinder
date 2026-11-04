import { FetchError, isHtmlContentType } from './PageFetcher.js';

/**
 * Loads pages with a plain HTTP request and returns the HTML as served
 * (no JavaScript is executed). Implements the PageFetcher contract, and
 * additionally offers `fetchResource` for non-HTML files such as sitemaps.
 *
 * Redirects are followed by hand so that every hop can be checked against
 * the crawl scope (`allow`) and the address guard, with a cap on the number
 * of hops. Bodies are read with a size limit and decoded using the charset
 * from the Content-Type header or a <meta charset> tag.
 */
export class HttpFetcher {
  #timeoutMs;
  #maxBodyBytes;
  #maxRedirects;
  #headers;
  #addressGuard;

  constructor({ timeoutMs, maxBodyBytes, userAgent, addressGuard, maxRedirects = 5 }) {
    this.#timeoutMs = timeoutMs;
    this.#maxBodyBytes = maxBodyBytes;
    this.#maxRedirects = maxRedirects;
    this.#addressGuard = addressGuard;
    this.#headers = {
      'user-agent': userAgent,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
    };
  }

  /** PageFetcher contract: the HTML of a page, or why there is none. */
  async fetch(urlString, options = {}) {
    const resource = await this.fetchResource(urlString, {
      ...options,
      // Only read bodies that can be pages; an absent header is decided by sniffing.
      wantBody: (contentType) => contentType === '' || isHtmlContentType(contentType),
    });
    const { url, status, contentType, body, reason } = resource;
    if (reason) return { url, status, html: null, reason, contentType };
    if (!body || (contentType === '' && !looksLikeHtml(body))) return { url, status, html: null, reason: 'not-html', contentType };
    return { url, status, html: decode(body, contentType), reason: null, contentType };
  }

  /**
   * Any resource as bytes: { url, status, contentType, body, reason }.
   * `wantBody(contentType)` decides whether the body is read at all; when
   * it says no, `body` is null and `reason` stays null.
   */
  async fetchResource(urlString, { allow = () => true, signal, wantBody = () => true } = {}) {
    let url = new URL(urlString);

    for (let hop = 0; hop <= this.#maxRedirects; hop += 1) {
      await this.#addressGuard.assertAllowed(url);
      const response = await this.#request(url, signal);
      const contentType = response.headers.get('content-type') ?? '';
      const result = (reason, body = null) => ({ url: url.href, status: response.status, contentType, body, reason });

      if (isRedirect(response.status)) {
        await response.body?.cancel();
        const next = resolveRedirect(response.headers.get('location'), url);
        if (!next) return result('http-status');
        if (!(await allow(next.href))) return result('redirect-not-allowed');
        url = next;
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        return result('http-status');
      }

      if (!wantBody(contentType)) {
        await response.body?.cancel();
        return result(null);
      }

      return result(null, await this.#readBody(response));
    }

    return { url: url.href, status: 0, contentType: '', body: null, reason: 'too-many-redirects' };
  }

  async close() {}

  async #request(url, signal) {
    const signals = [AbortSignal.timeout(this.#timeoutMs)];
    if (signal) signals.push(signal);
    try {
      return await fetch(url, { redirect: 'manual', headers: this.#headers, signal: AbortSignal.any(signals) });
    } catch (error) {
      throw toFetchError(error, this.#timeoutMs);
    }
  }

  async #readBody(response) {
    const declared = Number(response.headers.get('content-length'));
    if (declared > this.#maxBodyBytes) {
      await response.body?.cancel();
      throw new FetchError(`Response is larger than ${this.#maxBodyBytes} bytes`, 'TOO_LARGE');
    }
    if (!response.body) return Buffer.alloc(0);

    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > this.#maxBodyBytes) {
        // leaving the loop early cancels the stream
        throw new FetchError(`Response is larger than ${this.#maxBodyBytes} bytes`, 'TOO_LARGE');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function resolveRedirect(location, from) {
  if (!location) return null;
  try {
    const next = new URL(location, from);
    return next.protocol === 'http:' || next.protocol === 'https:' ? next : null;
  } catch {
    return null;
  }
}

function looksLikeHtml(bytes) {
  return /<(!doctype\s+html|html|head|body|a\s)/i.test(bytes.subarray(0, 2048).toString('latin1'));
}

/** Decodes the body using the header charset, then a <meta> charset, then UTF-8. */
export function decode(bytes, contentType) {
  const label = charsetFromHeader(contentType) ?? charsetFromMeta(bytes) ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function charsetFromHeader(contentType) {
  return /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
}

function charsetFromMeta(bytes) {
  const head = bytes.subarray(0, 2048).toString('latin1');
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
}

function toFetchError(error, timeoutMs) {
  if (error.name === 'TimeoutError') return new FetchError(`Timed out after ${timeoutMs} ms`, 'TIMEOUT');
  if (error.name === 'AbortError') return error; // the caller cancelled on purpose
  const cause = error.cause;
  return new FetchError(cause?.message ?? error.message, cause?.code ?? 'NETWORK');
}
