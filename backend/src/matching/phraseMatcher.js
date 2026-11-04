import { collapseWhitespace, escapeRegExp, foldAccents, toOriginalRange } from '../lib/text.js';

/**
 * Finds a word or phrase in a page's text. Pure function: no I/O, no state.
 *
 * `text` is what parsePage produces: single spaces between words and a
 * newline between blocks. The phrase is collapsed to single spaces, so
 * "hello   world" matches "hello world" however the page wrapped it, but a
 * phrase never matches across two blocks (a heading and the paragraph
 * after it). Matching is a literal substring search, case-insensitive and
 * accent-insensitive by default ("Vitkovice" finds "Vítkovice"). Other
 * modes (whole word, regular expression) belong here too, as new options.
 *
 * Returns { count, snippets } where each snippet is { before, match, after }
 * taken from the original text, so the UI can highlight the match as it
 * appears on the page.
 */
export function findPhrase(text, phrase, { caseSensitive = false, ignoreAccents = true, maxSnippets = 3, contextChars = 60 } = {}) {
  const needle = collapseWhitespace(phrase);
  if (!needle) return { count: 0, snippets: [] };

  const haystack = ignoreAccents ? foldAccents(text) : { folded: text, offsets: null };
  const target = ignoreAccents ? foldAccents(needle).folded : needle;
  if (!target) return { count: 0, snippets: [] };

  const pattern = new RegExp(escapeRegExp(target), caseSensitive ? 'gu' : 'giu');
  let count = 0;
  const snippets = [];

  for (const match of haystack.folded.matchAll(pattern)) {
    count += 1;
    if (snippets.length < maxSnippets) {
      const [start, end] = toOriginalRange(haystack, match.index, match.index + match[0].length);
      snippets.push(makeSnippet(text, start, end - start, contextChars));
    }
  }

  return { count, snippets };
}

/**
 * Applies findPhrase to a parsed page: body text first, then the title.
 * Snippets come from the body; the title is used for a snippet only when
 * the phrase appears nowhere else, so the context shown is what the visitor
 * reads on the page rather than the browser tab.
 */
export function findPhraseInPage({ title = '', text = '' }, phrase, options = {}) {
  const inText = findPhrase(text, phrase, options);
  const inTitle = findPhrase(title, phrase, { ...options, maxSnippets: 1 });
  return {
    count: inText.count + inTitle.count,
    snippets: inText.count > 0 ? inText.snippets : inTitle.snippets,
    inTitle: inTitle.count > 0,
  };
}

/** A window of `contextChars` around the match, widened to whole words, on one line. */
function makeSnippet(text, index, length, contextChars) {
  const matchEnd = index + length;

  let start = Math.max(0, index - contextChars);
  if (start > 0) {
    const boundary = text.slice(start, index).search(/\s/);
    if (boundary !== -1) start += boundary + 1;
  }

  let end = Math.min(text.length, matchEnd + contextChars);
  if (end < text.length) {
    const boundary = text.slice(matchEnd, end).search(/\s[^\s]*$/);
    if (boundary !== -1) end = matchEnd + boundary;
  }

  const oneLine = (part) => part.replace(/\n/g, ' ');
  return {
    before: (start > 0 ? '…' : '') + oneLine(text.slice(start, index)),
    match: text.slice(index, matchEnd),
    after: oneLine(text.slice(matchEnd, end)) + (end < text.length ? '…' : ''),
  };
}
