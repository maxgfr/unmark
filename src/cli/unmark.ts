// The executable entry point, kept to two lines on purpose.
//
// Everything else lives in main.ts, which has no side effects on import — so
// the tests can call main() directly instead of shelling out, and a stray
// `import` of the CLI cannot set an exit code on whoever imported it.

import process from 'node:process'
import { main } from './main.ts'

process.exitCode = await main(process.argv.slice(2))
