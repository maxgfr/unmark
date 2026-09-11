import { describe, expect, it } from 'vitest'
import { rewriteDocument } from './rewrite-document.ts'

const LONG = [
  'Sont pere étais tapissié du roi, mais le jeune homme na pas voulut suivre ces traces.',
  'Il préferais monter sur les planche et fair rire les gens devant un public nombreux.',
  'A vingt ans, il fonde une troupe qui sapelle Illustre, et elle joue dans toute la ville.',
].join('\n\n')

// Keyed on the section body: the document's blank lines are held aside by
// rewriteDocument and never reach the model.
const FIXED: Record<string, string> = {
  'Sont pere étais tapissié du roi, mais le jeune homme na pas voulut suivre ces traces.':
    "Son père était tapissier du roi, mais le jeune homme n'a pas voulu suivre ses traces.",
  'Il préferais monter sur les planche et fair rire les gens devant un public nombreux.':
    'Il préférait monter sur les planches et faire rire les gens devant un public nombreux.',
  'A vingt ans, il fonde une troupe qui sapelle Illustre, et elle joue dans toute la ville.':
    "À vingt ans, il fonde une troupe qui s'appelle Illustre, et elle joue dans toute la ville.",
}

/** A model that repairs whatever section it is handed, and records the sections. */
function repairing(seen: string[] = []) {
  return {
    seen,
    generate: async (prompt: string) => {
      const source = prompt.slice(prompt.lastIndexOf('Text:\n') + 'Text:\n'.length)
      seen.push(source)
      return FIXED[source] ?? source
    },
  }
}

const prompt = (text: string) => `Rewrite this.\n\nText:\n${text}`

describe('rewriteDocument', () => {
  it('cuts a long document into sections and repairs each one', async () => {
    const model = repairing()
    const outcome = await rewriteDocument(LONG, model.generate, {
      budget: 16,
      makePrompt: prompt,
    })
    expect(model.seen).toHaveLength(3)
    expect(outcome.kind).toBe('accepted')
    expect(outcome.text).toContain('Son père était tapissier')
    expect(outcome.text).toContain('Il préférait monter sur les planches')
    expect(outcome.text).toContain("s'appelle Illustre")
  })

  it('keeps the document shape, blank lines included', async () => {
    const model = repairing()
    const outcome = await rewriteDocument(LONG, model.generate, { budget: 16, makePrompt: prompt })
    expect(outcome.text.split('\n\n')).toHaveLength(3)
  })

  it('keeps a section the model could not repair, and says so', async () => {
    // The middle section comes back with a number that was never in it, which
    // the content checks refuse. The other two must still be repaired.
    const generate = async (p: string) => {
      const source = p.slice(p.lastIndexOf('Text:\n') + 'Text:\n'.length)
      if (source.includes('préferais')) return 'Il gagnait 400 euros par mois.'
      return FIXED[source] ?? source
    }
    const outcome = await rewriteDocument(LONG, generate, { budget: 16, makePrompt: prompt })
    expect(outcome.kind).toBe('accepted')
    expect(outcome.text).toContain('Son père était tapissier')
    expect(outcome.text).toContain('Il préferais monter sur les planche')
    expect(outcome.notes.join(' ')).toContain('2 of 3 sections')
  })

  it('reports a document where no section passed', async () => {
    const outcome = await rewriteDocument(LONG, async () => 'Sales reached 999 units.', {
      budget: 16,
      makePrompt: prompt,
    })
    expect(outcome.kind).toBe('rejected')
    expect(outcome.text).toBe(LONG)
    expect(outcome.notes[0]).toContain('No section of this text passed')
  })

  it('stops at once when the model becomes unavailable', async () => {
    let calls = 0
    const generate = async () => {
      calls += 1
      throw new Error('The local model stopped.')
    }
    const outcome = await rewriteDocument(LONG, generate, { budget: 16, makePrompt: prompt })
    expect(outcome.kind).toBe('unavailable')
    expect(calls).toBe(1)
  })

  it('leaves a short document to the ordinary loop', async () => {
    const model = repairing()
    const short = 'Sont pere étais tapissié du roi.'
    await rewriteDocument(short, model.generate, { makePrompt: prompt })
    expect(model.seen).toEqual([short])
  })
})
