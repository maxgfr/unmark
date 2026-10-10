// Every catalogue, as one list the detector walks.

import { EN } from './en.ts'
import { FR } from './fr.ts'
import { HEDGING } from './hedging.ts'
import { FORENSIC_PATTERNS } from '../forensics.ts'
import type { Pattern } from './types.ts'

export { applies, matchesOf, GUARD_WINDOW, UNWEIGHTED } from './types.ts'
export type { Category, Pattern, Tier } from './types.ts'
export { ACADEMIC } from './academic.ts'

export const CATALOGUE: readonly Pattern[] = [...EN, ...FR, ...HEDGING, ...FORENSIC_PATTERNS]
