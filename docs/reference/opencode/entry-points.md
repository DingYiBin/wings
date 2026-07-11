# OpenCode — 入口点与流程

## 二进制入口

```
packages/opencode/bin/opencode (Node.js 包装脚本)
```

包装脚本执行流程：
1. 检测当前平台（darwin/linux/windows）和架构（x64/arm64）
2. 检查 CPU 是否支持 AVX2（影响二进制选择）
3. 在 `node_modules` 中查找对应平台包（如 `opencode-darwin-arm64`）
4. 获取原生二进制路径
5. 生成子进程执行原生二进制
6. 转发信号（SIGINT、SIGTERM 等）

## CLI 入口（yargs）

**源文件**: `packages/opencode/src/index.ts`

yargs 18 注册 ~20 个命令：

| 命令 | 用途 |
|------|------|
| `run` | 主交互式编码会话（默认流程） |
| `serve` | 启动 HTTP 服务器 |
| `mcp` | MCP（Model Context Protocol）模式 |
| `acp` | ACP（Agent Communication Protocol）模式 |
| `generate` | 根据指令生成代码 |
| `agent` | 作为子代理运行 |
| `debug` | 调试命令（config, LSP, ripgrep） |
| `upgrade` | 自更新 |
| `uninstall` | 卸载 |
| `models` | 列出可用模型 |
| `providers` | 列出可用提供商 |
| `account` | 账户管理 |
| `github` | GitHub 集成 |
| `pr` | Pull Request 操作 |
| `export` | 导出会话 |
| `import` | 导入会话 |
| `session` | 会话管理 |
| `web` | 启动 Web 界面 |
| `tui` | TUI 线程命令 |
| `attach` | 附加到运行中会话 |
| `stats` | 查看统计 |
| `db` | 数据库操作 |
| `plug` | 插件管理 |

## 交互式会话流程（run 命令）

```
1. CLI 解析参数
2. 初始化配置、环境变量
3. 初始化数据库（SQLite）
4. 加载项目配置（.opencode config）
5. 初始化 LLM 连接
6. 创建 Session：
   a. 加载相关上下文
   b. 构建 system prompt（按模型选择模板）
   c. 注册可用工具
7. 进入交互循环：
   a. 获取用户输入
   b. 构建消息（含上下文附件）
   c. 调用 LLM API（流式响应）
   d. 处理 tool_use（工具执行循环）
   e. 处理上下文压缩（auto-compact）
   f. 重复直到用户退出
8. 会话结束：持久化、清理
```

## 服务器模式流程（serve 命令）

```
1. CLI 解析参数（端口、主机等）
2. 初始化 Hono HTTP 服务器
3. 注册路由中间件（auth, CORS, compression, error handling）
4. 注册 REST API 路由：
   - /sessions — 会话 CRUD
   - /tools — 工具执行
   - /messages — 消息流
   - /ws — WebSocket 实时通信
5. 启动 HTTP/WebSocket 服务器
6. 客户端通过 HTTP/WS 与服务器交互
```

## 工具执行流程

```
1. LLM 返回 tool_use 块
2. 解析工具名称和参数
3. 权限检查：
   a. 静态规则（always-allow / always-deny）
   b. 工具属性（isReadOnly, isDestructive）
   c. 用户确认（TUI 对话框或 CLI 提示）
4. 调用工具实现：
   - file tools → 文件系统操作
   - search tools → ripgrep/glob 搜索
   - shell tools → PTY 子进程执行
   - web tools → HTTP 请求
   - agent tools → 子代理生成
5. 工具结果格式化为消息
6. 附加到对话历史
7. 发送下一个 LLM 请求（含工具结果）
```

## 扩展点

1. **自定义工具**: 通过 Plugin SDK 注册新工具
2. **自定义命令**: 通过 Plugin SDK 注册新 CLI 命令
3. **自定义插件**: 完整的插件系统，可扩展任何方面
4. **MCP 服务器**: 通过 MCP 协议集成外部服务
5. **自定义模型**: 通过 Provider 系统添加新 LLM 提供商
6. **自定义 TUI**: 通过 TUI 插件扩展终端 UI
7. **配置文件**: 项目级 `.opencode` 配置
8. **CLI 参数**: 丰富的命令行参数覆盖行为
