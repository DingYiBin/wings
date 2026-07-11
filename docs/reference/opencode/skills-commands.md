# OpenCode — Skill 与 Command 系统

## 核心发现

OpenCode 的 Skill 和 Command 系统与 Claude Code 类似——Skill 是通过模型调用（SkillTool）触发的工作流，Command 是用户通过 CLI 键入触发的操作。但 OpenCode 的插件体系让 Command 和 Skill 都可以通过 Plugin SDK 扩展。

---

## 命令系统 (Commands)

CLI 命令通过 yargs 18 注册，约 20 个顶层命令：

### 交互相关

| 命令 | 用途 | 模型可调用 |
|------|------|-----------|
| `run` | 主交互式编码会话 | 否（用户启动） |
| `serve` | 启动 HTTP 服务器 | 否 |
| `tui` | TUI 线程管理 | 否 |
| `attach` | 附加到运行中会话 | 否 |

### 模型/提供商管理

| 命令 | 用途 | 模型可调用 |
|------|------|-----------|
| `models` | 列出可用模型 | 是（信息获取） |
| `providers` | 列出可用提供商 | 是（信息获取） |

### 会话管理

| 命令 | 用途 | 模型可调用 |
|------|------|-----------|
| `session` | 会话管理 | 是 |
| `export` | 导出会话 | 否 |
| `import` | 导入会话 | 否 |
| `generate` | 生成代码 | 是 |

### 代码/Git 集成

| 命令 | 用途 | 模型可调用 |
|------|------|-----------|
| `github` | GitHub 集成 | 是 |
| `pr` | PR 操作 | 是 |

### 调试/诊断

| 命令 | 用途 | 模型可调用 |
|------|------|-----------|
| `debug` | 调试命令 | 是 |
| `stats` | 统计信息 | 是 |
| `db` | 数据库操作 | 否 |

### 系统管理

| 命令 | 用途 | 模型可调用 |
|------|------|-----------|
| `upgrade` | 自更新 | 否 |
| `uninstall` | 卸载 | 否 |
| `account` | 账户管理 | 否 |
| `plug` | 插件管理 | 否 |

### 协议模式

| 命令 | 用途 | 模型可调用 |
|------|------|-----------|
| `mcp` | MCP 模式 | 是（协议相关） |
| `acp` | ACP 模式 | 是（协议相关） |
| `web` | Web 界面 | 否 |
| `agent` | 子代理模式 | 是 |

---

## 技能系统 (Skills)

OpenCode 的 skill 系统是插件系统的一部分，位于 `packages/core/src/skill/`：

### Skill 类型

| 类型 | 说明 | 来源 |
|------|------|------|
| **内置技能** | 系统自带的技能 | `packages/core/src/skill/` |
| **插件技能** | 通过插件注册的技能 | `packages/plugin/` |
| **自定义技能** | 用户通过配置文件定义的技能 | 磁盘文件 |

### Skill 生命周期

```
1. 技能注册 → 技能发现 (发现所有可用技能)
2. 技能选择 → 技能注入 (注入到 system prompt)
3. 模型调用 → 技能执行 (通过 SkillTool 调用)
4. 技能完成 → 结果返回 (格式化为工具结果)
```

### SkillTool

SkillTool 是连接系统 prompt 和技能系统的桥梁：
- 位于 `packages/core/src/tool/` 
- 调用时根据技能名称查找对应技能
- 展开技能 prompt 为 system prompt 内容
- 支持 inline（当前会话执行）和 fork（子代理执行）模式

---

## 插件系统扩展

### Plugin SDK (`packages/plugin/`)

插件可以扩展 Command 和 Skill：

| 扩展点 | 说明 |
|--------|------|
| **Command Plugin** | 注册新的 CLI 命令 |
| **Skill Plugin** | 注册新的技能 |
| **Tool Plugin** | 注册新的工具 |
| **Provider Plugin** | 注册新的 LLM 提供商 |

### 插件来源

| 来源 | 加载方式 |
|------|----------|
| 内置插件 | `registerBuiltin()` |
| 市场插件 | `plugins install <name>` |
| 本地插件 | `--plugin-dir` 参数指定 |

---

## 双路径调用

### 用户路径

```
用户终端输入 `opencode <command>`
  → yargs 解析参数
  → 匹配命令处理器
  → 执行命令逻辑
  → 输出结果
```

### 模型路径

```
模型调用 SkillTool({ skill: "skill-name", args: "..." })
  → SkillTool 处理器
  → 查找技能定义
  → 展开技能 prompt
  → 注入到会话上下文
  → 模型继续执行
```

---

## 对 wings 的参考价值

### 1. 命令注册方式

OpenCode 使用 yargs 18 的 `command` 模块注册，每个命令独立文件。wings 可以参考这种模块化命令注册模式。

### 2. Skill 与 Tool 统一

技能最终展开为工具描述的一部分，使用统一的 prompt 格式——不需要维护两套独立的系统。

### 3. 插件扩展命令

通过 Plugin SDK 注册新命令的模式，让第三方可以扩展 CLI 功能而不需要修改核心代码。

### 4. 双路径设计

同一功能同时支持用户手动调用和模型自动调用——用户路径通过 CLI，模型路径通过 SkillTool。
