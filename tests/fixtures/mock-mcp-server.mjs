#!/usr/bin/env node
/**
 * 最小可用的 MCP server（stdio），只为测试协议桥接。
 * 暴露两个工具：echo(text) 和 add(a, b)。
 */
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
            capabilities: { tools: {} },
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
      default:
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
    }
  }
})
