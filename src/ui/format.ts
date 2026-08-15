// The two things both tabs have to say about a file: how big it is, and what
// the download will be called.
//
// Both existed already, privately, in FilesTab. The Image tab needed them too,
// and the version it needed was not quite the version that was there — a byte
// formatter that stops at kB prints a twenty-megabyte PNG as `19532 kB`, which
// is the exact number the reader was trying not to have to work out.

/**
 * A byte count, at the precision the number deserves.
 *
 * A decimal while it helps and none once it does not: `1.4 kB` and `512 kB`
 * both read at a glance, `1.4 MB` and `19.4 MB` likewise, and `19532.7 kB`
 * reads as neither.
 */
export function formatBytes(count: number): string {
  if (count < 1024) return `${count} B`
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(count < 1024 * 100 ? 1 : 0)} kB`
  return `${(count / 1024 / 1024).toFixed(count < 1024 * 1024 * 100 ? 1 : 0)} MB`
}

/**
 * Prefix the download so the original is never silently overwritten.
 *
 * The extension is kept, because these are the original bytes: the file is the
 * one that arrived, minus its metadata, and renaming its type would be a lie
 * about what is inside it.
 */
export function cleanedName(original: string): string {
  const dot = original.lastIndexOf('.')
  return dot <= 0
    ? `${original}-unmarked`
    : `${original.slice(0, dot)}-unmarked${original.slice(dot)}`
}
