// The PDF handler's front door.
//
// This directory was one file until the rebuild landed. The split is by stage,
// not by size: lex reads objects, xref says where they are, objects resolves
// the graph, write serialises it back, clean decides what to remove and
// whether it dares. Each stage is testable against the format alone, which is
// the only reason a PDF writer is a defensible thing to have written by hand.

import { startsWith } from '../types.ts'

export const sniffPdf = (bytes: Uint8Array): boolean => startsWith(bytes, [0x25, 0x50, 0x44, 0x46]) // %PDF

export { bytePass, cleanPdf, type PdfCleanOptions } from './clean.ts'
