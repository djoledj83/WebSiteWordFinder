import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findPhrase, findPhraseInPage } from '../src/matching/phraseMatcher.js';

describe('findPhrase', () => {
  it('counts case-insensitive occurrences by default', () => {
    const { count } = findPhrase('Belgrade terminal, belgrade TERMINAL and more', 'Belgrade Terminal');
    assert.equal(count, 2);
  });

  it('respects caseSensitive', () => {
    const { count } = findPhrase('Belgrade terminal, belgrade TERMINAL', 'Belgrade terminal', { caseSensitive: true });
    assert.equal(count, 1);
  });

  it('matches a phrase however the user spaced it', () => {
    assert.equal(findPhrase('a POS terminal here', '  POS    terminal ').count, 1);
  });

  it('does not match across block boundaries', () => {
    assert.equal(findPhrase('Belgrade\nterminal', 'Belgrade terminal').count, 0);
    assert.equal(findPhrase('Belgrade\nterminal', 'terminal').count, 1);
  });

  it('treats regex characters in the phrase literally', () => {
    assert.equal(findPhrase('price (EUR) is 10.5', '(EUR)').count, 1);
    assert.equal(findPhrase('price EUR is 10x5', '10.5').count, 0);
  });

  it('works with non-ASCII text', () => {
    assert.equal(findPhrase('Терминал у Београду', 'београду').count, 1);
    assert.equal(findPhrase('Čačak and Niš', 'ČAČAK').count, 1);
  });

  it('ignores accents by default, in the text and in the phrase', () => {
    const text = 'Doudleby - věže Vítkovice\nPlán cukrovaru, Vítkovické horní a hutní těžařstvo';
    const { count, snippets } = findPhrase(text, 'Vitkovice');
    assert.equal(count, 1);
    assert.deepEqual(snippets[0], { before: 'Doudleby - věže ', match: 'Vítkovice', after: ' Plán cukrovaru, Vítkovické horní a hutní těžařstvo' });
    assert.equal(findPhrase(text, 'vítkovické horní').count, 1);
    assert.equal(findPhrase(text, 'VEZE VITKOVICE').count, 1);
    assert.equal(findPhrase('Đurđevac, Niš, Łódź', 'durdevac').count, 1);
  });

  it('can be told to match accents exactly', () => {
    assert.equal(findPhrase('Vítkovice', 'Vitkovice', { ignoreAccents: false }).count, 0);
    assert.equal(findPhrase('Vítkovice', 'vítkovice', { ignoreAccents: false }).count, 1);
  });

  it('highlights the original spelling even when folding changes the length', () => {
    const { snippets } = findPhrase('Hauptstraße 12', 'hauptstrasse');
    assert.equal(snippets[0].match, 'Hauptstraße');
  });

  it('returns an empty result for an empty phrase', () => {
    assert.deepEqual(findPhrase('anything', '   '), { count: 0, snippets: [] });
  });

  it('builds snippets around the match, cut at word boundaries, on one line', () => {
    const text = 'one two three four five six seven\neight nine ten eleven twelve thirteen';
    const { count, snippets } = findPhrase(text, 'seven', { contextChars: 12 });
    assert.equal(count, 1);
    assert.equal(snippets.length, 1);
    const [snippet] = snippets;
    assert.equal(snippet.match, 'seven');
    assert.equal(snippet.before, '…five six ');
    assert.equal(snippet.after, ' eight nine…');
    assert.ok(!`${snippet.before}${snippet.after}`.includes('\n'));
  });

  it('limits the number of snippets but not the count', () => {
    const text = Array.from({ length: 10 }, (_, i) => `word ${i} belgrade`).join(' ');
    const { count, snippets } = findPhrase(text, 'belgrade', { maxSnippets: 3 });
    assert.equal(count, 10);
    assert.equal(snippets.length, 3);
  });

  it('marks truncation only when text was cut', () => {
    const { snippets } = findPhrase('short belgrade text', 'belgrade');
    assert.deepEqual(snippets[0], { before: 'short ', match: 'belgrade', after: ' text' });
  });
});

describe('findPhraseInPage', () => {
  it('counts title and body, taking snippets from the body', () => {
    const result = findPhraseInPage({ title: 'Belgrade office', text: 'Visit our Belgrade office today.' }, 'belgrade office');
    assert.equal(result.count, 2);
    assert.equal(result.inTitle, true);
    assert.deepEqual(result.snippets, [{ before: 'Visit our ', match: 'Belgrade office', after: ' today.' }]);
  });

  it('falls back to a title snippet when the body has no match', () => {
    const result = findPhraseInPage({ title: 'Belgrade office', text: 'Nothing here.' }, 'belgrade');
    assert.equal(result.count, 1);
    assert.deepEqual(result.snippets, [{ before: '', match: 'Belgrade', after: ' office' }]);
  });

  it('reports no match when neither contains the phrase', () => {
    assert.deepEqual(findPhraseInPage({ title: 'A', text: 'B' }, 'c'), { count: 0, snippets: [], inTitle: false });
  });
});
