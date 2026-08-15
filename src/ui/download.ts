// Handing a file back to the browser, once, correctly.
//
// Both tabs used to do this inline, and both did it the way that only works in
// Chromium:
//
//   const url = URL.createObjectURL(blob)
//   const anchor = document.createElement('a')
//   anchor.href = url
//   anchor.download = name
//   anchor.click()
//   URL.revokeObjectURL(url)     // <- the bug
//
// The revoke runs in the same task as the click. Chromium has already taken a
// reference to the blob by then; WebKit and Firefox have not, and the download
// arrives empty or not at all. The anchor is also never in the document, which
// some engines require before they will treat a click as a user-initiated
// navigation.
//
// Both are fixed here rather than twice, badly, in two components.

/** Save a blob to the visitor's disk under `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'

  document.body.append(anchor)
  anchor.click()
  anchor.remove()

  // A macrotask later, so the engine has had its turn to read the blob. The
  // URL is still revoked — leaving it alive would pin the whole file in memory
  // for the life of the tab, and a 40 MP image is not a small leak.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
