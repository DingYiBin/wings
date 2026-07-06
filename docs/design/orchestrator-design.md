# Orchestrator-Worker 架构设计

> 状态: 设计草案 / 未实现
> 提出日期: 2026-07-06

## 1. 动机

当前 wings 的主 session 是一个**扁平的 agent loop**：主 agent 拥有全部工具（read/write/edit/bash/glob/grep/web_*/agent），直接执行所有操作。这带来几个问题：

1. **Context 膨胀**: 每次工具调用的完整结果（文件内容、搜索输出、网页正文）都作为 `ToolResultBlock` 累积在主 session 的消息列表里。读 5 个文件后，主 context 已经塞满原始文本，模型注意力被稀释，成本上升。
2. **多 API 池的价值未充分发挥**: `subagent/<type>` 池已经存在，但主 agent 自己也用 `main` 池执行工具循环——同一个模型既要做高层规划又要做底层文件操作，池的差异化配置（贵模型规划 / 便宜模型执行）无法落地。
3. **失败恢复粗糙**: 工具报错后，错误信息直接进主 context，模型自行决定下一步。没有显式的"这个子任务失败了，换个策略"的反思环节。

## 2. 核心设计

**主 session 不包含任何 tool result。** 主 agent 是纯 orchestrator，唯一能力是任务拆解、分发、汇总。所有可能触发工具的操作都由 subagent 执行。

### 2.1 角色划分

| 角色 | 工具集 | 职责 | 路由池 |
|------|--------|------|--------|
| **主 agent (orchestrator)** | 仅 `agent`（+ 可选 `ask_user`） | 理解用户意图、拆解任务、分发 subagent、综合结果、失败时重新规划 | `main` |
| **worker subagent** | 按类型过滤（explore/code/review 等） | 执行具体操作，返回结构化结果（成功/失败 + 产出） | `subagent/<type>` |

### 2.2 工作流程

```
User: "修复 src/auth.py 里的 login bug"

主 agent (turn 1):
  推理: 需要先定位 bug → 分发 explore subagent
  调用: agent(type="explore", prompt="阅读 src/auth.py 的 login 函数，
        找出可能的 bug，报告行号和问题")

  ┌─ explore subagent ─────────────────┐
  │  read src/auth.py                  │
  │  grep "login"                      │
  │  返回: "login() 在 line 45, 未校验
  │        空密码。建议: 加 if not pwd" │
  └────────────────────────────────────┘

主 agent (turn 2):
  收到 explore 报告 → 推理: 需要写代码 → 分发 code subagent
  调用: agent(type="code", prompt="在 src/auth.py line 45 后加
        'if not pwd: return False'，参考 explore 的发现: ...")

  ┌─ code subagent ────────────────────┐
  │  read src/auth.py                  │
  │  edit src/auth.py                  │
  │  返回: "已修改 line 46, 加了空密码
  │        校验。但 tests/test_auth.py
  │        有 3 个测试现在失败了"       │  ← 失败上报
  └────────────────────────────────────┘

主 agent (turn 3):
  收到 code 报告 → 推理: 测试失败,需要先看测试 → 分发 explore
  调用: agent(type="explore", prompt="读 tests/test_auth.py 的
        3 个失败测试,报告它们期望什么")

  ┌─ explore subagent (第2次) ─────────┐
  │  返回: "测试期望 login 返回 dict    │
  │        不是 bool..."               │
  └────────────────────────────────────┘

主 agent (turn 4):
  推理: 原修复方向错了 → 重新规划 → 分发 code subagent
  调用: agent(type="code", prompt="撤回上次修改,改为返回
        {'ok': False, 'reason': 'empty pwd'},测试期望 dict")

  ┌─ code subagent (第2次) ────────────┐
  │  edit + run pytest                 │
  │  返回: "修改完成,3 个测试全过"      │
  └────────────────────────────────────┘

主 agent (turn 5):
  综合所有 subagent 报告 → 给用户最终答复
```

### 2.3 主 session 的消息结构

主 session 只包含四类内容：

1. **System prompt**（身份 + Guidelines + env info）
2. **User messages**（用户原始输入 + 背景注入的 subagent 报告）
3. **Assistant messages**（主 agent 的推理文本 + `agent` tool_use blocks）
4. **Tool results**（仅 `agent` 工具的返回值——subagent 的结构化报告，**不是**底层工具的原始输出）

