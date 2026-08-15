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
  requestTimeoutMs?: number
}

/**
 * Robust JSON-RPC 2.0 Stdio Client for Anthropic Model Context Protocol (MCP).
 */
export class MCPStdioClient extends EventEmitter {
  private serverName: string
  private config: MCPServerConfig
  private process: ChildProcess | null = null
  private requestId = 0
  private pendingRequests = new Map<number | string, { resolve: (val: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout }>()
  private buffer = ''
  private utf8Decoder = new TextDecoder('utf-8', { fatal: false })
  private isConnected = false

  constructor(serverName: string, config: MCPServerConfig) {
    super()
    this.serverName = serverName
    this.config = config
  }

  /**
   * Connect and perform full 2-way MCP handshake with the server subprocess.
   */
  public async connect(): Promise<{ tools: MCPToolDefinition[] }> {
    const env = { ...process.env, ...(this.config.env || {}) }
    let cmd = this.config.command

    // Resolve Windows npm/npx/uvx .cmd extension if on Windows
    if (process.platform === 'win32' && !cmd.endsWith('.cmd') && !cmd.endsWith('.exe') && !cmd.includes('\\') && !cmd.includes('/')) {
      if (['npx', 'npm', 'uvx', 'yarn', 'pnpm'].includes(cmd)) {
        cmd = `${cmd}.cmd`
      }
    }

    return new Promise((resolve, reject) => {
      let initTimer: NodeJS.Timeout | null = setTimeout(() => {
        this.disconnect()
        reject(new Error(`Connection to MCP server '${this.serverName}' timed out after 15s.`))
      }, 15000)

      try {
        this.process = spawn(cmd, this.config.args || [], {
          env,
          stdio: ['pipe', 'pipe', 'inherit'],
          windowsHide: true,
        })
      } catch (err: any) {
        if (initTimer) clearTimeout(initTimer)
        return reject(new Error(`Failed to spawn MCP server '${this.serverName}': ${err.message}`))
      }

      this.process.stdout?.on('data', (chunk: Uint8Array) => {
        const text = this.utf8Decoder.decode(chunk, { stream: true })
        this.handleData(text)
      })

      this.process.on('error', (err) => {
        this.handleProcessTermination(new Error(`MCP server '${this.serverName}' process error: ${err.message}`))
      })

      this.process.on('exit', (code) => {
        this.handleProcessTermination(new Error(`MCP server '${this.serverName}' exited with code ${code}`))
      })

      // Run handshake sequence
      this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'dsh-plugin-mcp', version: '0.1.0' },
      })
        .then(async () => {
          // Standard MCP Step 2: Send initialized notification
          await this.sendNotification('notifications/initialized', {})

          // Standard MCP Step 3: Fetch list of tools
          const toolsResult = await this.sendRequest('tools/list', {})
          const tools: MCPToolDefinition[] = Array.isArray(toolsResult?.tools) ? toolsResult.tools : []
          this.isConnected = true
          if (initTimer) clearTimeout(initTimer)
          resolve({ tools })
        })
        .catch((err) => {
          if (initTimer) clearTimeout(initTimer)
          this.disconnect()
          reject(err)
        })
    })
  }

  /**
   * Call an MCP tool with timeout protection.
   */
  public async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
    if (!this.isConnected) {
      throw new Error(`Cannot call tool '${name}': MCP server '${this.serverName}' is not connected.`)
    }
    return this.sendRequest('tools/call', {
      name,
      arguments: args,
    })
  }

  /**
   * Send JSON-RPC notification (no response expected, no ID).
   */
  public sendNotification(method: string, params: Record<string, any> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin || this.process.stdin.destroyed) {
        return reject(new Error(`MCP server '${this.serverName}' stdin is not writable.`))
      }
      const message = {
        jsonrpc: '2.0',
        method,
        params,
      }
      this.process.stdin.write(JSON.stringify(message) + '\n', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  /**
   * Send JSON-RPC request with per-request timeout.
   */
  public sendRequest(method: string, params: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin || this.process.stdin.destroyed) {
        return reject(new Error(`MCP server '${this.serverName}' is not connected`))
      }

      const id = ++this.requestId
      const timeoutMs = this.config.requestTimeoutMs || 30000

      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error(`MCP request '${method}' (id: ${id}) to '${this.serverName}' timed out after ${timeoutMs}ms.`))
        }
      }, timeoutMs)

      const message = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }

      this.pendingRequests.set(id, { resolve, reject, timer })
      this.process.stdin.write(JSON.stringify(message) + '\n', (err) => {
        if (err) {
          clearTimeout(timer)
          this.pendingRequests.delete(id)
          reject(err)
        }
      })
    })
  }

  public disconnect(): void {
    this.isConnected = false
    this.handleProcessTermination(new Error('Client disconnected.'))
    if (this.process) {
      try {
        this.process.kill()
      } catch {}
      this.process = null
    }
  }

  private handleProcessTermination(err: Error): void {
    this.isConnected = false
    for (const [, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer)
      req.reject(err)
    }
    this.pendingRequests.clear()
    this.emit('close', err)
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
        if (response && response.id !== undefined && this.pendingRequests.has(response.id)) {
          const { resolve, reject, timer } = this.pendingRequests.get(response.id)!
          clearTimeout(timer)
          this.pendingRequests.delete(response.id)
          if (response.error) {
            reject(new Error(response.error.message || `MCP JSON-RPC Error (${response.error.code})`))
          } else {
            resolve(response.result)
          }
        }
      } catch {
        // Incomplete line or non-JSON log
      }
    }
  }
}
