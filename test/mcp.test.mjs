import test from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { Context } from 'cordis'
import { MCPStdioClient, MCPService, MCPPluginConfig, namespaceToolName } from '../dist/index.js'

const SERVER_SCRIPT = `import readline from 'node:readline'
import * as fs from 'node:fs'
const mode = process.argv[2] || 'normal'
const flag = process.argv[3] || ''
console.log('server booted') // non-JSON line: must not crash the client
const rl = readline.createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'test-server', version: '1.0.0' } } })
    send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hello' } })
  } else if (msg.method === 'notifications/initialized') {
    // ignore
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'slow', description: 'never responds', inputSchema: { type: 'object' } },
      { name: 'crash', description: 'exits process', inputSchema: { type: 'object' } },
    ] } })
  } else if (msg.method === 'tools/call') {
    if (msg.params.name === 'slow') return
    if (msg.params.name === 'crash') process.exit(3)
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(msg.params.arguments) }] } })
  }
})
if (mode === 'spawn-child') {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{require("fs").writeFileSync(' + JSON.stringify(flag) + ',"alive")},1500)'], { stdio: 'ignore' })
  child.unref()
}
`

let scriptCounter = 0
async function writeServerScript(t, mode, flag) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-mcp-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, `server-${++scriptCounter}.mjs`)
  await fs.writeFile(file, SERVER_SCRIPT, 'utf-8')
  return { command: process.execPath, args: [file, mode, flag || ''] }
}

function makeConfig(command, args, requestTimeoutMs) {
  return { command, args, requestTimeoutMs }
}

test('MCPStdioClient performs handshake, lists tools and calls tools (M22)', async (t) => {
  const { command, args } = await writeServerScript(t, 'normal')
  const client = new MCPStdioClient('test', makeConfig(command, args, 5000))

  const notifications = []
  const protocolErrors = []
  client.on('notification', (m) => notifications.push(m))
  client.on('protocol-error', (e) => protocolErrors.push(e))

  const { tools } = await client.connect()
  assert.strictEqual(tools.length, 3)
  assert.ok(tools.some((x) => x.name === 'echo'))

  const result = await client.callTool('echo', { text: 'hi' })
  assert.deepStrictEqual(result.content[0].text, JSON.stringify({ text: 'hi' }))

  // server-side notification surfaced (M20)
  assert.ok(notifications.some((n) => n.method === 'notifications/message'))
  // non-JSON boot line surfaced, not fatal (M20)
  assert.ok(protocolErrors.length > 0)
  assert.match(protocolErrors[0].message, /Non-JSON/)

  client.disconnect()
})

test('MCPStdioClient rejects pending requests on server crash (M18/M20)', async (t) => {
  const { command, args } = await writeServerScript(t, 'normal')
  const client = new MCPStdioClient('test', makeConfig(command, args, 5000))
  await client.connect()

  await assert.rejects(client.callTool('crash', {}), /exited with code 3/)
  client.disconnect()
})

test('MCPStdioClient enforces per-request timeout (M21)', async (t) => {
  const { command, args } = await writeServerScript(t, 'normal')
  const client = new MCPStdioClient('test', makeConfig(command, args, 400))
  await client.connect()
  await assert.rejects(client.callTool('slow', {}), /timed out after 400ms/)
  client.disconnect()
})

test('MCPStdioClient disconnect kills the whole process tree (M18)', async (t) => {
  const flag = path.join(os.tmpdir(), `dsh-mcp-flag-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  t.after(() => fs.rm(flag, { force: true }))
  const { command, args } = await writeServerScript(t, 'spawn-child', flag)
  const client = new MCPStdioClient('test', makeConfig(command, args, 5000))
  await client.connect()
  client.disconnect()
  // the grandchild would write the flag after 1.5s if the tree kill failed
  await new Promise((r) => setTimeout(r, 2200))
  await assert.rejects(fs.access(flag), /ENOENT|no such file/, 'grandchild survived the tree kill')
})

test('namespaceToolName cannot collide across server/tool name splits (M19)', () => {
  const a = namespaceToolName('a_b', 'c')
  const b = namespaceToolName('a', 'b_c')
  assert.notStrictEqual(a, b)
  assert.strictEqual(a, 'mcp_a%5Fb_c')
  assert.strictEqual(b, 'mcp_a_b%5Fc')
  // percent signs are escaped first
  assert.strictEqual(namespaceToolName('a%2Fb', 'x'), 'mcp_a%252Fb_x')
})

test('MCPService registers namespaced tools and cleans up after server crash (M18/M19)', async (t) => {
  const { command, args } = await writeServerScript(t, 'normal')
  const svc = new MCPService(new Context(), {
    servers: {
      a_b: makeConfig(command, args, 5000),
      a: makeConfig(command, args, 5000),
    },
  })
  await svc.start()

  const schemas = svc.getToolSchemas()
  assert.strictEqual(schemas.length, 6) // 2 servers x 3 tools, none overwritten
  const names = schemas.map((s) => s.name)
  assert.ok(names.includes('mcp_a%5Fb_echo'))
  assert.ok(names.includes('mcp_a_echo'))
  assert.strictEqual(new Set(names).size, 6)

  // crash one server: its tools must disappear from the registry (M18)
  await assert.rejects(svc.executeTool('mcp_a_crash', {}), /exited with code 3/)
  await new Promise((r) => setTimeout(r, 100)) // let close handler run
  await assert.rejects(svc.executeTool('mcp_a_echo', {}), /not found/)
  assert.strictEqual(svc.getToolSchemas().length, 3) // only server a_b remains

  svc.stop()
})

test('MCPPluginConfig applies defaults and rejects invalid values', () => {
  const defaults = MCPPluginConfig({})
  assert.deepStrictEqual(defaults.servers, {})
  const withServer = MCPPluginConfig({ servers: { s: { command: 'node' } } })
  assert.strictEqual(withServer.servers.s.requestTimeoutMs, 30000)
  assert.throws(() => MCPPluginConfig({ servers: { s: { command: 123 } } }))
})
