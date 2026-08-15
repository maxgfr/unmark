#!/usr/bin/env node
// The entry Playwright's `webServer` starts. Serves `dist` and stays up.
import process from 'node:process'
import { serveDist } from './server.mjs'

const port = Number(process.argv[2] ?? 4179)
const server = await serveDist(port)
process.stdout.write(`serving dist at ${server.url}\n`)
