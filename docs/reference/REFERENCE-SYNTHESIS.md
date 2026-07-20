# Wings 参考仓库综合对照

> 整理日期: 2026-07-20
> 覆盖 12 个开源仓库：OpenSquilla / DeerFlow / OpenCode / AstrBot / Cherry Studio / Crush / Deep Code / CodeWhale / Hermes / nanobot / OpenClaw

按功能领域梳理各仓库对 Wings 最有借鉴价值的特性，标注优先级和来源。

---

## 1. 权限系统

最高频出现的借鉴领域，4 个仓库有成熟方案。

| 特性 | 来源 | 对 Wings 的价值 | 优先级 |
|------|------|----------------|--------|
| **权限分层**：Hook 预批准 > YOLO > 允许列表 > 持久授权 > 单次授权 | Crush | 设计 `PermissionChain` 类，每层可短路 | **高** |
| **三层规则集**：BuiltinDefault > Agent > User，Deny > Ask > Allow | CodeWhale | 规则覆盖 + 冲突优先级参考 | **高** |
| **精细作用域**：read/write/delete-in/out-cwd, network, mcp, git-log 等 10 级 | Deep Code | 当前 wings 权限粒度过粗，需引入作用域划分 | **高** |
| **sideEffects 声明**：模型执行 bash 前声明预期副作用 | Deep Code | 从"事后检查"变为"提前预判" | **高** |
| **审批姿势切换**：Suggest / Auto / Bypass / Never 四种模式热键切 | CodeWhale | Shift+Tab 切换，用户体验借鉴 | **高** |
| **命令黑白名单**：curl/wget/nc/telnet/ssh/kill/rm 等黑名单 | Crush, AstrBot | bash 工具安全加固 | **中** |

**建议行动**：重构 `permissions/` 模块，引入 PermissionChain 链式检查 + 作用域划分 + sideEffects 机制。

---

## 2. Agent Loop / 会话引擎

| 特性 | 来源 | 对 Wings 的价值 | 优先级 |
|------|------|----------------|--------|
| **显式状态机**：8 状态 TurnState 枚举，每状态一个 handler | nanobot | 替代当前深嵌套协程，更易理解和测试 | **高** |
| **会话级并发控制**：每会话异步锁 + 全局并发信号量 | nanobot | 同会话串行，跨会话并行，限制总并发数 | **高** |
| **SessionManager 单引擎**：createSession → activateSession 集中式循环 | Deep Code | 参考其 2900 行核心引擎的集中式设计 | **高** |
| **手动压缩 /compact**：用户主动触发，可选摘要或截断 | DeerFlow | 已有自动压缩，加手动命令改动小价值大 | **高** |
| **Session Goals --goal**：注入 system prompt 的目标声明 | DeerFlow | session 增加结构化目标+达成检测 | **高** |
| **Op/Event 分离架构**：Op(SendMessage/Cancel) → Event(ResponseStart/Delta) | CodeWhale | 命令查询分离，适合复杂 UI 交互 | **中** |
| **会话中切换模型**：保持上下文，仅换 provider 引用 | Crush | 用户痛点功能 | **中** |
| **8 阶段 TurnRunner 管道**：Input → Attachment → ProviderAndTools → … → TurnFinalizer | OpenSquilla | Protocol 驱动的微内核管道，长期架构参考 | **中** |

**建议行动**：重构 AgentLoop 为显式状态机 + 每会话锁 + /compact 命令 + --goal 参数。

---

## 3. 工具系统

| 特性 | 来源 | 对 Wings 的价值 | 优先级 |
|------|------|----------------|--------|
| **FunctionTool/ToolSet 统一抽象**：解耦工具定义与 OpenAI/Anthropic/Google 三套 schema | AstrBot | 当前 wings 工具 schema 硬编码 Anthropic 格式，需解耦 | **高** |
| **工具并发安全标记**：concurrency_safe 标记 + RwLock 读写锁 | nanobot, CodeWhale | 并行安全工具可重叠，串行工具互斥 | **中** |
| **工具自文档化**：.ts + .md 配对，模板渲染注入运行时信息 | Crush | 改进工具描述的可维护性 | **中** |

**建议行动**：将 `tools/` 模块重构为 ToolSet 抽象 + 格式转换层。

---

## 4. LSP 集成

| 特性 | 来源 | 对 Wings 的价值 | 优先级 |
|------|------|----------------|--------|
| **LSP 代码智能**：定义/符号/调用层次/诊断/重命名等 7 个 LSP 工具 | Crush | TypeScript 可用 `vscode-languageserver` 库实现，显著提升代码理解质量 | **高** |

**建议行动**：新建 `src/lsp/` 模块，实现懒加载 LSP 客户端管理器 + 4-5 个核心 LSP 工具。

---

## 5. 交互模式 / UX

