// WebLLM also distributes a remote model catalogue and a TVM RPC socket
// transport. This product uses neither: remove the catalogue and disable RPC
// when bundling the pinned package, rather than exempting them from the gate.
export const localWebLlm = () => ({
  name: 'unmark:local-webllm',
  enforce: 'pre',
  transform(source, id) {
    if (!id.includes('/@mlc-ai/web-llm/lib/index.js')) return
    const catalogue = /^const prebuiltAppConfig = \{[\s\S]*?^\};/m
    const sockets = /return new WebSocket\(url\);/g
    if (!catalogue.test(source) || [...source.matchAll(sockets)].length !== 2) {
      throw new Error(
        'WebLLM layout changed. Review its catalogue and RPC transport before updating.',
      )
    }
    return {
      code: source
        .replace(catalogue, 'const prebuiltAppConfig = { model_list: [] };')
        .replace(sockets, 'throw new Error("Network sockets are disabled in unmark.");'),
      map: null,
    }
  },
})
