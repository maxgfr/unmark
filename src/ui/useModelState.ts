import { useSyncExternalStore } from 'react'
import { modelState, subscribeModel, type ModelState } from '../text-model/state.ts'

/** The shared model phase, live. */
export function useModelState(): ModelState {
  return useSyncExternalStore(subscribeModel, modelState, modelState)
}
