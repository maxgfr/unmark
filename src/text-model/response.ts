// WebLLM 0.2.85 prepends these tokens to message.content when enable_thinking is
// false. Remove exactly that transport header once; do not strip arbitrary tags
// or reasoning-looking passages from the user's document.
const NON_THINKING_HEADER = '<think>\n\n</think>\n\n'

export function modelText(content: string): string {
  return (
    content.startsWith(NON_THINKING_HEADER) ? content.slice(NON_THINKING_HEADER.length) : content
  ).trim()
}
