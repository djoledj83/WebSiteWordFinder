import { useState } from 'react';
import ResultItem from './ResultItem.jsx';

/**
 * The pages where the phrase was found, plus the pages that could not be
 * loaded (collapsed, so they do not distract from the results).
 */
export default function ResultsList({ results, pageErrors, status, phrase }) {
  const [copied, setCopied] = useState(false);
  const isRunning = status === 'starting' || status === 'running';

  async function copyUrls() {
    try {
      await navigator.clipboard.writeText(results.map((result) => result.url).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available (e.g. plain http on a remote host); the links are still selectable
    }
  }

  return (
    <section className="card results">
      <div className="results-header">
        <h2>
          {results.length === 0
            ? isRunning
              ? 'No matches yet'
              : 'No matches'
            : `Found on ${results.length} ${results.length === 1 ? 'page' : 'pages'}`}
        </h2>
        {results.length > 0 && (
          <button type="button" className="secondary" onClick={copyUrls}>
            {copied ? 'Copied' : 'Copy URLs'}
          </button>
        )}
      </div>

      {results.length === 0 && !isRunning && status !== 'failed' && (
        <p className="muted">None of the scanned pages contain “{phrase}”.</p>
      )}

      {results.length > 0 && (
        <ul className="result-list">
          {results.map((result) => (
            <ResultItem key={result.url} result={result} />
          ))}
        </ul>
      )}

      {pageErrors.length > 0 && (
        <details className="page-errors">
          <summary>
            {pageErrors.length} {pageErrors.length === 1 ? 'page' : 'pages'} could not be loaded
          </summary>
          <ul>
            {pageErrors.map((failure) => (
              <li key={failure.url}>
                <a href={failure.url} target="_blank" rel="noreferrer">
                  {failure.url}
                </a>{' '}
                <span className="muted">— {failure.message}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
