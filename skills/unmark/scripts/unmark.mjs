#!/usr/bin/env node
import process from "node:process";
//#region src/core/index.ts
var VERSION = "0.1.0";
//#endregion
//#region src/cli/unmark.ts
var USAGE = `unmark ${VERSION} — strip watermarks and provenance marks

USAGE
  unmark inspect <file|-> [--json]   report every mark found, change nothing
  unmark clean   <file|-> [--json]   strip what is removable, print the result
  unmark decode  <file|->            recover payloads hidden in invisible characters
  unmark audit   <dir>   [--json]    walk a tree and report every marked file

OPTIONS
  --json            machine-readable output
  --in-place        write the cleaned result back to the file (clean only)
  --paranoid        also strip emoji glue and script joiners; may alter real text
  --version, -V     print the version
  --help,    -h     print this

Pixel work — visible watermarks, inpainting, generator badges — needs a canvas
and a GPU, so it lives in the browser: https://maxgfr.github.io/unmark/
Nothing is uploaded there either.
`;
async function main(argv) {
	const args = [...argv];
	if (args.includes("--version") || args.includes("-V")) {
		process.stdout.write(`${VERSION}\n`);
		return 0;
	}
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		process.stdout.write(USAGE);
		return 0;
	}
	process.stderr.write(`unmark: unknown command "${args[0]}"\n\nRun \`unmark --help\`.\n`);
	return 2;
}
process.exitCode = await main(process.argv.slice(2));
//#endregion
export { main };
