// Characters that look like Latin letters and are not.
//
// Keyed by codepoint number rather than by literal, because a table of
// homoglyphs written as literals is unreviewable by construction: the whole
// point of the entries is that they are indistinguishable from the values they
// map to. `[0x0430, 'a']` can be checked against the Unicode charts; `['а','a']`
// cannot be checked against anything.
//
// Deliberately narrow. This maps the lookalikes actually used in spoofing —
// Cyrillic, Greek and fullwidth forms of ASCII letters — and nothing else.
// A "complete" confusables table is thousands of entries deep and mangles
// legitimate text far more often than it catches a mark.

const build = (entries: [number, string][]): Map<number, string> => new Map(entries)

const CYRILLIC: [number, string][] = [
  [0x0430, 'a'],
  [0x0435, 'e'],
  [0x043e, 'o'],
  [0x0440, 'p'],
  [0x0441, 'c'],
  [0x0443, 'y'],
  [0x0445, 'x'],
  [0x0455, 's'],
  [0x0456, 'i'],
  [0x0458, 'j'],
  [0x04bb, 'h'],
  [0x0405, 'S'],
  [0x0406, 'I'],
  [0x0408, 'J'],
  [0x0410, 'A'],
  [0x0412, 'B'],
  [0x0415, 'E'],
  [0x041a, 'K'],
  [0x041c, 'M'],
  [0x041d, 'H'],
  [0x041e, 'O'],
  [0x0420, 'P'],
  [0x0421, 'C'],
  [0x0422, 'T'],
  [0x0423, 'Y'],
  [0x0425, 'X'],
  [0x04c0, 'I'],
]

const GREEK: [number, string][] = [
  [0x03b1, 'a'],
  [0x03bf, 'o'],
  [0x03bd, 'v'],
  [0x03c1, 'p'],
  [0x0391, 'A'],
  [0x0392, 'B'],
  [0x0395, 'E'],
  [0x0396, 'Z'],
  [0x0397, 'H'],
  [0x0399, 'I'],
  [0x039a, 'K'],
  [0x039c, 'M'],
  [0x039d, 'N'],
  [0x039f, 'O'],
  [0x03a1, 'P'],
  [0x03a4, 'T'],
  [0x03a5, 'Y'],
  [0x03a7, 'X'],
]

// Fullwidth forms are a contiguous run, so they are generated rather than typed.
const fullwidth = (): [number, string][] => {
  const entries: [number, string][] = []
  for (let offset = 0; offset < 26; offset += 1) {
    entries.push([0xff21 + offset, String.fromCodePoint(0x41 + offset)])
    entries.push([0xff41 + offset, String.fromCodePoint(0x61 + offset)])
  }
  for (let digit = 0; digit < 10; digit += 1) {
    entries.push([0xff10 + digit, String.fromCodePoint(0x30 + digit)])
  }
  return entries
}

export const CONFUSABLES: ReadonlyMap<number, string> = build([
  ...CYRILLIC,
  ...GREEK,
  ...fullwidth(),
])
