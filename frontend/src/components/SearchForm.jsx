import { useState } from 'react';

/**
 * Collects the website, the phrase and the options, and hands them to
 * `onSubmit({ url, phrase, options })`. Validation here is only about
 * empty fields; the backend has the final say and its message is shown
 * through `submitError`. `config` comes from the server (limits, whether
 * JavaScript rendering is installed).
 */
const DEFAULTS = {
  url: '',
  phrase: '',
  maxPages: '',
  caseSensitive: false,
  ignoreAccents: true,
  contentOnly: true,
  includeSubdomains: false,
  renderJavaScript: false,
  useSiteSearch: true,
  extraStartUrls: '',
};

// The last submitted form is kept in this browser, so re-running a search
// after a tweak does not mean retyping everything.
const STORAGE_KEY = 'websitewordfinder.form';

function loadSavedForm() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

function saveForm(values) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // private mode or storage disabled: nothing to remember, nothing to break
  }
}

const OPTION_KEYS = ['maxPages', 'caseSensitive', 'ignoreAccents', 'contentOnly', 'includeSubdomains', 'renderJavaScript', 'useSiteSearch', 'extraStartUrls'];

export default function SearchForm({ config, disabled, submitError, onSubmit }) {
  const [saved] = useState(loadSavedForm);
  const [url, setUrl] = useState(saved.url);
  const [phrase, setPhrase] = useState(saved.phrase);
  const [maxPages, setMaxPages] = useState(saved.maxPages);
  const [caseSensitive, setCaseSensitive] = useState(saved.caseSensitive);
  const [ignoreAccents, setIgnoreAccents] = useState(saved.ignoreAccents);
  const [contentOnly, setContentOnly] = useState(saved.contentOnly);
  const [includeSubdomains, setIncludeSubdomains] = useState(saved.includeSubdomains);
  const [renderJavaScript, setRenderJavaScript] = useState(saved.renderJavaScript);
  const [useSiteSearch, setUseSiteSearch] = useState(saved.useSiteSearch);
  const [extraStartUrls, setExtraStartUrls] = useState(saved.extraStartUrls);
  const [showOptions, setShowOptions] = useState(() => OPTION_KEYS.some((key) => saved[key] !== DEFAULTS[key]));
  const [fieldError, setFieldError] = useState(null);

  const jsRendering = config.javaScriptRendering;

  function handleSubmit(event) {
    event.preventDefault();
    if (!url.trim()) return setFieldError('Enter the website to search.');
    if (!phrase.trim()) return setFieldError('Enter the word or phrase to look for.');
    setFieldError(null);
    saveForm({ url, phrase, maxPages, caseSensitive, ignoreAccents, contentOnly, includeSubdomains, renderJavaScript, useSiteSearch, extraStartUrls });
    onSubmit({
      url: url.trim(),
      phrase: phrase.trim(),
      options: {
        maxPages: Number(maxPages) || config.maxPagesDefault,
        caseSensitive,
        ignoreAccents,
        contentOnly,
        includeSubdomains,
        renderJavaScript: renderJavaScript && jsRendering.available,
        useSiteSearch,
        extraStartUrls,
      },
    });
  }

  const error = fieldError ?? submitError;

  return (
    <form className="search-form card" onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label htmlFor="url">Website</label>
        <input
          id="url"
          type="text"
          inputMode="url"
          autoComplete="url"
          placeholder="https://example.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={disabled}
          autoFocus
        />
      </div>

      <div className="field">
        <label htmlFor="phrase">Word or phrase</label>
        <input
          id="phrase"
          type="text"
          placeholder="e.g. POS terminal"
          value={phrase}
          onChange={(event) => setPhrase(event.target.value)}
          disabled={disabled}
        />
      </div>

      <button type="button" className="link-button" onClick={() => setShowOptions((open) => !open)} aria-expanded={showOptions}>
        {showOptions ? 'Hide options' : 'Options'}
      </button>

      {showOptions && (
        <div className="options">
          <div className="field inline">
            <label htmlFor="maxPages">Max pages to crawl</label>
            <input
              id="maxPages"
              type="number"
              min="1"
              max={config.maxPagesLimit}
              step="1"
              placeholder={String(config.maxPagesDefault)}
              value={maxPages}
              onChange={(event) => setMaxPages(event.target.value)}
              disabled={disabled}
            />
            <span className="muted">up to {config.maxPagesLimit.toLocaleString()}</span>
          </div>

          <label className="checkbox">
            <input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} disabled={disabled} />
            Match case exactly
          </label>

          <label className="checkbox">
            <input type="checkbox" checked={ignoreAccents} onChange={(event) => setIgnoreAccents(event.target.checked)} disabled={disabled} />
            <span>
              Ignore accents <span className="muted">(“Vitkovice” finds “Vítkovice”, “Cacak” finds “Čačak”)</span>
            </span>
          </label>

          <label className="checkbox">
            <input type="checkbox" checked={contentOnly} onChange={(event) => setContentOnly(event.target.checked)} disabled={disabled} />
            <span>
              Search page content only <span className="muted">(skip menus, sidebars, footers and navigation trees that repeat on every page)</span>
            </span>
          </label>

          <label className="checkbox">
            <input type="checkbox" checked={includeSubdomains} onChange={(event) => setIncludeSubdomains(event.target.checked)} disabled={disabled} />
            <span>
              Include subdomains <span className="muted">(shop.example.com, en.example.com…)</span>
            </span>
          </label>

          <label className="checkbox">
            <input type="checkbox" checked={useSiteSearch} onChange={(event) => setUseSiteSearch(event.target.checked)} disabled={disabled} />
            <span>
              Use the site's own search box{' '}
              <span className="muted">(types your phrase into the site's search, then visits every result page — the way to reach records, catalogs and archives)</span>
            </span>
          </label>

          <label className={`checkbox ${jsRendering.available ? '' : 'is-unavailable'}`}>
            <input
              type="checkbox"
              checked={renderJavaScript && jsRendering.available}
              onChange={(event) => setRenderJavaScript(event.target.checked)}
              disabled={disabled || !jsRendering.available}
            />
            <span>
              Render JavaScript <span className="muted">(for sites built as web apps — slower, loads each page in a headless browser)</span>
              {!jsRendering.available && <span className="muted block"> Not available: {jsRendering.reason}</span>}
            </span>
          </label>

          <div className="field">
            <label htmlFor="extraStartUrls">Additional start URLs</label>
            <textarea
              id="extraStartUrls"
              rows={4}
              placeholder={'One per line, same website. {1-100} expands to a range, {phrase} is your search phrase, e.g.\nhttps://example.com/list?page={1-100}\nhttps://example.com/search?q={phrase}&page={1-5}'}
              value={extraStartUrls}
              onChange={(event) => setExtraStartUrls(event.target.value)}
              disabled={disabled}
              spellCheck={false}
            />
            <span className="muted">
              For pages no link leads to: paged lists whose paging is made of buttons, or the site's own search results page. Up to{' '}
              {config.maxExtraStartUrls.toLocaleString()} URLs.
            </span>
          </div>
        </div>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="actions">
        <button type="submit" className="primary" disabled={disabled}>
          {disabled ? 'Searching…' : 'Search website'}
        </button>
      </div>
    </form>
  );
}