对比当前设计：当前主 session 包含 read/bash/grep 等所有工具的 `ToolResultBlock`，新设计只保留 `agent` 工具的结果。Context 体积从「N 个文件 + M 次搜索」降到「N 条 subagent 摘要」。

## 3. 与当前架构的差异

| 维度 | 当前设计 | Orchestrator 设计 |
|------|---------|------------------|
| 主 agent 工具集 | 全部 11 个 | 仅 `agent` (+ 可选 `ask_user`) |
| 主 session 中的 tool result | 所有工具的原始输出 | 仅 `agent` 工具的结构化报告 |
| 任务分解 | 隐式（模型自行决定何时调用 subagent） | 显式（主 agent 必须分解,没有直接工具可用） |
| 失败处理 | 错误信息进 context,模型自行调整 | subagent 返回失败报告,主 agent 重新规划并可能换 subagent |
| 上下文增长 | 每次工具调用线性增长 | 每个任务只增一条摘要 |
| 模型池利用 | `main` 池承担全部工作 | `main` 池做规划,`subagent/<type>` 池做执行 |
| 简单操作开销 | 一次 API 调用 | 至少两次（主 agent 分发 + subagent 执行） |

## 4. 关键设计决策（待定）

### 4.1 是否有「快速通道」？

**问题**: 读单个文件这种简单操作,是否真的需要走 subagent?开销可能是 2 次 API 调用 vs 当前 1 次。

**选项**:
- **A. 严格 orchestrator**: 没有例外,一切走 subagent。设计纯粹,但简单任务有 2x 延迟。
- **B. 主 agent 保留 read/glob**: 仅给主 agent 保留几个只读探索工具,写操作和复杂任务走 subagent。折中,但破坏了"主 session 无 tool result"的纯粹性。
- **C. 主 agent 保留 read 但结果不进 context**: 主 agent 可以 read,但 read 结果用即弃,不进消息列表。需要新机制,实现复杂。

**倾向**: A——纯粹的设计让多 API 池的价值最大化,且简单任务的 2x 延迟可由 `subagent/explore` 池用快模型来对冲。

### 4.2 Subagent 之间能否互调？

**问题**: 当前 subagent 的 `disallowed_tools` 包含 `agent`,禁止递归。新设计下,code subagent 能否自己调用 explore subagent?

**选项**:
- **A. 严格分层**: subagent 不能调用其他 subagent,所有协调走主 agent。失败必须上报。
- **B. 允许有限递归**: 某些 subagent 类型可以调用特定其他类型(如 code 可以调 explore)。

**倾向**: A——严格分层让主 agent 始终是唯一协调点,失败恢复逻辑集中在主 agent,可观测性好。这也正是用户描述的"上报→重新规划→换 subagent→再分发"流程。

### 4.3 Subagent 报告格式

**问题**: subagent 返回给主 agent 的内容应该是自由文本还是结构化?

**选项**:
- **A. 自由文本**: 简单,但主 agent 需要自己解析"成功还是失败"。
- **B. 结构化**: 强制 `{"status": "ok"|"failed", "result": "...", "next_step_hint": "..."}`。主 agent 更容易决策,但 subagent 模型需要遵守格式。

**倾向**: B——结构化报告让主 agent 的重新规划更可靠,也便于后续自动化分析失败模式。需要在 subagent system prompt 里明确要求格式。

### 4.4 主 agent 如何知道"该停了"？

**问题**: 主 agent 没有直接工具,它怎么判断任务真的完成、可以回复用户了?

**方案**: 主 agent 在收到 subagent 成功报告后,如果综合判断任务目标已达成,就输出最终文本(不调用 agent 工具)结束 turn。这和当前 end_turn 逻辑一致——只是触发条件从"工具用完了"变成"subagent 报告任务完成"。

### 4.5 路由池的调整

**问题**: 主 agent 用 `main` 池,但它的职责变了——从"全能执行者"变成"纯规划者"。`main` 池应该偏好什么样的模型?

**方向**:
- `main` 汯: 推理强、长上下文、能做任务分解的模型(如 Claude Opus / GPT-4 级别)
- `subagent/explore` 池: 快速、便宜、能读文件的模型
- `subagent/code` 池: 擅长代码生成和编辑的模型
- `subagent/review` 池: 擅长发现问题的模型

