# Wings CLI: Ink/React 重构设计

> 创建: 2026-07-09
> 使用 Ink v7.1.0 (3rdparty/ink)

## 动机

当前 raw ANSI REPL 有两个无法彻底解决的问题：

1. **光标定位** — CJK 字符宽度、多行换行、插入位置的光标还原在 raw ANSI 下极其脆弱。`\x1b[N C` / `\x1b[N D` 定位依赖精确的列宽计算（ANSI 剥离、CJK 双宽度、emoji、零宽字符），任何一个计算偏差都会导致光标错位。

2. **无法使用 React 组件模型** — raw ANSI 是过程式 write()，每加一个新功能（历史面板、自动补全、多行编辑）都需要手写 ANSI 转义序列。React Ink 则是声明式：`Messages` 组件自动根据数据渲染，`PromptInput` 管理自己的光标状态，`PermissionDialog` 作为一个 overlay 出现。

Ink v7.1.0 修复了 v5 的关键缺陷（`home`/`end`/`delete`/`backspace` 在 Key 类型中可用），且我们作为 submodule 可以直接修改源码适配需求。

## 架构

### 组件树

```
<App>
  <REPL>
    <Messages lines={output} />              ← 消息历史（滚动区域）
    -------------------------------------------------  ← 分隔线
    <PromptInput                               ← 输入栏
      value={input}
      onChange={setInput}
      onSubmit={handleSubmit}
      onExit={handleExit}
    />
    {mode === 'permission' && <PermissionDialog />}  ← 权限弹窗 overlay
  </REPL>
</App>
```

### 数据流

```
agent loop async generator
  → push events into AppState store
    → components subscribe via useStore(selector)
      → re-render with new data

user input (useInput)
  → PromptInput manages cursor + buffer
    → onSubmit triggers agent loop
```

### 文件结构

```
src/cli/
  ink-app.tsx           # Ink render() 入口，stdin 包装
  app.tsx               # <App> 根组件
  repl.tsx              # <REPL> 主布局
  hooks.ts              # useStore, useAgent
  app-state.ts          # AppState store（createStore + 不可变更新）
  store.ts              # createStore<T>() 工具
  components/
    Messages.tsx         # 消息列表
    PromptInput.tsx      # 输入栏（useInput + 光标管理）
    PermissionDialog.tsx # 权限确认 overlay
```

### 关键设计决策

#### 1. 光标管理 — 用 `<Text inverse>` 替代 ANSI 定位

Ink 的 `<Text inverse>` 渲染反色字符就是光标。光标位置由 React state (`cursorPos`) 控制，Ink 负责屏幕渲染——不再手写 `\x1b[N D`。

```tsx
// PromptInput 渲染中：
<Text>{before}<Text inverse>{atCursor}</Text>{after}</Text>
```

Ink v7 的 `parseKeypress` 处理原始 stdin 字节，`useInput` 回调提供 `(input, key)` 和 `key.home`/`key.end`/`key.delete`/`key.backspace`。

#### 2. 输入/输出分离 — 用 `<Static>` 组件

Ink 的 `<Static>` 组件输出不受 React reconciliation 影响——内容一旦输出就不会被 re-render 覆盖。permission dialog 和消息输出用 `<Static>`，输入栏用普通 `<Box>`。

或者更简单：用分隔线 `───` 区分输出区和输入区。输出在上面，输入在下面。每次输出后重绘输入栏。

#### 3. Agent Loop 集成

`useAgent()` hook 负责：
- 初始化 session（`createSession` + `makeAgentContext`）
- `runTurn(userInput)` 启动 agent loop
- 把 stream events 推入 AppState store
- 权限请求通过 Promise resolver 暂停/恢复

#### 4. 权限对话框

When mode='permission', `<PermissionDialog>` renders as an overlay. It uses `useInput` with `isActive={mode==='permission'}` to capture arrow keys without conflicting with PromptInput.

#### 5. stdin 处理

Ink v7 的 `render()` 接受 `stdin` 选项。在 WSL 终端环境，`process.stdin.isTTY` 可能是 `undefined` 但 `setRawMode` 存在。处理方式：

```typescript
// 如果 setRawMode 存在，直接传 process.stdin 给 Ink
// Ink 内部的 App 组件会调用 setRawMode(true)
if (typeof (process.stdin as any).setRawMode === 'function') {
  render(<App />, { stdin: process.stdin });
} else {
  // 管道输入 fallback: readline
}
```

## 实现计划

### Phase 1: 基础布局 + 输入 ✓
- ink-app.tsx 入口（stdin 处理）
- app.tsx + repl.tsx 根布局
- PromptInput 组件（useInput + 光标管理）
- Messages 组件（消息列表）
- hooks.ts（useStore + useAgent）

### Phase 2: 权限 + 子代理
- PermissionDialog overlay
- 权限 Promise resolver 集成
- 子代理实时输出（text_delta → stdout）

### Phase 3: 增强
- 历史导航（上下键）
- 双击 Ctrl+C 退出
- 自动补全基础
- 样式优化

## 回归方案

如果 Ink 路径有问题，raw ANSI REPL (`main.ts`) 保持可用，两个入口并行。Ink 入口通过 `--ink` flag 或环境变量启用，raw ANSI 作为默认。
