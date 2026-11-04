import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expandSeedUrls, expandUrlRange } from '../src/crawler/seedUrls.js';

describe('expandUrlRange', () => {
  it('returns a plain URL unchanged', () => {
    assert.deepEqual(expandUrlRange('https://x.com/a?b=c'), ['https://x.com/a?b=c']);
  });

  it('expands {from-to} and {from..to}', () => {
    assert.deepEqual(expandUrlRange('https://x.com/list?p={1-3}&s=100'), [
      'https://x.com/list?p=1&s=100',
      'https://x.com/list?p=2&s=100',
      'https://x.com/list?p=3&s=100',
    ]);
    assert.deepEqual(expandUrlRange('https://x.com/{8..10}'), ['https://x.com/8', 'https://x.com/9', 'https://x.com/10']);
  });

  it('keeps zero padding when the bounds have it', () => {
    assert.deepEqual(expandUrlRange('https://x.com/{09-11}'), ['https://x.com/09', 'https://x.com/10', 'https://x.com/11']);
  });

  it('combines several ranges', () => {
    assert.deepEqual(expandUrlRange('https://x.com/{1-2}/{1-2}'), [
      'https://x.com/1/1',
      'https://x.com/1/2',
      'https://x.com/2/1',
      'https://x.com/2/2',
    ]);
  });

  it('refuses backwards and oversized ranges', () => {
    assert.throws(() => expandUrlRange('https://x.com/{5-1}'), RangeError);
    assert.throws(() => expandUrlRange('https://x.com/{1-1000}', { max: 10 }), RangeError);
    assert.throws(() => expandUrlRange('https://x.com/{1-5}/{1-5}', { max: 10 }), RangeError);
  });
});

describe('expandSeedUrls', () => {
  it('expands every pattern and removes duplicates', () => {
    const urls = expandSeedUrls(['https://x.com/a', 'https://x.com/{1-2}', 'https://x.com/a']);
    assert.deepEqual(urls, ['https://x.com/a', 'https://x.com/1', 'https://x.com/2']);
  });

  it('caps the total', () => {
    assert.throws(() => expandSeedUrls(['https://x.com/{1-6}', 'https://x.com/{1-6}b'], { max: 10 }), RangeError);
  });

  it('replaces {phrase} with the URL-encoded search phrase', () => {
    const urls = expandSeedUrls(['https://x.com/search?q={phrase}&p={1-2}', 'https://x.com/{PHRASE}'], { phrase: 'věže Vítkovice' });
    assert.deepEqual(urls, [
      'https://x.com/search?q=v%C4%9B%C5%BEe%20V%C3%ADtkovice&p=1',
      'https://x.com/search?q=v%C4%9B%C5%BEe%20V%C3%ADtkovice&p=2',
      'https://x.com/v%C4%9B%C5%BEe%20V%C3%ADtkovice',
    ]);
  });
});
