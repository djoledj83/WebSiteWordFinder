/**
 * Builds the application config from environment variables.
 * Every value has a default, so the server runs with no .env at all.
 * Keeping this in one place means the rest of the code never reads process.env.
 */

const DEFAULTS = {
  PORT: 4000,
  MAX_PAGES: 200,
  MAX_PAGES_LIMIT: 20_000,
  MAX_DEPTH: 10,
  MAX_EXTRA_START_URLS: 5000,
  CONCURRENCY: 5,
  TIMEOUT_MS: 10_000,
  MAX_BODY_BYTES: 5 * 1024 * 1024,
  USER_AGENT: 'Mozilla/5.0 (compatible; WebSiteWordFinder/1.0)',
  ALLOW_PRIVATE_ADDRESSES: false,
  BROWSER_CONCURRENCY: 3,
  BROWSER_TIMEOUT_MS: 20_000,
  BROWSER_SETTLE_MS: 2500,
  JOB_TTL_MS: 30 * 60 * 1000,
};

export function loadConfig(env = process.env) {
  const config = {
    port: integer(env.PORT, DEFAULTS.PORT),
    crawl: {
      maxPages: integer(env.MAX_PAGES, DEFAULTS.MAX_PAGES),
      maxPagesLimit: integer(env.MAX_PAGES_LIMIT, DEFAULTS.MAX_PAGES_LIMIT),
      maxDepth: integer(env.MAX_DEPTH, DEFAULTS.MAX_DEPTH),
      maxExtraStartUrls: integer(env.MAX_EXTRA_START_URLS, DEFAULTS.MAX_EXTRA_START_URLS),
      concurrency: integer(env.CONCURRENCY, DEFAULTS.CONCURRENCY),
      timeoutMs: integer(env.TIMEOUT_MS, DEFAULTS.TIMEOUT_MS),
      maxBodyBytes: integer(env.MAX_BODY_BYTES, DEFAULTS.MAX_BODY_BYTES),
      userAgent: env.USER_AGENT || DEFAULTS.USER_AGENT,
      allowPrivateAddresses: boolean(env.ALLOW_PRIVATE_ADDRESSES, DEFAULTS.ALLOW_PRIVATE_ADDRESSES),
    },
    browser: {
      concurrency: integer(env.BROWSER_CONCURRENCY, DEFAULTS.BROWSER_CONCURRENCY),
      timeoutMs: integer(env.BROWSER_TIMEOUT_MS, DEFAULTS.BROWSER_TIMEOUT_MS),
      settleMs: integer(env.BROWSER_SETTLE_MS, DEFAULTS.BROWSER_SETTLE_MS),
    },
    jobs: {
      ttlMs: integer(env.JOB_TTL_MS, DEFAULTS.JOB_TTL_MS),
    },
  };

  validate(config);
  return config;
}

function validate({ port, crawl, browser, jobs }) {
  const positive = {
    PORT: port,
    MAX_PAGES: crawl.maxPages,
    MAX_PAGES_LIMIT: crawl.maxPagesLimit,
    MAX_EXTRA_START_URLS: crawl.maxExtraStartUrls,
    CONCURRENCY: crawl.concurrency,
    TIMEOUT_MS: crawl.timeoutMs,
    MAX_BODY_BYTES: crawl.maxBodyBytes,
    BROWSER_CONCURRENCY: browser.concurrency,
    BROWSER_TIMEOUT_MS: browser.timeoutMs,
    BROWSER_SETTLE_MS: browser.settleMs,
    JOB_TTL_MS: jobs.ttlMs,
  };
  for (const [name, value] of Object.entries(positive)) {
    if (value < 1) throw new Error(`Config ${name} must be a positive number, got ${value}`);
  }
  if (crawl.maxDepth < 0) throw new Error('Config MAX_DEPTH must be 0 or more');
  if (crawl.maxPages > crawl.maxPagesLimit) {
    throw new Error('Config MAX_PAGES cannot be larger than MAX_PAGES_LIMIT');
  }
}

function integer(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`Expected an integer, got "${raw}"`);
  return value;
}

function boolean(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}