这正好让用户的多 API 池配置有了更清晰的语义——每个池对应一种认知能力,而不是现在模糊的"主任务 vs 子任务"。

### 4.6 主 agent 是否能自行设计 subagent？

**问题**: 当前 subagent 类型是预定义的（general/explore/plan/code-reviewer + 用户在 `.wings/agents/` 配置的）。orchestrator 模式下，主 agent 负责所有任务分解，它是否应该能在运行时**动态创建**新的 subagent 类型？

**场景举例**：
- 用户要求"分析这个数据库的 schema 并生成迁移脚本"。预定义类型里没有"DBA agent"，主 agent 可能想要一个带 `bash`（跑 psql）+ `read`+ `edit`（改迁移文件）的专门 subagent。
- 用户要求"翻译这个项目到 Rust"。主 agent 可能想要一个"rust-porter" subagent，带特定 system prompt（强调 Rust 习惯用法、借用检查器注意事项）。

**选项 A. 不允许 — 只用预定义类型**

主 agent 只能从 `BUILTIN_AGENT_TYPES` + `.wings/agents/` 配置的类型里选。如果没合适的，就用 `general` 凑合。

- 优点：简单、可预测、安全。subagent 的工具集和权限在启动前就定好，用户完全可控。
- 缺点：主 agent 的分解能力被预定义类型限制。遇到没预见到的任务类型，只能用不合适的 subagent，效果打折。
- 适合：用户想精细控制每种 subagent 的行为和工具集。

**选项 B. 允许运行时定义 — 主 agent 可创建临时 subagent**

给主 agent 一个新工具 `define_agent`（或扩展 `agent` 工具的 input），允许它指定：
- `name`: 临时类型名（如 `db-analyzer`）
- `tools`: 工具白名单（如 `["bash", "read", "edit"]`）
- `system_prompt`: 该 subagent 的专病指令
- `read_only`: 是否只读

主 agent 调用 `agent(subagent_type="db-analyzer", ...)` 时，系统用主 agent 定义的规格运行 subagent。

- 优点：主 agent 能根据任务**自适应**——遇到新领域就造一个专门 subagent。让 orchestrator 的"任务分解"能力真正完整：不仅决定"做什么"，还决定"谁来做、用什么规则做"。
- 缺点：
  - **安全**: 主 agent 可能定义一个 `tools=["bash"]` + `read_only=false` 的 subagent 绕过用户本想限制的操作。需要权限审批层。
  - **可预测性下降**: 用户不知道主 agent 会造出什么 subagent，调试和审计更难。
  - **system prompt 注入风险**: 主 agent 写的 subagent system prompt 可能引导 subagent 做意外的事（尤其在用户 input 里有 prompt injection 时）。
  - **池语义混乱**: 临时 subagent 用哪个路由池？`subagent/general`？还是 `subagent/<temp-name>`？前者让池配置失去意义，后者让池数量爆炸。
- 适合：任务空间开放、用户信任主 agent、想要最大化自适应能力。

**选项 C. 折中 — 主 agent 可组合,但不能完全自定义**

主 agent 不能写任意 system prompt，但可以从预定义的"能力片段"里组合，比如：
- 选工具集（受限白名单）
- 选一个预定义的"风格模板"（如 "代码谨慎"、"探索广泛"、"执行快速"）
- 不能写自由文本 system prompt

- 优点：保留部分自适应性，同时约束了 prompt 注入和安全风险。
- 缺点：能力片段需要预先设计，维护成本高；可能还是不够灵活。

**对比**：

| 维度 | A. 只用预定义 | B. 运行时定义 | C. 受限组合 |
|------|--------------|--------------|------------|
| 自适应能力 | 低 | 高 | 中 |
| 安全可控 | 高 | 低（需审批） | 中 |
| 实现复杂度 | 低 | 中 | 高 |
| 池语义清晰 | 高 | 低 | 中 |
| prompt 注入风险 | 低 | 高 | 中 |
| 调试可观测 | 高 | 低 | 中 |

**倾向**: A 起步，留 B 的扩展空间。

