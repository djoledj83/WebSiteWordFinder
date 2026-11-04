import * as cheerio from 'cheerio';
import { collapseWhitespace } from '../lib/text.js';

/**
 * Turns one HTML document into the two things the crawler needs:
 * the links it contains and the text a visitor would actually see.
 *
 * Returns { title, text, links } where `links` are absolute, unfiltered URL
 * strings (filtering is urlPolicy's job) and `text` is the visible body text:
 * words separated by single spaces, block elements separated by a newline.
 * The newline matters for phrase search: "Belgrade" in a heading followed by
 * "terminal" in the next paragraph must not count as "Belgrade terminal".
 *
 * With `contentOnly` (the default) menus, sidebars, footers and navigation
 * trees are left out of the text, so a word that sits in the menu of every
 * page does not turn every page into a match. Their links are still
 * followed. If nothing is left after that, the whole text is used.
 */

// Content a visitor never sees as text.
const SKIPPED_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'iframe', 'object', 'embed', 'svg']);

// Page furniture rather than page content.
const CHROME_SELECTOR = [
  'nav', 'aside',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]',
  '[role="menu"]', '[role="menubar"]', '[role="tree"]', '[role="search"]', '[role="tablist"]',
].join(', ');

// Where a page points to other pages: ordinary links, image maps, frames,
// plus <meta http-equiv="refresh"> (handled separately below).
const LINK_SOURCES = [
  ['a[href]', 'href'],
  ['area[href]', 'href'],
  ['frame[src]', 'src'],
  ['iframe[src]', 'src'],
];

// Elements that start on their own line in a browser. A line break is put
// around them so "<h1>Title</h1><p>Body</p>" becomes "Title\nBody", while
// inline tags keep words intact: "<b>W</b>ord" stays "Word".
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'button', 'caption', 'dd', 'details',
  'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'label', 'li', 'main', 'nav', 'ol',
  'option', 'p', 'pre', 'section', 'select', 'summary', 'table', 'tbody', 'td', 'textarea',
  'tfoot', 'th', 'thead', 'tr', 'ul',
]);

export function parsePage(html, pageUrl, { contentOnly = true } = {}) {
  const $ = cheerio.load(html);

  const title = collapseWhitespace($('title').first().text());
  const base = resolveBase($, pageUrl);

  const links = [];
  const addLink = (href) => {
    if (!href?.trim()) return;
    try {
      links.push(new URL(href.trim(), base).href);
    } catch {
      // unparsable href: ignore
    }
  };
  for (const [selector, attribute] of LINK_SOURCES) {
    $(selector).each((_, element) => addLink($(element).attr(attribute)));
  }
  $('meta[http-equiv]').each((_, element) => {
    if ($(element).attr('http-equiv').trim().toLowerCase() !== 'refresh') return;
    const target = /url\s*=\s*['"]?([^'"]+)/i.exec($(element).attr('content') ?? '')?.[1];
    addLink(target);
  });

  const root = () => $('body')[0] ?? $.root()[0];
  const fullText = visibleText(root());
  let text = fullText;
  if (contentOnly) {
    removeChrome($);
    text = visibleText(root()) || fullText;
  }

  return { title, text, links };
}

/** Honors <base href>, which changes how relative links resolve. */
function resolveBase($, pageUrl) {
  const baseHref = $('base[href]').first().attr('href');
  if (!baseHref) return pageUrl;
  try {
    return new URL(baseHref, pageUrl).href;
  } catch {
    return pageUrl;
  }
}

function removeChrome($) {
  $(CHROME_SELECTOR).remove();
  // A header or footer inside the content (an article's own header) stays; the page's does not.
  $('header, footer').each((_, element) => {
    if ($(element).closest('main, article, section').length === 0) $(element).remove();
  });
}

function visibleText(node) {
  const parts = [];
  collectVisibleText(node, parts);
  return joinBlocks(parts);
}

const BLOCK_BREAK = '\n';

function collectVisibleText(node, out) {
  for (const child of node.children ?? []) {
    if (child.type === 'text') {
      // Whitespace inside a text node, including source line breaks, is just spacing.
      out.push(child.data.replace(/\s+/g, ' '));
    } else if (child.children && !SKIPPED_TAGS.has(child.name)) {
      const isBlock = BLOCK_TAGS.has(child.name);
      if (isBlock) out.push(BLOCK_BREAK);
      collectVisibleText(child, out);
      if (isBlock) out.push(BLOCK_BREAK);
    }
  }
}

/** Single spaces between words, a single newline between blocks, nothing at the ends. */
function joinBlocks(parts) {
  return parts
    .join('')
    .replace(/ {2,}/g, ' ')
    .replace(/\s*\n\s*/g, BLOCK_BREAK)
    .trim();
}
