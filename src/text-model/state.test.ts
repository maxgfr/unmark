import { expect, it } from 'vitest'
import { modelState, setModelState, subscribeModel } from './state.ts'

it('starts idle, notifies subscribers of every change and stops after unsubscribe', () => {
  expect(modelState()).toEqual({ phase: 'idle', detail: '' })
  const seen: string[] = []
  const stop = subscribeModel((state) => seen.push(`${state.phase}:${state.detail}`))
  setModelState({ phase: 'loading', detail: 'Fetching 3/18' })
  setModelState({ phase: 'ready', detail: '' })
  expect(modelState().phase).toBe('ready')
  stop()
  setModelState({ phase: 'idle', detail: '' })
  expect(seen).toEqual(['loading:Fetching 3/18', 'ready:'])
})
