/** Collapses every run of whitespace (including non-breaking spaces) to one space and trims. */
export function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Letters that Unicode does not decompose into base + accent but that users
// type without the stroke or ligature all the time.
const EXTRA_FOLDS = {
  đ: 'd', Đ: 'D', ł: 'l', Ł: 'L', ø: 'o', Ø: 'O', ı: 'i', ß: 'ss',
  æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE',
};

/**
 * Removes accents and strokes so that "Vítkovice" can be found by typing
 * "Vitkovice", "Čačak" by "Cacak", "Đurđevac" by "Durdevac".
 *
 * Returns { folded, offsets }: `offsets[i]` is the index in the original
 * text of the character that produced `folded[i]`, and
 * `offsets[folded.length]` is `text.length`, so a match found in `folded`
 * can be mapped back to the original text for highlighting. For plain
 * ASCII text `offsets` is null (the positions are identical).
 */
export function foldAccents(text) {
  if (!/[^\u0000-\u007f]/.test(text)) return { folded: text, offsets: null };

  let folded = '';
  const offsets = [];
  let position = 0;
  for (const char of text) {
    const base = char.charCodeAt(0) < 128 ? char : (EXTRA_FOLDS[char] ?? char.normalize('NFD').replace(/\p{M}+/gu, ''));
    for (let k = 0; k < base.length; k += 1) offsets.push(position);
    folded += base;
    position += char.length;
  }
  offsets.push(text.length);
  return { folded, offsets };
}

/** Maps a [start, end) range in a folded text back to the original text. */
export function toOriginalRange({ offsets, folded }, start, end) {
  if (!offsets) return [start, end];
  // if the match ends inside a character that folded to several letters ("ß" -> "ss"), keep the whole character
  let last = end;
  while (last < folded.length && offsets[last] === offsets[last - 1]) last += 1;
  return [offsets[start], offsets[last]];
}
