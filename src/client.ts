import { spawn, execFile, ChildProcess } from 'node:child_process'
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

const DEFAULT_CONNECT_TIMEOUT_MS = 15000
const DEFAULT_REQUEST_TIMEOUT_MS = 30000

/**
 * Robust JSON-RPC 2.0 Stdio Client for Anthropic Model Context Protocol (MCP).
 *
 * Lifecycle guarantees:
 * - the server subprocess is spawned detached (POSIX) so the whole process
 *   group can be terminated on disconnect (M18);
 * - stdin errors, synchronous write failures, and process exit all reject
 *   every pending request exactly once;
 * - reconnects reset the streaming decoder and line buffer;
 * - server-side notifications/requests are surfaced as events instead of
 *   being dropped silently (M20).
 */
export class MCPStdioClient extends EventEmitter {
  private serverName: string
  private config: MCPServerConfig
  private process: ChildProcess | null = null
  private requestId = 0
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout }>()
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
        reject(new Error(`Connection to MCP server '${this.serverName}' timed out after ${DEFAULT_CONNECT_TIMEOUT_MS}ms.`))
      }, DEFAULT_CONNECT_TIMEOUT_MS)

      // Reconnect hygiene: reset streaming decoder state and partial line buffer (M20).
      this.buffer = ''
      this.utf8Decoder = new TextDecoder('utf-8', { fatal: false })
      this.pendingRequests.clear()

      try {
        this.process = spawn(cmd, this.config.args || [], {
          env,
          stdio: ['pipe', 'pipe', 'inherit'],
          windowsHide: true,
          // POSIX: own process group so disconnect() can kill the whole tree.
          detached: process.platform !== 'win32',
        })
      } catch (err: any) {
        if (initTimer) clearTimeout(initTimer)
        return reject(new Error(`Failed to spawn MCP server '${this.serverName}': ${err.message}`))
      }

      this.process.stdin?.on('error', (err) => {
        // e.g. EPIPE when the server died; surface as a termination (M20).
        this.handleProcessTermination(new Error(`MCP server '${this.serverName}' stdin error: ${err.message}`))
      })

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
    const stdin = this.process?.stdin
    if (!this.process || !stdin || stdin.destroyed) {
      return Promise.reject(new Error(`MCP server '${this.serverName}' stdin is not writable.`))
    }
    const message = {
      jsonrpc: '2.0',
      method,
      params,
    }
    return new Promise((resolve, reject) => {
      try {
        stdin.write(JSON.stringify(message) + '\n', (err) => {
          if (err) reject(err)
          else resolve()
        })
      } catch (err) {
        reject(err) // synchronous write failure (EPIPE etc., M20)
      }
    })
  }

  /**
   * Send JSON-RPC request with per-request timeout.
   */
  public sendRequest(method: string, params: Record<string, any>): Promise<any> {
    const stdin = this.process?.stdin
    if (!this.process || !stdin || stdin.destroyed) {
      return Promise.reject(new Error(`MCP server '${this.serverName}' is not connected`))
    }

    const id = ++this.requestId
    const timeoutMs = this.config.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS

    return new Promise((resolve, reject) => {
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
      try {
        stdin.write(JSON.stringify(message) + '\n', (err) => {
          if (err) {
            clearTimeout(timer)
            this.pendingRequests.delete(id)
            reject(err)
          }
        })
      } catch (err) {
        // Synchronous write failure: never leave the request pending (M20).
        clearTimeout(timer)
        this.pendingRequests.delete(id)
        reject(err as Error)
      }
    })
  }

  /**
   * Disconnect from the server, killing the ENTIRE process tree
   * (taskkill /T on Windows, process-group kill on POSIX) so no orphan
   * grandchildren are left behind (M18).
   */
  public disconnect(): void {
    this.isConnected = false
    const child = this.process
    if (child) {
      if (child.pid) {
        if (process.platform === 'win32') {
          try {
            execFile('taskkill', ['/F', '/T', '/PID', String(child.pid)], () => {
              // fall through; child.kill below is the second attempt
            })
          } catch {
            /* taskkill unavailable */
          }
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL') // whole process group
          } catch {
            /* already gone */
          }
        }
      }
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      this.process = null
    }
    this.handleProcessTermination(new Error('Client disconnected.'))
  }

  /**
   * Fail every pending request exactly once and surface the close event.
   */
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
      let message: any
      try {
        message = JSON.parse(trimmed)
      } catch {
        // Non-JSON output (server logging to stdout): surface, don't crash (M20).
        this.emit('protocol-error', new Error(`Non-JSON line from MCP server '${this.serverName}': ${trimmed.slice(0, 200)}`))
        continue
      }

      if (message && message.id !== undefined) {
        // Response to one of our requests.
        const pending = this.pendingRequests.get(message.id)
        if (pending) {
          const { resolve, reject, timer } = pending
          clearTimeout(timer)
          this.pendingRequests.delete(message.id)
          if (message.error) {
            reject(new Error(message.error.message || `MCP JSON-RPC Error (${message.error.code})`))
          } else {
            resolve(message.result)
          }
        } else {
          // A response whose request already timed out, OR a server->client
          // request (the server is calling us): surface it (M20).
          if (message.method) {
            this.emit('request', message)
          } else {
            this.emit('protocol-error', new Error(`Unexpected response id ${message.id} from '${this.serverName}'.`))
          }
        }
      } else if (message && message.method) {
        // Server-side notification (no id): surface it (M20).
        this.emit('notification', message)
      } else {
        this.emit('protocol-error', new Error(`Malformed JSON-RPC message from '${this.serverName}'.`))
      }
    }
  }
}
