import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { foldAccents, toOriginalRange } from '../src/lib/text.js';

describe('foldAccents', () => {
  it('leaves ASCII text alone without building offsets', () => {
    assert.deepEqual(foldAccents('plain text'), { folded: 'plain text', offsets: null });
  });

  it('strips accents from Czech, Serbian, Croatian, German and Polish letters', () => {
    assert.equal(foldAccents('Vítkovice Čačak Đurđevac Łódź Ærø straße').folded, 'Vitkovice Cacak Durdevac Lodz AEro strasse');
  });

  it('maps folded positions back to the original text', () => {
    const text = 'u Vítkovicích žije';
    const { folded, offsets } = foldAccents(text);
    assert.equal(folded, 'u Vitkovicich zije');
    const start = folded.indexOf('Vitkovicich');
    const [from, to] = toOriginalRange({ folded, offsets }, start, start + 'Vitkovicich'.length);
    assert.equal(text.slice(from, to), 'Vítkovicích');
  });

  it('keeps a whole character when a match ends inside its expansion', () => {
    const text = 'Straße Nr. 5';
    const fold = foldAccents(text);
    const [from, to] = toOriginalRange(fold, 0, 'Stras'.length); // "Stras" ends inside the "ss" that ß became
    assert.equal(text.slice(from, to), 'Straß');
  });
});
