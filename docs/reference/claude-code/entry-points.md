# Claude Code — 入口点与流程

## 启动序列

```
1. process starts -> `src/entrypoints/cli.tsx`
2. 副作用触发:
   - profileCheckpoint('main_tsx_entry')
   - startMdmRawRead() -- 生成 MDM 子进程
   - startKeychainPrefetch() -- 生成 keychain 读取
3. 模块图加载 (~135ms)
4. main() 函数调用:
   - 安全: 设置 NoDefaultCurrentDirectoryInExePath
   - 警告处理器初始化
   - 特殊 CLI 参数预处理:
     a. Direct Connect URL (`cc://` 或 `cc+unix://`)
     b. Deep link URIs (LODESTONE feature gate)
     c. Assistant mode (KAIROS feature gate)
     d. SSH remote mode (SSH_REMOTE feature gate)
   - 确定交互/非交互模式
   - 初始化分析入口
   - 设置客户端类型
   - 解析设置 flags
   - 调用 run():
     - 创建 Commander program
     - preAction 钩子:
       a. Await MDM 设置 + keychain 预取
       b. init(): 配置、环境变量、优雅关闭、遥测、API 预连接、代理/MTLS
       c. 附加分析 sink
       d. 处理 --plugin-dir flag
       e. 运行迁移
       f. 加载远程管理设置 / 策略限制
       g. 上传用户设置 (如果 feature-gated)
```

## 交互模式流程

```
1. Commander 分发默认命令 (无子命令)
2. setup() 函数 (main.tsx):
   - 获取 bootstrap API 数据
   - 应用完整环境变量 (在信任之后)
   - 初始化 GrowthBook
   - 初始化 MCP 连接
   - 初始化 LSP
   - 加载插件/技能
   - 初始化工具权限
   - 创建 AppState store
   - 通过 Ink 渲染 REPL
3. REPL 装载:
   - 显示信任对话框 (如需要)
   - 用户输入 prompt
   - /slash_command 分发或纯文本发送到 Query Engine
   - Query Engine: 构建消息 -> API 调用 -> 工具循环 -> 显示
4. 退出: 优雅关闭, 会话清理
```

## 非交互 (Print/SDK) 模式流程

```
1. -p 或 --print flag 检测到
2. 跳过信任对话框, 跳过 REPL
3. 处理 stdin 输入
4. 配置输出格式 (text, JSON, stream-json)
5. 调用 runHeadless() 创建 QueryEngine (带 print 特定选项)
6. 流式结果到 stdout
7. 退出
```

## 工具执行流程

```
1. Claude API 返回 tool_use 块
2. Query engine 调用 tool.call(input, context, canUseTool, parentMessage)
3. call() 内部:
   - canUseTool() 触发权限检查管道
   - 权限检查: 静态规则 -> hooks -> classifier -> 交互式
   - 如果拒绝: 返回拒绝消息
   - 如果允许: 执行工具逻辑
   - 工具可能返回新消息 (user/assistant/attachment/system)
4. 工具结果附加到对话
5. Query engine 发送下一个 API 请求 (带工具结果)
```

## 扩展点

1. **自定义技能**: 在 CLAUDE.md 或文件中定义，通过 SkillTool 执行
2. **插件 (市场)**: 通过 /plugin 安装，从市场注册表加载
3. **内置插件**: 通过 registerBuiltinPlugin() 注册
4. **MCP 服务器**: 在 .claude/mcp.json 中配置，支持 stdio, SSE, WebSocket 传输
5. **Hooks**: 生命周期点的 shell 命令 hooks
6. **自定义快捷键**: 在 settings.json 中配置
7. **自定义 Agent**: 在 .claude/agents/ 目录中定义
8. **自定义 CLAUDE.md**: 项目级和用户级上下文注入文件
9. **CLI 参数**: --system-prompt, --append-system-prompt, --add-dir, --mcp-config, --agents, --plugin-dir