| 特性 | 来源 | 对 Wings 的价值 | 优先级 |
|------|------|----------------|--------|
| **Plan / Act / Operate 三模式**：只读规划→多步执行→多任务编排，Tab 切换 | CodeWhale | TypeScript 策略模式实现，极大的 UX 改进 | **高** |
| **审批姿势热键切换**：Shift+Tab 循环切 Suggest/Auto/Bypass/Never | CodeWhale | 配合权限系统使用 | **高** |

**建议行动**：当前 AgentLoop 增加 mode 状态 + Tab 切换逻辑。

---

## 6. Skills 系统

| 特性 | 来源 | 对 Wings 的价值 | 优先级 |
|------|------|----------------|--------|
| **元数据增强**：version / dependencies / tools / timeout / install / requires | DeerFlow, OpenClaw | 当前 SKILL.md 仅有基础字段，需扩展 | **高** |
| **LLM 自动匹配**：低 temperature 调用判断哪些 skills 匹配意图 | Deep Code | 比关键词匹配更准确，可选精确模式 | **中** |
| **兼容性处理**：legacy skill.md → SKILL.md，沙箱同步 | AstrBot | 渐进迁移参考 | **中** |

**建议行动**：扩展 SKILL.md schema，增加 version/dependencies/install/requires 字段。

---

## 7. MCP 支持

| 特性 | 来源 | 对 Wings 的价值 | 优先级 |
|------|------|----------------|--------|
| **安全白名单**：stdio 命令严格白名单（只允许 python/node/npx/pnpm/uv/uvx） | AstrBot | 直接复用其安全策略 | **高** |
| **进程内 MCP 服务器**：InMemoryTransport 将内置能力暴露为 MCP 服务 | Cherry Studio | 将 wings 能力通过 MCP 对其他工具开放 | **中** |

**建议行动**：加固 wings 的 MCP 客户端安全性 + 考虑进程内 MCP 服务器模式。

---

## 8. 记忆系统

| 特性 | 来源 | 对 Wings 的价值 | 优先级 |
|------|------|----------------|--------|
| **Dream 幻觉防护**：LLM 编辑记忆文件后 git diff 差异检查，自动 commit | nanobot | 当前 wings 已有 dream 系统但无幻觉防护，直接补强 | **高** |
| **上下文压缩策略组合**：LLM 摘要 + 按轮次截断，不同模型不同阈值 | AstrBot, Deep Code | 差异化 compact 阈值（DeepSeek V4: 512K） | **中** |
| **自主技能创建/改进闭环**：复杂任务后自动生成技能，在 use 中改进 | Hermes | 长期进化方向 | **中** |

**建议行动**：在 dream 流程中加入 git diff 检查和自动回滚机制。

---

## 9. Provider / 模型管理

| 特性 | 来源 | 对 Wings 的价值 | 优先级 |
|------|------|----------------|--------|
| **DeepSeek 专属优化**：reasoning_effort 参数、extra_body 传参、高 compact 阈值 | Deep Code | 直接参考其参数传递方式 | **高** |
| **Fallback 退路链**：主 Provider 失败自动切备用，签名检测无缝迁移 | nanobot | 增强 multi-provider 可靠性 | **中** |
| **路由别名系统**：100+ 模型条目，deepseek-chat → deepseek-v4-flash 别名解析 | CodeWhale | 多 provider 同名模型路由策略 | **中** |
| **多层级配置合并**：环境变量 > 项目 settings > 用户 settings > 默认值 | Deep Code | 配置系统设计参考 | **中** |

**建议行动**：完善 DeepSeek V4 的 thinking 参数传递 + 增加 provider fallback 机制。

---

## 10. Hook 系统

| 特性 | 来源 | 对 Wings 的价值 | 优先级 |
|------|------|----------------|--------|
| **PreToolUse hook**：exit code 语义（2=阻止工具，49=中止 turn），Input 重写 | Crush | exit code 约定简洁强大 | **中** |
| **多 Sink 可观测性**：Stdout / JSONL / Webhook / Unix Socket 四种 sink | CodeWhale | 可观测性事件类型定义参考 | **中** |

---

## 11. 消息 / 通信架构

| 特性 | 来源 | 对 Wings 的价值 | 优先级 |
|------|------|----------------|--------|
| **极简 MessageBus**：50 行 async 双队列解耦所有模块 | nanobot | 避免过度架构，模块间轻量通信 | **高** |
| **流管理器观察者模式**：多 listener 附加到流生命周期 | Cherry Studio | 可扩展流管道，关注点分离 | **中** |

**建议行动**：评估 wings 模块间通信，引入轻量级 MessageBus 替代直接调用。

---

## 12. 上下文工程

