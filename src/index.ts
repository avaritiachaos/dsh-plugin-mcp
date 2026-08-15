import { Context, Service, Schema } from 'cordis'
import { MCPStdioClient, MCPServerConfig, MCPToolDefinition } from './client.js'

export interface MCPPluginConfig {
  /** Map of MCP server definitions: serverName -> { command, args, env } */
  servers?: Record<string, MCPServerConfig>
}

export const MCPPluginConfig: Schema<MCPPluginConfig> = Schema.object({
  servers: Schema.dict(
    Schema.object({
      command: Schema.string().required(),
      args: Schema.array(Schema.string()).default([]),
      env: Schema.dict(Schema.string()).default({}),
    })
  ).default({}),
})

declare module 'cordis' {
  interface Context {
    mcp: MCPService
  }
}

/**
 * DeepSeek Harness Model Context Protocol (MCP) Service.
 * Connects external MCP servers and bridges them into DeepSeek agent tool space.
 */
export class MCPService extends Service<MCPPluginConfig> {
  private clients = new Map<string, MCPStdioClient>()
  private registeredTools = new Map<string, { server: string; definition: MCPToolDefinition }>()

  constructor(ctx: Context, config: MCPPluginConfig = {}) {
    super(ctx, 'mcp', true)
    this.config = config
  }

  protected async start(): Promise<void> {
    const servers = this.config.servers || {}
    for (const [name, serverConfig] of Object.entries(servers)) {
      try {
        const client = new MCPStdioClient(name, serverConfig)
        const { tools } = await client.connect()
        this.clients.set(name, client)

        for (const tool of tools) {
          const namespacedName = `mcp_${name}_${tool.name}`
          this.registeredTools.set(namespacedName, { server: name, definition: tool })
        }

        this.ctx.logger.info(`[dsh-plugin-mcp] Connected MCP server '${name}' with ${tools.length} tools.`)
      } catch (err) {
        this.ctx.logger.warn(`[dsh-plugin-mcp] Failed to connect MCP server '${name}': ${err}`)
      }
    }
  }

  protected stop(): void {
    for (const client of this.clients.values()) {
      client.disconnect()
    }
    this.clients.clear()
    this.registeredTools.clear()
  }

  /**
   * Execute an MCP tool by its namespaced name.
   */
  public async executeTool(toolName: string, args: Record<string, any> = {}): Promise<any> {
    const item = this.registeredTools.get(toolName)
    if (!item) {
      throw new Error(`MCP tool '${toolName}' not found`)
    }

    const client = this.clients.get(item.server)
    if (!client) {
      throw new Error(`MCP server '${item.server}' is disconnected`)
    }

    return client.callTool(item.definition.name, args)
  }

  /**
   * Get all registered MCP tool definitions for LLM tool schema injection.
   */
  public getToolSchemas(): Array<{ name: string; description?: string; parameters: any }> {
    return Array.from(this.registeredTools.entries()).map(([namespacedName, item]) => ({
      name: namespacedName,
      description: item.definition.description || `MCP tool provided by ${item.server}`,
      parameters: item.definition.inputSchema,
    }))
  }
}

export { MCPStdioClient, MCPServerConfig, MCPToolDefinition }

export default function apply(ctx: Context, config: MCPPluginConfig = {}) {
  ctx.plugin(MCPService, config)
}
