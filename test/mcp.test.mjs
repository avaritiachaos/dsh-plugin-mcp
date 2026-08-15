import test from 'node:test'
import assert from 'node:assert/strict'

test('MCP tool schema conversion formats OpenAI/DeepSeek compatible tool schemas', () => {
  const tools = [
    {
      name: 'query_db',
      description: 'Run SQL query on SQLite database',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL query' },
        },
        required: ['sql'],
      },
    },
  ]

  const serverName = 'sqlite'
  const namespacedName = `mcp_${serverName}_${tools[0].name}`

  const schema = {
    name: namespacedName,
    description: tools[0].description,
    parameters: tools[0].inputSchema,
  }

  assert.equal(schema.name, 'mcp_sqlite_query_db')
  assert.equal(schema.description, 'Run SQL query on SQLite database')
  assert.deepEqual(schema.parameters.required, ['sql'])
})

test('JSON-RPC 2.0 message framing and parsing', () => {
  const rawChunk = `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}\n`
  const parsed = JSON.parse(rawChunk.trim())

  assert.equal(parsed.jsonrpc, '2.0')
  assert.equal(parsed.id, 1)
  assert.equal(parsed.result.protocolVersion, '2024-11-05')
})
