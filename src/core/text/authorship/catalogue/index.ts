// Every catalogue, as one list the detector walks.

import { EN } from './en.ts'
import { FR } from './fr.ts'
import type { Pattern } from './types.ts'

export { matchesOf, GUARD_WINDOW } from './types.ts'
export type { Category, Pattern, Tier } from './types.ts'

export const CATALOGUE: readonly Pattern[] = [...EN, ...FR]