| 特性 | 来源 | 对 Wings 的价值 | 优先级 |
|------|------|----------------|--------|
| **动态 prompt 组装**：角色指令/工具约束/输出规则/记忆排序动态组合 | DeerFlow | 替代当前固定 system prompt，根据场景动态组装 | **中** |
| **ContextEngine 上下文管理**：委托构建/来源注册/运行时设置/安全隔离 | OpenClaw | 上下文窗口管理的结构方案 | **中** |
| **Agent 工作空间引导**：SOUL.md / TOOLS.md / BOOTSTRAP.md / USER.md | OpenClaw, Cherry Studio | 扩展当前 CLAUDE.md 模式 | **中** |

---

## 13. 沙箱 / 安全

| 特性 | 来源 | 对 Wings 的价值 | 优先级 |
|------|------|----------------|--------|
| **bash 安全加固**：命令黑名单 + sideEffects 声明 | Crush, Deep Code | 当前 wings bash 工具无隔离无黑名单 | **中** |
| **Landlock + seccomp 沙箱**：Linux 下最轻量的进程沙箱方案 | CodeWhale | 长期安全路线，当前低优先 | **低** |
| **Docker 沙箱**：隔离容器执行，K8s provisioner | DeerFlow | 增加部署复杂度，低优先 | **低** |

---

## 14. 子 Agent / 多 Agent

| 特性 | 来源 | 对 Wings 的价值 | 优先级 |
|------|------|----------------|--------|
| **Coordinator 双 Agent**：coder(large) + task(small) 分模型 | Crush | 大模型做核心，小模型做摘要降成本 | **中** |
| **Handoff 委托**：transfer_to_<name>，子 Agent 独立 provider + tools | AstrBot | 等子 Agent 系统成熟后参考 | **低** |

---

## 15. Cron / 定时任务

| 特性 | 来源 | 对 Wings 的价值 | 优先级 |
|------|------|----------------|--------|
| **自然语言 cron 配置**：每日报告/夜间备份用自然语言描述 | Hermes | 增强现有 cron 功能的易用性 | **中** |

---

## 16. 架构模式 / 设计原则

跨仓库通用的设计原则提炼：

| 原则 | 出处 | 适用场景 |
|------|------|----------|
| **核心保持入口无关，无硬编码渠道 ID** | OpenClaw CLAUDE.md | wings 应保持核心与输入源解耦 |
| **存储统一使用 SQLite，禁止 JSON/JSONL/TXT 散落** | OpenClaw CLAUDE.md | 统一持久化策略 |
| **配置变更走 doctor 迁移，不与运行时代码耦合** | OpenClaw CLAUDE.md | 引入配置迁移机制 |
| **热路径禁止文件系统轮询** | OpenClaw CLAUDE.md | AgentLoop 中避免文件 I/O 轮询 |
| **重构应删除约同等数量的复杂度** | OpenClaw CLAUDE.md | 净复杂度不增长 |
| **Protocol 驱动 DI**：接受端口接口而非具体实现 | OpenSquilla | TypeScript interface 实现同等 DI |
| **StageOutcome 不相交联合**：要么 success 要么 terminate，不能同时 | OpenSquilla | TypeScript discriminated union + Zod |
| **Fail-Open 预管道**：步骤失败被捕获但管道继续 | OpenSquilla | 优雅降级策略 |
| **延迟导入**：首次访问时延迟导入重量级模块 | OpenSquilla | TypeScript dynamic import() |

---

## 优先级汇总

| 领域 | 高 | 中 | 低 |
|------|----|----|----|
| 权限系统 | 分层/作用域/sideEffects/审批姿势 | 黑白名单 | — |
| Agent Loop | 状态机/会话锁/手动压缩/Session Goals | Op/Event架构/会话切模型/TurnRunner | — |
| 工具系统 | FunctionTool统一抽象 | 并发安全/自文档化 | — |
| LSP 集成 | 7个LSP工具 | — | — |
| 交互模式 | Plan/Act/Operate 三模式 | — | — |
| Skills | 元数据增强 | LLM匹配/兼容性 | — |
| MCP | 安全白名单 | 进程内服务器 | — |
| 记忆 | Dream幻觉防护 | 差异化阈值/自主技能闭环 | — |
| Provider | DeepSeek优化 | Fallback/路由别名/配置合并 | 多运行时/代码生成/设备端路由 |
| Hook | — | exit code语义/多Sink | — |
| 通信 | MessageBus | 流管理器观察者 | Pub/Sub/FIFO队列 |
| 上下文工程 | — | 动态prompt/ContextEngine/引导文件 | — |
| 沙箱 | — | bash安全加固 | Landlock/Docker |
| 子Agent | — | Coordinator双Agent | Handoff/RPC |
| Cron | — | 自然语言配置 | Scheduled Tasks |
| 架构 | — | — | Gateway/Client-Server/插件SDK |

**核心结论**：Wings 短期应聚焦 **权限系统重构 + AgentLoop 状态机化 + LSP 集成 + FunctionTool 抽象 + Plan/Act/Operate 三模式** 这五个高优先级领域。它们改动相对独立，可以并行推进。
