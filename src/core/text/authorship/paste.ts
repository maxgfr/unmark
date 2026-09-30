// What a pasted text is, when there is no file name to go on.
//
// The page receives a paste, not a file. A block of HTML copied from a page's
// source reads as prose to the Markdown path: its tags are sealed as markup,
// but <p> boundaries are not paragraphs and <script> bodies are words. The
// command line knows the format from the file; the page has to look.

/**
 * Starts with a document, a block element, or what page source opens on — a
 * script, a style, a meta tag, a comment: markup, not prose with a bracket in
 * it. A copied page source rarely begins on its first paragraph.
 */
const HTML_START =
  /^\s*(?:<!--|<(?:!doctype\s+html|html|head|body|main|article|section|div|p|h[1-6]|ul|ol|li|table|blockquote|header|footer|nav|script|style|meta|link|title)\b[^>]{0,500}>)/iu

/** `HTML` for a pasted page or fragment of one, `Markdown` for everything else. */
export const formatOfPaste = (text: string): 'HTML' | 'Markdown' =>
  HTML_START.test(text) ? 'HTML' : 'Markdown'
