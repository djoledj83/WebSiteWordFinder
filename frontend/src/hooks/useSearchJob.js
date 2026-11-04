import { useCallback, useEffect, useReducer, useRef } from 'react';
import { startSearch, stopSearch, subscribeToSearch } from '../api/searchApi.js';

/**
 * Owns the whole life of one search on the client: submit it, follow the
 * live event stream, accumulate results, stop it. Components only render
 * what this hook returns.
 *
 * status: 'idle' | 'starting' | 'running' | 'completed' | 'stopped' | 'failed'
 */
const initialState = {
  status: 'idle',
  jobId: null,
  input: null, // { url, phrase, options } as the server resolved them
  progress: null, // { scanned, queued, inFlight, found, errors, skipped }
  results: [],
  pageErrors: [],
  error: null, // why the whole search failed
  stoppedBy: null, // 'exhausted' | 'page-budget' | 'abort'
  resolvedUrl: null, // where the start URL ended up after redirects
  sitemap: null, // { sitemapsRead, urlsListed }
  siteSearch: null, // { used, url?, linksAdded?, reason? }
  stopping: false,
  connectionLost: false,
  submitError: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'starting':
      return { ...initialState, status: 'starting', input: action.input };
    case 'started':
      return { ...state, jobId: action.id };
    case 'submit-failed':
      return { ...state, status: 'idle', submitError: action.message };
    case 'snapshot': {
      const { status, input, progress, results, errors, error, stoppedBy, resolvedUrl, sitemap, siteSearch } = action.snapshot;
      return { ...state, status, input, progress, results, pageErrors: errors, error, stoppedBy, resolvedUrl, sitemap, siteSearch, connectionLost: false };
    }
    case 'progress':
      return { ...state, status: 'running', progress: action.progress, connectionLost: false };
    case 'match':
      if (state.results.some((result) => result.url === action.result.url)) return state;
      return { ...state, results: [...state.results, action.result] };
    case 'page-error':
      if (state.pageErrors.some((failure) => failure.url === action.failure.url)) return state;
      return { ...state, pageErrors: [...state.pageErrors, action.failure] };
    case 'done': {
      const { status, progress, error, stoppedBy, resolvedUrl, sitemap, siteSearch } = action.done;
      return { ...state, status, progress, error, stoppedBy, resolvedUrl, sitemap, siteSearch, stopping: false, connectionLost: false };
    }
    case 'stopping':
      return { ...state, stopping: true };
    case 'connection-lost':
      return { ...state, connectionLost: true };
    case 'reset':
      return initialState;
    default:
      return state;
  }
}

const FINISHED = new Set(['completed', 'stopped', 'failed']);

export function useSearchJob() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const unsubscribeRef = useRef(null);

  const disconnect = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  }, []);

  // Close the stream if the component using the hook goes away.
  useEffect(() => disconnect, [disconnect]);

  const start = useCallback(
    async (input) => {
      disconnect();
      dispatch({ type: 'starting', input });
      try {
        const { id } = await startSearch(input);
        dispatch({ type: 'started', id });
        unsubscribeRef.current = subscribeToSearch(id, {
          snapshot: (snapshot) => {
            dispatch({ type: 'snapshot', snapshot });
            if (FINISHED.has(snapshot.status)) disconnect();
          },
          progress: (progress) => dispatch({ type: 'progress', progress }),
          match: (result) => dispatch({ type: 'match', result }),
          pageError: (failure) => dispatch({ type: 'page-error', failure }),
          done: (done) => {
            // Close before the server does, otherwise EventSource would reconnect forever.
            disconnect();
            dispatch({ type: 'done', done });
          },
          // EventSource reconnects by itself; the next snapshot replaces the state.
          error: () => dispatch({ type: 'connection-lost' }),
        });
      } catch (error) {
        dispatch({ type: 'submit-failed', message: error.message });
      }
    },
    [disconnect],
  );

  const stop = useCallback(async () => {
    if (!state.jobId || FINISHED.has(state.status)) return;
    dispatch({ type: 'stopping' });
    try {
      await stopSearch(state.jobId);
    } catch {
      // if this failed the stream will still tell us how the search ended
    }
  }, [state.jobId, state.status]);

  const reset = useCallback(() => {
    disconnect();
    dispatch({ type: 'reset' });
  }, [disconnect]);

  return {
    ...state,
    isRunning: state.status === 'starting' || state.status === 'running',
    isFinished: FINISHED.has(state.status),
    start,
    stop,
    reset,
  };
}
