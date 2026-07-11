# OpenSquilla Dream — 记忆巩固系统

## 概述

Dream 是 OpenSquilla 的**离线记忆巩固**系统。它作为一个定时 cron 任务，周期性地扫描 `memory/` 目录中由 session flush 和其他机制积累的原始记忆笔记，经过多层筛选和 LLM 决策，将值得保留的信息写入工作区根目录的 `MEMORY.md` 文件。

**类比**：人的睡眠——白天积累大量零散记忆，夜间大脑筛选、巩固重要内容，丢弃噪声。

## 架构

### 源码位置

| 文件 | 职责 |
|------|------|
| `src/opensquilla/memory/dream/runner.py` | 主运行器，协调五个阶段 |
| `src/opensquilla/memory/dream/candidates.py` | 扫描 `memory/` 目录，收集候选 |
| `src/opensquilla/memory/dream/evidence.py` | 证据累积和持久化 |
| `src/opensquilla/memory/dream/ranking.py` | 候选评分和排序 |
| `src/opensquilla/memory/dream/prompts.py` | LLM 决策提示词 |
| `src/opensquilla/memory/dream/curated_apply.py` | 将 LLM 决策写入 MEMORY.md |
| `src/opensquilla/memory/dream/rehydrate.py` | 写前验证源文件未变 |
| `src/opensquilla/memory/dream/quarantine.py` | 隔离区，防止读自己的输出 |
| `src/opensquilla/memory/dream/receipts.py` | 运行回执和回滚记录 |
| `src/opensquilla/memory/dream/models.py` | 数据模型 |
| `src/opensquilla/memory/dream_factory.py` | 依赖注入工厂 |
| `src/opensquilla/scheduler/dream_handler.py` | 调度器桥接 |

### 配置

配置位于 `GatewayConfig.memory.dream`，默认值：

```python
enabled = false                         # 必须显式开启
interval_h = 24                         # 默认每 24 小时
cron = null                             # 自定义 cron 表达式优先
max_batch_size = 20                     # 每批最多处理 20 个候选
min_batch_size = 1                      # 最少候选数，小于此不触发
preview_mode = true                     # 默认试运行，不落盘
auto_schedule = false                   # 必须显式开启自动调度
evidence_min_score = 0.55              # 评分阈值
evidence_negative_recurrence_threshold = 2  # 负面信号需要出现 2 次
evidence_curated_writes_enabled = true
evidence_quarantine_enabled = true
```

## 五阶段处理流水线

### 阶段 1：候选扫描 (Candidate Scanning)

遍历 `memory/` 目录下的所有 `.md` 文件，排除：

- 以 `.` 开头的文件
- `MEMORY.md`（这是输出，不是输入）
- `mtime <= cursor` 的文件（只处理上次运行后新修改的）
- 隔离区文件（`.dream*` 目录、`dream-*.jsonl`、含特定标记的行）

每个候选根据关键词被归类为五种信号类型：

| 信号类型 | 关键词 |
|----------|--------|
| `manual` | `"memory:"`、`"remember that"` |
| `correction` | `"do not"`、`"don't"`、`"rejected"`、`"wrong"`、`"instead"` |
| `failure` | `"failed"`、`"error"`、`"exception"`、`"traceback"`、`"rollback"` |
| `positive` | `"prefers"`、`"accepted"`、`"successful"`、`"works"`、`"use "` |
| `neutral` | 无匹配（默认） |

候选按 mtime 排序，截断到 `max_batch_size`。如果候选数不足 `min_batch_size`，Dream 直接返回，不做任何处理。

### 阶段 2：证据累积 (Evidence Accumulation)

维护持久化证据存储 `memory/.dream_state/promotion_evidence.json`。

每个候选通过 `candidate_id = sha256(agent_id + claim_sha256)` 去重。同一观点（claim）在不同文件中多次出现，共享同一个 evidence entry。

证据追踪：
- `seen_count`：该 claim 被见过的次数
- 四种信号计数器：`positive_signal_count`、`correction_signal_count`、`failure_signal_count`、`manual_signal_count`
- `source_days`：该 claim 在多少个不同日历日出现过
- `first_seen_at` / `last_seen_at`

### 阶段 3：评分排序 (Ranking)

评分公式：

