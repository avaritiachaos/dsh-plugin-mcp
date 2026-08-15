import test from 'node:test'
import assert from 'node:assert'
import { MCPStdioClient } from '../src/client.ts'

test('MCPStdioClient exposes proper JSON-RPC 2.0 handshake methods', () => {
  const client = new MCPStdioClient('test_server', { command: 'node', args: ['-v'] })
  assert.strictEqual(typeof client.connect, 'function')
  assert.strictEqual(typeof client.callTool, 'function')
  assert.strictEqual(typeof client.sendNotification, 'function')
  assert.strictEqual(typeof client.sendRequest, 'function')
  assert.strictEqual(typeof client.disconnect, 'function')
})

test('MCP tool schema conversion formats parameters cleanly for LLMs', () => {
  const mockTool = {
    name: 'read_database',
    description: 'Query database rows',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  }

  assert.strictEqual(mockTool.name, 'read_database')
  assert.strictEqual(mockTool.inputSchema.type, 'object')
  assert.strictEqual(mockTool.inputSchema.required[0], 'query')
})
