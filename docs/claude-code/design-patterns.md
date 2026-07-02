# Claude Code — 可参考的设计模式

## 1. Feature Flag 死代码消除

`bun:bundle` / `feature()` 模式：构建时完全消除未激活 flags 对应的代码路径。开发时 shim 读取 `FEATURE_FLAGS` 环境变量。避免将实验代码发布到生产环境，同时保持在开发中可用。

## 2. 双层状态架构

分离可变会话状态 (bootstrap) 和不可变 UI 状态 (AppState)，防止非 UI 代码路径中的 React 耦合。Bootstrap 状态模块为每个字段导出独立的 getter/setter — 无单体 store 类型。

## 3. 工具/命令接口抽象

每个工具和命令实现一致的接口，包含 `isEnabled()`, `isReadOnly()`, `isConcurrencySafe()`, `isSearchOrReadCommand()` 方法。这使得权限决策、UI 分组和并行执行可以自动化，调用者无需了解工具内部。

## 4. 循环依赖的延迟导入模式

当模块 A 导入 B 而 B 也需要 A 时，B 使用 getter 函数模式:
```typescript
const getTeamCreateTool = () => require('./TeamCreateTool.js').TeamCreateTool
```
这推迟解析到调用时，在所有模块加载之后。

## 5. 模块评估时的并行预取

重量级初始化 (MDM 设置读取、keychain 访问) 在模块顶层作为副作用触发，在导入图的其余部分被评估之前。结果稍后在 Commander pre-action 钩子中 await，有效地将其延迟隐藏在模块加载时间背后。

## 6. 重型导入延迟

```typescript
void Promise.all([
  import('../services/analytics/firstPartyEventLogger.js'),
  import('../services/analytics/growthbook.js'),
]).then(...)
```
`initializeTelemetry` 仅当 `setMeterState()` 被调用时通过 `import()` 延迟加载。

## 7. 权限管道模式

多层权限检查 (静态规则 -> hooks -> classifier -> 用户交互) 组合在管道中。每层可以做出决定或传递。`ResolveOnce` 模式确保只有一层"赢得"竞争。

## 8. Commander 之前的 CLI 参数预处理

`main()` 函数在传递给 Commander 之前预处理 `process.argv`，处理特殊情况如 `claude ssh`, `claude assistant`, deep link URIs, direct connect URLs。

## 9. 事件汇架构

Analytics 事件排队直到 sink 被附件。`initSinks()` 是幂等的，可从多个代码路径调用（默认命令 vs 子命令），防止事件丢失。

## 10. Schema-First 配置

所有用户配置 (settings.json, CLAUDE.md, MCP configs, keybindings) 都通过 Zod schema 校验。在早期以清晰消息捕获配置错误。

## 11. 启动序列优化

```
1. process starts -> cli.tsx
2. 副作用触发:
   - profileCheckpoint('main_tsx_entry')
   - startMdmRawRead() -- spawn MDM 子进程
   - startKeychainPrefetch() -- 生成 keychain 读取
3. 模块图加载 (~135ms)  ← 隐藏 I/O 延迟
4. main() 函数调用:
   - 安全设置
   - CLI 参数预处理
   - 确定交互/非交互模式
   - run():
     - preAction 钩子: await MDM + keychain, init(), telemetry, migrations
     - 加载远程管理设置
     - 上传用户设置
```
