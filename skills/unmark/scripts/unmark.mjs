#!/usr/bin/env node
import process from "node:process";
//#region src/core/text/confusables.ts
var build = (entries) => new Map(entries);
var CYRILLIC = [
	[1072, "a"],
	[1077, "e"],
	[1086, "o"],
	[1088, "p"],
	[1089, "c"],
	[1091, "y"],
	[1093, "x"],
	[1109, "s"],
	[1110, "i"],
	[1112, "j"],
	[1211, "h"],
	[1029, "S"],
	[1030, "I"],
	[1032, "J"],
	[1040, "A"],
	[1042, "B"],
	[1045, "E"],
	[1050, "K"],
	[1052, "M"],
	[1053, "H"],
	[1054, "O"],
	[1056, "P"],
	[1057, "C"],
	[1058, "T"],
	[1059, "Y"],
	[1061, "X"],
	[1216, "I"]
];
var GREEK = [
	[945, "a"],
	[959, "o"],
	[957, "v"],
	[961, "p"],
	[913, "A"],
	[914, "B"],
	[917, "E"],
	[918, "Z"],
	[919, "H"],
	[921, "I"],
	[922, "K"],
	[924, "M"],
	[925, "N"],
	[927, "O"],
	[929, "P"],
	[932, "T"],
	[933, "Y"],
	[935, "X"]
];
var fullwidth = () => {
	const entries = [];
	for (let offset = 0; offset < 26; offset += 1) {
		entries.push([65313 + offset, String.fromCodePoint(65 + offset)]);
		entries.push([65345 + offset, String.fromCodePoint(97 + offset)]);
	}
	for (let digit = 0; digit < 10; digit += 1) entries.push([65296 + digit, String.fromCodePoint(48 + digit)]);
	return entries;
};
build([
	...CYRILLIC,
	...GREEK,
	...fullwidth()
]);
new TextDecoder("utf-8", { fatal: false });
//#endregion
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
