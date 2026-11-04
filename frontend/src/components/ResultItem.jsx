/**
 * One page where the phrase was found: its link, how many times, and a few
 * highlighted snippets.
 */
export default function ResultItem({ result }) {
  const { url, title, count, snippets, inTitle } = result;

  return (
    <li className="result">
      <div className="result-header">
        <a className="result-url" href={url} target="_blank" rel="noreferrer">
          {url}
        </a>
        <span className="badge" title="Occurrences on this page, title included">
          {count} {count === 1 ? 'match' : 'matches'}
        </span>
      </div>
      {title && (
        <div className="result-title">
          {title}
          {inTitle && <span className="muted"> · also in the page title</span>}
        </div>
      )}
      {snippets.length > 0 && (
        <ul className="snippets">
          {snippets.map((snippet, index) => (
            <li key={index}>
              {snippet.before}
              <mark>{snippet.match}</mark>
              {snippet.after}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
