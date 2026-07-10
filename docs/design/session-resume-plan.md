# Session Resume 设计

> 创建: 2026-07-10

## 目标

1. `--resume <hash>` — 通过 session hash 恢复之前的会话
2. `--continue` — 恢复当前项目目录最近一次的会话

## 需要持久化的数据

每次 turn 结束后，将完整消息历史追加写入 `~/.wings/sessions/<hash>/messages.jsonl`：

```jsonl
{"role":"system","content":[{"type":"text","text":"You are Wings..."}]}
{"role":"user","content":[{"type":"text","text":"你好"}]}
{"role":"assistant","content":[{"type":"text","text":"你好！我是 Wings..."}]}
{"role":"user","content":[{"type":"text","text":"分析一下这个仓"}]}
{"role":"assistant","content":[{"type":"text","text":"好的，让我来看看..."},{"type":"tool_use","id":"...","name":"bash","input":{...}}]}
{"role":"user","content":[{"type":"tool_result","tool_use_id":"...","content":"..."}]}
```

每行一个 Message 对象（JSON 序列化）。恢复时逐行读取，重建 `this._messages` 数组。

### 还需要保存

| 数据 | 用途 | 文件 |
|------|------|------|
| Message history | 恢复上下文 | `messages.jsonl` |
| Turn history | Handoff 检测 | `turns.jsonl`（可选，首次实现可跳过） |
| Session metadata | 列表展示 | `meta.json` |

### `meta.json`

```json
{
  "hash": "abc123def456",
  "cwd": "/home/hugo/workspace/wings",
  "created": "2026-07-10T12:00:00Z",
  "updated": "2026-07-10T12:30:00Z",
  "turnCount": 5,
  "model": "dpsk-flash/deepseek-v4-flash"
}
```

## Session Index

`~/.wings/sessions/index.json` — 按项目路径索引最近 session：

```json
{
  "/home/hugo/workspace/wings": ["abc123", "def456"],
  "/home/hugo/other-project": ["ghi789"]
}
```

- `--continue` 时读取此文件，取第一个 hash
- 每次创建/更新 session 时更新 index
- 每个项目最多保留 10 条记录

## 改动点

### 1. `src/services/session-paths.ts`

```typescript
// 新增
getSessionMessagesPath(): string   // <sessionDir>/messages.jsonl
getSessionMetaPath(): string       // <sessionDir>/meta.json
getSessionIndexPath(): string      // ~/.wings/sessions/index.json

// 新增函数
saveMessages(hash, messages)       // 追加写入 messages.jsonl
loadMessages(hash): Message[]      // 读取 messages.jsonl
saveMeta(hash, meta)               // 写入 meta.json
loadMeta(hash): SessionMeta|null   // 读取 meta.json
updateSessionIndex(cwd, hash)      // 更新 index.json
getLatestSessionHash(cwd): string|null  // 从 index 取最新 hash
listSessions(cwd?): SessionMeta[]  // 列出 session
```

### 2. `src/cli/bootstrap.ts`

```typescript
// 新增参数
createSession(workingDir?, logger?, resumeHash?)

// 如果 resumeHash 不为空：
// 1. 从 messages.jsonl 加载消息历史
// 2. 创建 AgentLoop
// 3. 将消息注入 loop._messages
```

### 3. `src/cli/main.ts` (runChat)

```typescript
// 每次 doTurn 结束后调用 saveMessages
saveMessages(sessionHash, loop.messages);
```

### 4. `src/index.ts`

```typescript
// 新增 flag 解析
--resume <hash>     // wings chat --resume abc123
--continue          // wings chat --continue
--list-sessions     // wings chat --list-sessions
```

### 5. AgentLoop 改动

```typescript
class AgentLoop {
  // 新增: 从保存的消息恢复
  static fromMessages(messages: Message[], ...): AgentLoop

  // 或者：setter
  setMessages(msgs: Message[]): void
}
```

## 实现步骤

### Step 1: 持久化基础设施
- `session-paths.ts` 新增路径函数
- `saveMessages()` / `loadMessages()` / `saveMeta()` / `loadMeta()`
- Session index 管理

### Step 2: 写入侧
- `main.ts` doTurn 结束后调用 saveMessages
- 保存 meta.json
- 更新 index

### Step 3: 读取侧
- index.ts 解析 `--resume` / `--continue`
- bootstrap.ts 支持从文件恢复
- AgentLoop 支持注入已有消息

### Step 4: 列表命令
- `--list-sessions` 列出当前项目的历史 session
- 显示 hash、时间、turn 数

## 不做的

- Turn history (handoff) 的恢复 — 首次实现跳过，handoff 在新 session 中重新开始
- 跨项目 session 恢复 — 只支持同项目 session
- session 删除/清理 — 后续版本
