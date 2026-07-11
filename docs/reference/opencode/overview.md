# OpenCode — 项目概述

## 是什么

OpenCode 是开源 AI 编码代理（Anthropic Claude Code 的开源替代品）。提供 CLI、TUI、HTTP Server、Web/Desktop 多种交互形态，支持 20+ LLM 提供商，内置完整的工具系统、插件系统、Agent 通信协议。

- **语言**: TypeScript 5.8 (strict mode)
- **运行时**: Bun 1.3+（主），Node.js 22+ 兼容
- **包管理**: Bun Workspaces（26 包 Monorepo）
- **任务编排**: Turborepo 2.10
- **CLI 框架**: yargs 18
- **终端 UI**: OpenTUI（Solid.js 驱动的自定义 TUI）
- **前端**: Solid.js 1.9 + Vite 7
- **桌面端**: Electron 42 + electron-vite
- **服务端**: Hono 4.10
- **核心架构**: Effect-TS 4.0.0-beta.83
- **ORM**: Drizzle ORM（SQLite）
- **AI SDK**: Vercel AI SDK v3 + 20+ 提供商集成
- **基础设施**: SST v4 (IaC)，Cloudflare Workers
- **规模**: 26 包，~数千文件

## 仓库地址

<https://github.com/anomalyco/opencode>

## 顶层目录结构

| 目录/文件 | 用途 |
|-----------|------|
| `packages/opencode/` | 主 CLI 应用（"opencode" 二进制） |
| `packages/cli/` | 轻量 CLI 包装器 |
| `packages/core/` | 共享核心库（模型、会话、工具、数据库等） |
| `packages/server/` | HTTP/WebSocket 服务器 |
| `packages/tui/` | Solid.js 终端的 TUI 框架 |
| `packages/ui/` | 共享 UI 组件库（Solid.js） |
| `packages/session-ui/` | 会话专属 UI 组件 |
| `packages/app/` | Web/Desktop App UI（Solid.js + Vite） |
| `packages/web/` | 官网/文档（Astro + Starlight + Solid.js） |
| `packages/desktop/` | Electron 桌面端 |
| `packages/plugin/` | 插件系统 / SDK |
| `packages/schema/` | 核心数据 Schema（Effect Schema） |
| `packages/protocol/` | 通信协议定义 |
| `packages/client/` | 自动生成 HTTP API 客户端 |
| `packages/sdk-next/` | 统一 SDK（组合 client + core + server） |
| `packages/sdk/` | 遗留 JS SDK |
| `packages/llm/` | LLM 提供商抽象层 |
| `packages/codemode/` | 沙箱代码执行引擎 |
| `packages/script/` | 构建/开发脚本 |
| `packages/enterprise/` | 企业部署配置 |
| `packages/function/` | Cloudflare Workers |
| `packages/console/` | 网页控制台（SolidStart + SST） |
| `packages/stats/` | 分析/统计服务 |
| `packages/slack/` | Slack Bot 集成 |
| `packages/http-recorder/` | HTTP 流量录制/回放 |
| `packages/httpapi-codegen/` | HTTP API 代码生成 |
| `packages/effect-drizzle-sqlite/` | Effect + Drizzle + SQLite 集成 |
| `packages/effect-sqlite-node/` | Effect 原生 SQLite 绑定 |
| `packages/storybook/` | UI 组件 Storybook |
| `infra/` | SST 基础设施定义 |
| `patches/` | 依赖补丁 |
| `script/` | 顶层脚本 |

## 技术栈全景

| 层 | 技术 |
|----|------|
| **语言** | TypeScript 5.8 strict |
| **运行时** | Bun 1.3+ (primary), Node.js 22+ |
| **核心架构** | Effect-TS 4.0.0-beta.83 (DI, 并发, 错误处理) |
| **CLI** | yargs 18 |
| **TUI** | OpenTUI (`@opentui/core`, `@opentui/solid`) |
| **前端** | Solid.js 1.9, Vite 7, Tailwind CSS v4 |
| **桌面** | Electron 42, electron-vite, electron-builder |
| **服务端** | Hono 4.10 |
| **ORM/数据库** | Drizzle ORM, SQLite (better-sqlite3 + libsql) |
| **AI SDK** | Vercel AI SDK v3 (`ai` package) |
| **LLM 提供商** | Anthropic, OpenAI, Google, AWS Bedrock, Azure, Mistral, Groq, Cohere, Perplexity, xAI, GitHub Copilot 等 20+ |
| **Schema** | Effect Schema, Zod |
| **IaC** | SST v4 (Cloudflare + AWS) |
| **代码智能** | tree-sitter, ripgrep, LSP |
| **测试** | Bun test, Playwright |
| **CI** | GitHub Actions |
| **认证** | OpenAuth.js |
| **可观测** | OpenTelemetry |
