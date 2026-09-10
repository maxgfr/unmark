// Did a short rewrite correct the text, or replace it?
//
// On a short line, statistical language detection is not good enough to be the
// only thing standing between a correction and a translation. "Hello ça dit
// quoi wsh ?" is read as Polish with maximum confidence, and the model, asked
// to write Polish, returned "Chy jest co wiesz wsh?" — which the language gate
// then compared Polish against Polish and approved. Every layer agreed, and
// every layer was reading the same wrong verdict.
//
// This check does not ask what language anything is in. It asks whether the
// words of the source survived, which is the difference between correcting a
// sentence and writing a different one:
//
//   "Nous avons préparer le dossier" → "Nous avons préparé le dossier"
//        seven of eight words survive; two characters changed
//
//   "Hello ça dit quoi wsh ?" → "Chy jest co wiesz wsh?"
//        one of five survives; the sentence was replaced
//
// It is deliberately scoped to short text. A long document is exactly where
// language detection becomes reliable, and also where a heavy rewrite is the
// point of the feature rather than a symptom — rejecting one there would break
// what Deep and Ultra exist to do.

/** Words above this count are long enough for the language gate to do the work. */
const SHORT_WORDS = 12
/**
 * Below this, survival says nothing. A three-word greeting has no majority to
 * lose: "bonjour c cool" becoming "Salut, cool." keeps one word out of three
 * and is still an ordinary rewrite, not a replacement.
 */
const MIN_WORDS = 4
/** At least this share of the source's words must still be there. */
const SURVIVAL = 0.5

/**
 * Comparable word forms: lowercased, accents removed, punctuation dropped.
 *
 * Folding accents is what lets a correction pass. "sa" becoming "ça" is the
 * repair being asked for, and it must count as the same word surviving, not as
 * one word lost and another invented.
 */
export function wordForms(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/**
 * A rejection reason when a short rewrite replaced the text, else nothing.
 *
 * Nothing is not an endorsement: a long text is not examined here at all, and
 * a short one that keeps its words may still have been mangled in ways only a
 * reader can see.
 */
export function replacedShortText(original: string, candidate: string): string | undefined {
  const before = wordForms(original)
  if (before.length < MIN_WORDS || before.length > SHORT_WORDS) return
  const pool = new Set(wordForms(candidate))
  const kept = before.filter((word) => pool.has(word)).length
  if (kept >= Math.ceil(before.length * SURVIVAL)) return
  return `only ${kept} of ${before.length} words from the source survived`
}