理由：
1. **阶段化引入风险**：先做 A（orchestrator 基础架构），验证主 agent 的分解-分发-重规划循环可靠后再开放 B。一上来就做 B 会让系统行为不可预测，难以定位问题。
2. **A 已经能覆盖大部分场景**：只要 `general`（全工具）+ `explore`（只读）+ `code`（编辑）+ `review`（审查）几个类型定义好，绝大多数任务都能映射。主 agent 的"设计 subagent"能力其实主要靠**组合调用顺序**实现，不一定需要造新类型。
3. **B 的安全机制需要单独设计**：动态 subagent 的权限审批（用户是否需要批准主 agent 造的新类型？）、池映射策略、prompt 注入防护，都是独立子问题，不适合塞进第一版。
4. **C 的回报不确定**：能力片段设计本质是另一种形式的"预定义"，但更复杂。如果要做受限组合，不如先看 A 在实际使用中哪里不够用。

**如果将来引入 B，建议的安全约束**：
- 主 agent 定义的 subagent 工具集必须是用户预批准的白名单子集（不能凭空给 subagent 加用户没授权的工具）
- `read_only` 标志必须保守（默认 true，主 agent 想让 subagent 写入需要用户在 config 里允许 `orchestrator_define_writable: true`）
- 临时 subagent 的 system prompt 必须经过 sanitize（剥离用户 input 里的注入内容，只允许主 agent 的规划文本）
- 临时类型默认走 `subagent/general` 池，避免池爆炸；用户可以为常用临时类型在 config 里显式配置独立池

**开放问题（即使选 A 也需要回答）**：
- 预定义类型应该有多少种？当前 4 种（general/explore/plan/code-reviewer）够不够？是否需要 `subagent/code`（专门编辑）、`subagent/test`（跑测试）、`subagent/debug`（带 strace/gdb）？
- 用户如何向主 agent 描述"这个任务该用哪个 subagent"？靠 system prompt 里的类型列表，还是让主 agent 自己从任务特征推断？
- 自定义 agent（`.wings/agents/*.md`）在 orchestrator 模式下是主 agent 的唯一扩展点——这个机制是否需要增强（如支持继承、模板）？

## 5. 实现路径

### 阶段 1: 主 agent 工具集裁剪
- 在 `bootstrap.py` 里给主 AgentLoop 构造一个只含 `agent` 工具的 ToolRegistry
- 调整主 agent system prompt,明确告知它"你没有直接工具,必须通过 subagent 执行"
- 保留当前扁平模式作为 config 开关(`orchestrator_mode: bool`),便于对比和回退

### 阶段 2: Subagent 报告结构化
- 在 subagent system prompt 里要求返回 JSON 格式报告
- `run_subagent()` 解析报告,返回结构化对象而不只是文本
- agent 工具的 ToolResult 输出格式化报告

### 阶段 3: 失败重新规划
- 主 agent system prompt 增加失败处理指引(收到 failed 报告时如何重新规划)
- 可能需要在 agent 工具的 input 里加 `context` 字段,让主 agent 把前一次失败的摘要传给下一个 subagent

### 阶段 4: 路由池语义重新定义
- 文档化每个池应该配置什么类型的模型
- `/pool` 命令展示池职责说明
- 可能需要新的 subagent 类型(如 `subagent/code` 专门做编辑)

### 阶段 5: 移除扁平模式
- 验证 orchestrator 模式稳定后,删除 `orchestrator_mode` 开关
- 主 agent 永远是 orchestrator

## 6. 风险与开放问题

1. **延迟**: 简单任务的 2x API 调用延迟是否可接受?需要实测。如果不可接受,考虑阶段 1 的快速通道。
2. **主 agent 能力**: 小模型可能不擅长任务分解。`main` 池必须配置强模型,否则整个系统瘫痪。
3. **调试难度**: 多层调用链让日志和可观测性更重要。需要清晰的 subagent 报告链路追踪。
4. **权限**: subagent 已经有 auto-allow 机制,但 orchestrator 模式下主 agent 不再直接触发权限——权限决策转移到 subagent 层,需要重新审视安全模型。
5. **背景 subagent 的角色**: 当前 background subagent 机制在 orchestrator 模式下是否还有意义?主 agent 可以并发分发多个 subagent,这天然就是并行执行。
