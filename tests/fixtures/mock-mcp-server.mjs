#!/usr/bin/env node
/**
 * 最小可用的 MCP server（stdio），只为测试协议桥接。
 *
 * 三块能力都实现：tools（echo / add）、resources（两个文件）、prompts（一个模板）。
 * 真实 server 常常只实现 tools，所以桥接层必须能容忍其余两项回 -32601——
 * 另一个 fixture 专门测那个（MOCK_MCP_TOOLS_ONLY=1）。
 */
const TOOLS_ONLY = process.env.MOCK_MCP_TOOLS_ONLY === '1'
let buf = ''

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl = buf.indexOf('\n')
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    nl = buf.indexOf('\n')
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }

    if (msg.id === undefined) continue // 通知

    switch (msg.method) {
      case 'initialize':
        send({
          jsonrpc: '2.0', id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: TOOLS_ONLY ? { tools: {} } : { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'mock-mcp', version: '0.0.1' },
          },
        })
        break
      case 'tools/list':
        send({
          jsonrpc: '2.0', id: msg.id,
          result: {
            tools: [
              { name: 'echo', description: 'echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
              { name: 'add', description: 'add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
            ],
          },
        })
        break
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params ?? {}
        let text = ''
        let isError = false
        if (name === 'echo') text = `echo: ${args.text ?? '(empty)'}`
        else if (name === 'add') text = String(Number(args.a) + Number(args.b))
        else { text = `unknown tool ${name}`; isError = true }
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError } })
        break
      }
      case 'resources/list': {
        if (TOOLS_ONLY) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no resources' } }); break }
        send({
          jsonrpc: '2.0', id: msg.id,
          result: {
            resources: [
              { uri: 'mock://readme', name: 'readme', mimeType: 'text/markdown' },
              { uri: 'mock://config', name: 'config', mimeType: 'application/json' },
            ],
          },
        })
        break
      }
      case 'resources/read': {
        const uri = msg.params?.uri
        const body = uri === 'mock://readme'
          ? '# mock readme\nthis came from an MCP resource'
          : uri === 'mock://config' ? '{"theme":"dark"}' : null
        if (body === null) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `no such resource ${uri}` } }); break }
        send({ jsonrpc: '2.0', id: msg.id, result: { contents: [{ uri, mimeType: 'text/plain', text: body }] } })
        break
      }
      case 'prompts/list': {
        if (TOOLS_ONLY) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no prompts' } }); break }
        send({
          jsonrpc: '2.0', id: msg.id,
          result: {
            prompts: [{
              name: 'review',
              description: 'review a diff',
              arguments: [{ name: 'target', description: 'what to review', required: true }],
            }],
          },
        })
        break
      }
      case 'prompts/get': {
        const { name, arguments: args = {} } = msg.params ?? {}
        if (name !== 'review') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `no such prompt ${name}` } }); break }
        send({
          jsonrpc: '2.0', id: msg.id,
          result: {
            description: 'review a diff',
            messages: [{ role: 'user', content: { type: 'text', text: `Please review ${args.target ?? '(nothing)'} carefully.` } }],
          },
        })
        break
      }
      default:
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
    }
  }
})