```
score = clamp(
    0.35 × frequency_confidence
  + 0.30 × signal_balance
  + 0.20 × source_confidence
  + 0.15 × consolidation_factor
)
```

各因子说明：

- **frequency_confidence**: `log(1 + seen_count) / log(7)`，出现 6 次后接近饱和
- **signal_balance**: 基础 0.55，有 positive/manual 信号 +0.3，有 manual 信号 +0.1，纯负面无正向 -0.25
- **source_confidence**: `memory_file` 来源 0.75，其他 0.5
- **consolidation_factor**: `source_days / 3`，跨越多天更可信

过滤规则：
- 纯负面且 `seen_count < 2`：跳过
- 评分 < 0.55：丢弃
- `seen_count < 1`：丢弃

结果按评分降序排列，截断到 `max_batch_size`。

### 阶段 4：LLM 决策

当前 `MEMORY.md` 内容 + 排序后的候选列表（含分数、原因、片段）组装为 prompt。

LLM 返回三种操作：

| 操作 | 含义 |
|------|------|
| `upsert` | 创建新条目或替换某 section 下的已有条目 |
| `merge` | 合并到已有条目中 |
| `skip` | 不写入 MEMORY.md |

每个操作指定：
- `candidate_ids`：引用的候选
- `section`：`## Section` 标题
- `memory_id`：稳定的条目标识
- `text`：具体的条目内容

### 阶段 5：写入 (Apply)

写入前：
1. **Rehydrate**：重新检查源文件，验证原文片段仍存在且 SHA256 匹配
2. **Backup**：保存写入前的 `MEMORY.md` 到 `memory/.dream_backups/<id>/`

写入逻辑：
- `upsert/merge`：在对应的 `## Section` 下插入 `- bullet` 条目
- 如果 section 不存在，追加到文件末尾
- 如果相同条目已存在，标记为 `represented`（无变化）
- `skip`：记录但不写入

写入后推进 cursor 到本次扫描的所有文件的最大 mtime。

## 输出产物

| 产物 | 路径 | 说明 |
|------|------|------|
| 长期记忆 | `MEMORY.md` | 按 `## Section` 组织的条目列表 |
| 证据存储 | `memory/.dream_state/promotion_evidence.json` | 所有 claim 的累积证据 |
| Cursor | `memory/.dream_cursor` | 上次处理到的时间戳 |
| 运行回执 | `memory/.dream_receipts/<id>.json` | 含回滚指令 |
| 备份 | `memory/.dream_backups/<id>/MEMORY.md` | 写入前的完整备份 |
| 日志 | `logs/dream-<agent_id>-<date>.jsonl` | JSONL 格式运行日志 |

## 调度

Dream 通过 Gateway 的内置 cron 调度器运行：

```
Gateway boot → _register_dream_crons()
  → 每个 agent 创建 "memory_dream:<agent_id>" cron job
  → 按 interval_h 或 cron 表达式定时触发
```

也可以手动触发：

```bash
opensquilla memory dream --agent main        # 手动运行
opensquilla memory dream --force             # 重置 cursor，处理所有文件
opensquilla memory dream --status            # 查看状态
opensquilla memory dream --reset-cursor      # 仅重置 cursor
```

## Kill Switch

- `OPENSQUILLA_MEMORY_DREAM_DISABLED=1`：全局禁用
- `memory.dream.enabled = false`：配置文件禁用
- `memory.dream.auto_schedule = false`：不注册 cron（可手动运行）

## 与 claude-code 的对比

| | opensquilla Dream | claude-code saveMemories |
|---|---|---|
| 触发方式 | 定时 cron（24h） | 会话结束时触发 |
| 去重 | SHA256 claim 去重 + evidence 追踪 | 无，依赖 LLM 判断 |
| 证据要求 | 同一观点需多次出现 + 跨天 + 高评分 | 无，即时写入 |
| 评分 | 加权评分公式 | 无 |
| LLM 决策 | 仅对通过评分阈值的候选 | 所有记忆一次性决策 |
| 回滚 | 完整备份 + 回执 | 无 |

Dream 的设计哲学是**审慎、低频、证据驱动**——不急着写，只写确有价值的。claude-code 则是**即时、会话级**——每次对话结束时直接把学到的东西写进去。
