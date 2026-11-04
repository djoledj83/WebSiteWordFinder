const STATUS_LABEL = {
  starting: 'Starting…',
  running: 'Crawling…',
  completed: 'Finished',
  stopped: 'Stopped',
  failed: 'Failed',
};

/**
 * Shows how far the crawl is, lets the user stop it, and explains the
 * outcome when it is not what the user hoped for (page limit reached, only
 * the start page could be scanned...).
 */
export default function ProgressPanel({ status, progress, input, resolvedUrl, sitemap, siteSearch, error, stoppedBy, stopping, connectionLost, onStop }) {
  const options = input?.options ?? {};
  const maxPages = options.maxPages ?? 0;
  const scanned = progress?.scanned ?? 0;
  const isRunning = status === 'starting' || status === 'running';
  const percent = isRunning && maxPages ? Math.min(100, Math.round((scanned / maxPages) * 100)) : 100;
  const redirected = resolvedUrl && input && stripSlash(resolvedUrl) !== stripSlash(input.url);
  const onlyStartPage = status === 'completed' && scanned <= 1 && (progress?.discovered ?? 0) === 0 && (progress?.seeded ?? 0) === 0;
  const ranOutOfLinks = status === 'completed' && stoppedBy === 'exhausted' && !onlyStartPage;

  return (
    <section className="card progress-panel" aria-live="polite">
      <div className="progress-header">
        <div>
          <span className={`status status-${status}`}>{STATUS_LABEL[status] ?? status}</span>
          {input && (
            <span className="progress-target">
              {' '}
              looking for <strong>“{input.phrase}”</strong> on{' '}
              <a href={input.url} target="_blank" rel="noreferrer">
                {input.url}
              </a>
              {redirected && (
                <span className="muted">
                  {' '}
                  (redirected to{' '}
                  <a href={resolvedUrl} target="_blank" rel="noreferrer">
                    {resolvedUrl}
                  </a>
                  )
                </span>
              )}
            </span>
          )}
        </div>
        {isRunning && (
          <button type="button" className="secondary" onClick={onStop} disabled={stopping}>
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>

      <div className="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent}>
        <div className={`progress-fill ${isRunning ? 'is-running' : ''}`} style={{ width: `${percent}%` }} />
      </div>

      {progress && (
        <dl className="counters">
          <div>
            <dt>Pages scanned</dt>
            <dd>{progress.scanned}</dd>
          </div>
          <div>
            <dt>Matches</dt>
            <dd>{progress.found}</dd>
          </div>
          <div>
            <dt>Queued</dt>
            <dd>{progress.queued}</dd>
          </div>
          <div>
            <dt>Errors</dt>
            <dd>{progress.errors}</dd>
          </div>
        </dl>
      )}

      {progress && (
        <p className="muted small">
          {pages(progress.discovered)} found through links
          {progress.seeded > 0 && <>, {progress.seeded.toLocaleString()} from the site's search, sitemaps and additional start URLs</>}
          {progress.listPages > 0 && <> ({pages(progress.listPages).replace('page', 'result page')} turned)</>}
          {sitemap && sitemap.sitemapsRead > 0 && sitemap.urlsListed === 0 && <>; no sitemap on this site</>}
          {options.renderJavaScript && <>; JavaScript rendering on</>}.
        </p>
      )}

      {siteSearch && (
        <p className="muted small">
          {siteSearch.used && siteSearch.url && (
            <>
              Site search used:{' '}
              <a href={siteSearch.url} target="_blank" rel="noreferrer">
                {siteSearch.url}
              </a>
            </>
          )}
          {siteSearch.used && !siteSearch.url && <>Site search used; its results were read from the page ({siteSearch.linksAdded} links).</>}
          {!siteSearch.used && <>Site search not used: {siteSearch.reason}</>}
        </p>
      )}

      {status === 'failed' && error && <p className="notice notice-error">{error}</p>}

      {stoppedBy === 'page-budget' && (
        <p className="notice">
          The limit of {maxPages.toLocaleString()} pages was reached while {(progress?.queued ?? 0).toLocaleString()} more were still queued. Raise “Max pages” in the options to search further.
        </p>
      )}

      {onlyStartPage && (
        <p className="notice">
          Only the start page could be scanned: it contains no links to other pages of this site and the site has no sitemap.
          {!options.renderJavaScript && (
            <> If the site is built as a web app (its menu appears only after JavaScript runs), turn on “Render JavaScript” in the options.</>
          )}
          {!options.includeSubdomains && <> If its pages live on another subdomain, turn on “Include subdomains”.</>}
          <> For paged lists without links, add the list pages under “Additional start URLs”.</>
        </p>
      )}

      {ranOutOfLinks && (
        <p className="muted small">
          The crawl ended because every page reachable through links{progress?.seeded > 0 ? ", the site's search, sitemaps and additional start URLs" : ' and sitemaps'}{' '}
          has been scanned.
          {siteSearch && !siteSearch.used && (
            <> This site's search box could not be used, so pages that only its search or its trees lead to were not reached; you can add such pages under “Additional start URLs”.</>
          )}
        </p>
      )}

      {connectionLost && isRunning && <p className="notice notice-error">Connection to the server lost — trying to reconnect…</p>}
    </section>
  );
}

function stripSlash(url) {
  return url.replace(/\/$/, '');
}

function pages(count) {
  return `${count.toLocaleString()} ${count === 1 ? 'page' : 'pages'}`;
}
