/**
 * The only module that knows the backend's URLs and payloads.
 * Components never call fetch directly; they go through useSearchJob,
 * which uses these functions.
 */
const BASE = '/api';

export class ApiError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ApiError';
    this.details = details;
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, options);
  } catch {
    throw new ApiError('Could not reach the server. Is the backend running?');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(body?.error?.message ?? `Request failed with status ${response.status}`, body?.error);
  }
  return body;
}

/** Limits and capabilities of the server: { maxPagesDefault, maxPagesLimit, maxExtraStartUrls, javaScriptRendering: { available, reason } } */
export function getConfig() {
  return request('/config');
}

/** @returns {Promise<{ id: string, status: string }>} */
export function startSearch({ url, phrase, options }) {
  return request('/searches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, phrase, options }),
  });
}

export function stopSearch(id) {
  return request(`/searches/${id}/stop`, { method: 'POST' });
}

export function getSearch(id) {
  return request(`/searches/${id}`);
}

/**
 * Opens the live event stream of a search. `handlers` may define
 * snapshot, progress, match, pageError, done and error. Returns a function
 * that closes the stream.
 */
export function subscribeToSearch(id, handlers) {
  const source = new EventSource(`${BASE}/searches/${id}/events`);
  const events = { snapshot: 'snapshot', progress: 'progress', match: 'match', 'page-error': 'pageError', done: 'done' };
  for (const [name, handler] of Object.entries(events)) {
    source.addEventListener(name, (event) => handlers[handler]?.(JSON.parse(event.data)));
  }
  source.onerror = () => handlers.error?.();
  return () => source.close();
}
