import { spawn, ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

export interface MCPToolDefinition {
  name: string
  description?: string
  inputSchema: Record<string, any>
}

export interface MCPServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

/**
 * Lightweight JSON-RPC 2.0 Stdio Client for Anthropic Model Context Protocol (MCP).
 */
export class MCPStdioClient extends EventEmitter {
  private process: ChildProcess | null = null
  private requestId = 0
  private pendingRequests = new Map<number | string, { resolve: (val: any) => void; reject: (err: any) => void }>()
  private buffer = ''

  constructor(private serverName: string, private config: MCPServerConfig) {
    super()
  }

  /**
   * Connect and initialize handshake with the MCP server subprocess.
   */
  public async connect(): Promise<{ tools: MCPToolDefinition[] }> {
    const env = { ...process.env, ...(this.config.env || {}) }

    this.process = spawn(this.config.command, this.config.args || [], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    })

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.handleData(chunk.toString('utf-8'))
    })

    this.process.on('error', (err) => {
      this.emit('error', err)
    })

    this.process.on('exit', (code) => {
      this.emit('close', code)
    })

    // 1. Send MCP initialize handshake
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'dsh-plugin-mcp', version: '0.1.0' },
    })

    // 2. Fetch list of available tools
    const toolsResult = await this.sendRequest('tools/list', {})
    const tools: MCPToolDefinition[] = toolsResult.tools || []

    return { tools }
  }

  /**
   * Call a tool on the MCP server.
   */
  public async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
    return this.sendRequest('tools/call', {
      name,
      arguments: args,
    })
  }

  /**
   * Send JSON-RPC request to subprocess stdin.
   */
  public sendRequest(method: string, params: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin) {
        return reject(new Error(`MCP server '${this.serverName}' is not connected`))
      }

      const id = ++this.requestId
      const message = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }

      this.pendingRequests.set(id, { resolve, reject })
      this.process.stdin.write(JSON.stringify(message) + '\n')
    })
  }

  public disconnect(): void {
    if (this.process) {
      this.process.kill()
      this.process = null
    }
  }

  private handleData(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const response = JSON.parse(trimmed)
        if (response.id !== undefined && this.pendingRequests.has(response.id)) {
          const { resolve, reject } = this.pendingRequests.get(response.id)!
          this.pendingRequests.delete(response.id)
          if (response.error) {
            reject(new Error(response.error.message || 'MCP JSON-RPC Error'))
          } else {
            resolve(response.result)
          }
        }
      } catch (err) {
        // Non-JSON line or incomplete chunk
      }
    }
  }
}
