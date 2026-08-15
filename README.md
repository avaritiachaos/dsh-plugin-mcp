# @shion-lab/dsh-plugin-mcp

[![npm version](https://img.shields.io/npm/v/@shion-lab/dsh-plugin-mcp.svg)](https://www.npmjs.com/package/@shion-lab/dsh-plugin-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Anthropic Model Context Protocol (MCP) client bridge plugin for DeepSeek Harness (`dsh`).**

---

## 🌟 Why `dsh-plugin-mcp`?

Connects any standard MCP server (GitHub, SQLite, Brave Search, Puppeteer, PostgreSQL) directly into the DeepSeek Harness tool calling ecosystem over Stdio JSON-RPC 2.0.

---

## 📦 Installation & Usage

```bash
npm install -g @shion-lab/dsh-plugin-mcp
```

In `cordis.yml`:

```yaml
plugins:
  "@deepseek-ai/dsh": {}
  "@shion-lab/dsh-plugin-mcp":
    servers:
      github:
        command: "npx"
        args: ["-y", "@modelcontextprotocol/server-github"]
        env:
          GITHUB_PERSONAL_ACCESS_TOKEN: "your_token"
      sqlite:
        command: "uvx"
        args: ["mcp-server-sqlite", "--db-path", "./test.db"]
```

---

## 📄 License

MIT © [Shion Lab](https://github.com/shion-lab)
