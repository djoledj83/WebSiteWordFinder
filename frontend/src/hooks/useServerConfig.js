import { useEffect, useState } from 'react';
import { getConfig } from '../api/searchApi.js';

// Used until the server has answered, and when it cannot be reached.
const FALLBACK = {
  maxPagesDefault: 200,
  maxPagesLimit: 20000,
  maxExtraStartUrls: 5000,
  javaScriptRendering: { available: false, reason: 'Could not read the server configuration.' },
};

/** Loads the limits and capabilities the form needs from the backend, once. */
export function useServerConfig() {
  const [config, setConfig] = useState(FALLBACK);

  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((loaded) => {
        if (!cancelled) setConfig(loaded);
      })
      .catch(() => {
        // keep the fallback; the form still works and the backend will validate
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
