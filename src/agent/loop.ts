/**
 * Agent core loop — the main conversation cycle.
 *
 * Ties together model selection, permission checks, tool execution,
 * handoff detection, and query calls into a single async generator.
 *
 * Every API call (including tool-use cycles) independently selects a model
 * from the task-type candidate pool. This is the core wings differentiator:
 * users configure pools, and each model invocation is a fresh weighted-random
 * draw.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Debug logger to file.
const DLOG = process.env["WINGS_DEBUG"]
  ? (tag: string, ...args: unknown[]) => {
      const ts = new Date().toISOString().slice(11, 23);
      try { appendFileSync("/tmp/wings-debug.log", `[${ts}] ${tag} ${args.map(String).join(" ")}\n`); } catch {}
    }
  : (..._: unknown[]) => {};

import { HandoffDetector, makeTurnRecord, type TurnRecord } from "./handoff.ts";
import type {
  Message,
  MessageContent,
  StreamEvent,
  PermissionRequest,
  TextBlock,
  TextDelta,
  ThinkingDelta,
  ToolResultBlock,
  ToolUseBlock,
  SubAgentStart,
  SubAgentDelta,
  SubAgentEnd,
} from "../messages/types.ts";
import type { ModelConfig } from "../models/protocol.ts";
import type { ModelRegistry } from "../models/registry.ts";
import type { PermissionPipeline } from "../permissions/pipeline.ts";
import { suggestScope } from "../permissions/rules.ts";
import { QueryEngine } from "../query/engine.ts";
import { TokenBudget } from "../query/token_budget.ts";
import type { ModelSelector } from "../routing/protocol.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";

// -- AgentContext --

export class AgentContext {
  task_type: string;
  model_override: string | null;
  tool_context: ToolContext;
  system_prompt: string;

  constructor(opts: Partial<AgentContext> = {}) {
    this.task_type = opts.task_type ?? "main";
    this.model_override = opts.model_override ?? null;
    this.tool_context = opts.tool_context ?? {
      working_dir: ".",
      read_cache: {},
    };
    this.system_prompt = opts.system_prompt ?? "";
  }
}

// -- AgentLoop --

export class AgentLoop {
  // claude-code matched limits.
  /** Single result > this is persisted to file, model gets preview. */
  static readonly MAX_TOOL_RESULT_CHARS = 50_000;
  /** Per-message aggregate cap — largest results get persisted to stay under budget. */
  static readonly MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;
  /** First N bytes shown in the model preview when result is too large. */
  static readonly PREVIEW_CHARS = 2_000;

  private _queryEngine: QueryEngine;
  private _toolRegistry: ToolRegistry;
  private _permissionPipeline: PermissionPipeline;
  private _selector: ModelSelector;
  private _modelRegistry: ModelRegistry;
  private _handoffDetector = new HandoffDetector();
  private _turnHistory: TurnRecord[] = [];
  private _messages: Message[] = [];

  // Permission sync — Promise + resolver replaces asyncio.Event.
  private _permResolve: ((response: string) => void) | null = null;

  // Set by CLI (ESC key) to abort the current agent run.
  _aborted = false;

  // CLI-accessible state.
  skillLoader: unknown = null;
  availableSkills: Record<string, string> = {};
  skillsList: unknown = null;
  poolManager: unknown = null;
  customAgents: Record<string, unknown> = {};
  extractMemories: unknown = null;

  // Optional logger — set by CLI when --log is enabled.
  private _logger: { recordCycle(opts: Record<string, unknown>): void } | null = null;

  setLogger(logger: { recordCycle(opts: Record<string, unknown>): void } | null): void {
    this._logger = logger;
  }

  get messages(): Message[] {
    return this._messages;
  }

  get lastModel(): string {
    if (this._turnHistory.length > 0) {
      return this._turnHistory[this._turnHistory.length - 1]!.model_id;
    }
    return "";
  }

  constructor(
    queryEngine: QueryEngine,
    toolRegistry: ToolRegistry,
    permissionPipeline: PermissionPipeline,
    modelSelector: ModelSelector,
    modelRegistry: ModelRegistry,
  ) {
    this._queryEngine = queryEngine;
    this._toolRegistry = toolRegistry;
    this._permissionPipeline = permissionPipeline;
    this._selector = modelSelector;
    this._modelRegistry = modelRegistry;
  }

  /** Set the user's response to a pending permission request. */
  setPermissionResponse(response: string): void {
    DLOG("LOOP-SETPERM", response, "_permResolve=" + !!this._permResolve);
    this._permResolve?.(response);
  }

  /** Run one turn of the agent loop.
   *
   * Yields stream events for assistant output. Tool execution is
   * transparent — results are injected into the message list and the
   * loop continues until end_turn.
   */
  async *run(
    userInput: string,
    context: AgentContext,
    config?: ModelConfig | null,
  ): AsyncGenerator<StreamEvent> {
    this._assembleMessages(userInput, context);

    // Inject pending background agent results.
    const pending = (context.tool_context as any)._pending_background as
      | Array<{ description: string; result: string }>
      | undefined;
    if (pending) {
      while (pending.length > 0) {
        const item = pending.shift()!;
        this._messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `[Background agent completed: ${item.description}]\n\n${item.result}`,
            },
          ],
        });
      }
    }

    let turn: TurnRecord | null = null;
    let isFirstCycle = true;

    while (true) {
      // Check for ESC abort.
      if (this._aborted) {
        this._aborted = false;
        return; // exit the run loop
      }

      // -- Select model for *this* API call --
      const model = this._selectModel(context);
      const cfg = config ?? this._modelRegistry.buildConfig(model);

      // Record turn from the first cycle's model selection.
      if (!turn) {
        const [providerName, , serviceModel] = model.split("/");
        turn = makeTurnRecord(this._turnHistory.length, model, {
          provider_name: providerName!,
          service_model: serviceModel!,
          user_input_summary: userInput.slice(0, 200),
        });

        // Handoff detection (main conversation only).
        if (context.task_type === "main") {
          const handoff = this._handoffDetector.detect(
            model,
            this._turnHistory,
          );
          if (handoff) {
            this._messages.push({
              role: "user",
              content: [{ type: "text", text: handoff }],
            });
          }
        }
        this._turnHistory.push(turn);
      }

      // -- Check token budget, compact if needed --
      if (this._needsCompact(context, cfg)) {
        await this._compactMessages(context, cfg);
      }

      // Stream phase — collect deltas and final blocks.
      const toolUseBlocks: ToolUseBlock[] = [];
      const textBlocks: TextBlock[] = [];
      const thinkingBlocks: import("../messages/types.ts").ThinkingBlock[] = [];
      const cycleToolCalls: string[] = [];
      let streamedText = false;
      const thinkingParts: string[] = [];

      for await (const event of this._queryEngine.stream(
        this._messages,
        model,
        this._toolRegistry.getSchemas() as Record<string, unknown>[],
        cfg,
      )) {
        // ESC abort during streaming — stop collecting events.
        if (this._aborted) break;

        if (event.type === "thinking_delta") {
          streamedText = true;
          thinkingParts.push((event as ThinkingDelta).text);
          yield event;
        } else if (event.type === "text_delta") {
          streamedText = true;
          yield event;
        } else if (event.type === "text") {
          textBlocks.push(event as unknown as TextBlock);
          if (!streamedText) {
            yield { type: "text_delta", text: (event as any).text };
          }
        } else if (event.type === "tool_use") {
          toolUseBlocks.push(event as unknown as ToolUseBlock);
        } else if (event.type === "thinking") {
          // Preserve thinking blocks in message history.
          // DeepSeek and compatibles require thinking content to be
          // passed back in subsequent API requests.
          thinkingBlocks.push(event as unknown as import("../messages/types.ts").ThinkingBlock);
        }
      }

      // Log every API cycle.
      if (this._logger) {
        let sysPrompt = "";
        if (isFirstCycle) {
          const first = this._messages[0];
          if (first?.role === "system") {
            for (const b of first.content) {
              if (b.type === "text") { sysPrompt = b.text; break; }
            }
          }
        }
        const cycleTools = toolUseBlocks.map((b) => b.name);
        this._logger.recordCycle({
          model,
          context: context.task_type,
          message_count: this._messages.length,
          input_summary: isFirstCycle ? userInput : `[tool results: ${cycleTools.join(", ") || "none"}]`,
          system_prompt: sysPrompt,
          response: { content: [...textBlocks, ...toolUseBlocks] },
          tool_calls: cycleTools,
          thinking: thinkingParts.length > 0 ? thinkingParts.join("") : null,
        });
      }

      // ESC abort after streaming — skip tool execution.
      if (this._aborted) {
        if (textBlocks.length > 0) {
          this._messages.push({ role: "assistant", content: [...thinkingBlocks, ...textBlocks] });
        }
        this._messages.push({ role: "user", content: [{ type: "text", text: "[interrupted by user]" }] });
        this._aborted = false;
        return;
      }

      // Execute tools.
      if (toolUseBlocks.length > 0) {
        // Yield tool_use blocks for CLI display.
        for (const block of toolUseBlocks) {
          yield block;
        }

        const assistantContent: MessageContent[] = [
          ...thinkingBlocks,
          ...textBlocks,
          ...toolUseBlocks,
        ];
        this._messages.push({ role: "assistant", content: assistantContent });

        // Collect all tool results into a single user message.
        const toolResults: ToolResultBlock[] = [];
        const toolResultOutputs = new Map<string, string>(); // tool_use_id → original output
        let permissionDenied = false;

        for (const block of toolUseBlocks) {
          if (this._aborted) break; // ESC abort — skip remaining tools
          const tool = this._toolRegistry.get(block.name);
          if (!tool) {
            const tr: ToolResultBlock = {
              type: "tool_result",
              tool_use_id: block.id,
              content: `unknown tool: ${block.name}`,
              is_error: true,
            };
            toolResults.push(tr);
            yield tr;
            continue;
          }

          const permResult = await this._permissionPipeline.check(
            tool as unknown as import("../tools/types.ts").Tool,
            block.input,
            context.tool_context,
          );
          if (permResult === "deny") {
            const tr: ToolResultBlock = {
              type: "tool_result",
              tool_use_id: block.id,
              content: "permission denied",
              is_error: true,
            };
            toolResults.push(tr);
            yield tr;
            continue;
          }

          if (permResult === "ask") {
            // Interactive approval.
            // IMPORTANT: set up the permission Promise BEFORE yielding.
            // The CLI (doTurn) uses blocking /dev/tty reads for the permission
            // prompt, which means it calls setPermissionResponse immediately
            // after the user answers — before the generator gets a chance to
            // advance past this yield. If _permResolve isn't set yet, the
            // response is silently lost and the agent loop deadlocks.
            const permPromise = new Promise<string>((resolve) => {
              this._permResolve = resolve;
            });
            DLOG("LOOP-AWAIT", "_permResolve set, yielding pr...");

            const scope = suggestScope(block.name, block.input);
            const pr: PermissionRequest = {
              type: "permission_request",
              tool_name: block.name,
              tool_input: block.input,
              scope: scope ?? undefined,
            };
            yield pr;

            // Wait for user response.
            DLOG("LOOP-AWAIT", "awaiting permPromise...");
            const response = await permPromise;
            DLOG("LOOP-AWAIT", "resolved:", response, "continuing tool exec...");

            if (response === "allow_always") {
              (this._permissionPipeline as any)._rules.addAllow(
                block.name,
                scope ?? undefined,
              );
            } else if (response === "deny") {
              const tr: ToolResultBlock = {
                type: "tool_result",
                tool_use_id: block.id,
                content: "permission denied by user",
                is_error: true,
              };
              toolResults.push(tr);
              yield tr;
              permissionDenied = true;
              continue;
            }
          }

          // Check ESC abort before executing tool.
          if (this._aborted) {
            this._aborted = false;
            const trAbort: ToolResultBlock = {
              type: "tool_result", tool_use_id: block.id,
              content: "interrupted by user", is_error: true,
            };
            toolResults.push(trAbort);
            yield trAbort;
            permissionDenied = true;
            continue;
          }

          cycleToolCalls.push(block.name);
          turn.tool_calls.push(block.name);

          // Agent tool: set up subagent event capture. Events are buffered
          // and replayed (as subagent_delta/tool_use/tool_result) after the
          // subagent completes — mirrors Python loop.py _capture (no direct
          // stdout writes; the CLI renders the replayed events).
          const subagentEvents: StreamEvent[] = [];
          if (block.name === "agent") {
            const capture = (evt: unknown) => {
              subagentEvents.push(evt as StreamEvent);
            };
            context.tool_context.event_callback = capture;
            const saStart: SubAgentStart = {
              type: "subagent_start",
              agent_type: (block.input["subagent_type"] as string) ?? "general",
              description: (block.input["description"] as string) ?? "",
            };
            yield saStart;
          }

          let toolResult: import("../tools/types.ts").ToolResult;
          try {
            DLOG("LOOP-EXEC", "executing tool:", block.name);
            toolResult = await (tool as unknown as import("../tools/types.ts").Tool).call(
              block.input,
              context.tool_context,
            );
            DLOG("LOOP-EXEC", "tool done:", block.name);
          } catch (exc) {
            const tr: ToolResultBlock = {
              type: "tool_result",
              tool_use_id: block.id,
              content: `tool error: ${exc}`,
              is_error: true,
            };
            toolResults.push(tr);
            yield tr;
            continue;
          }

          // Agent tool: yield captured subagent events.
          if (block.name === "agent") {
            for (const evt of subagentEvents) {
              if (evt.type === "text_delta") {
                const sd: SubAgentDelta = {
                  type: "subagent_delta",
                  text: (evt as any).text,
                };
                yield sd;
              } else if (
                evt.type === "tool_use" ||
                evt.type === "tool_result"
              ) {
                yield evt as any;
              }
            }
            const saEnd: SubAgentEnd = {
              type: "subagent_end",
              agent_type: (block.input["subagent_type"] as string) ?? "general",
            };
            yield saEnd;
            context.tool_context.event_callback = null;
          }

          // Persist large results to disk (claude-code pattern).
          const limit = toolResult.max_result_size_chars ?? AgentLoop.MAX_TOOL_RESULT_CHARS;
          const displayContent = await AgentLoop._persistToolResult(
            toolResult.output, block.id, limit,
          );
          // Keep original for aggregate budget enforcement.
          toolResultOutputs.set(block.id, toolResult.output);

          const tr: ToolResultBlock = {
            type: "tool_result",
            tool_use_id: block.id,
            content: displayContent,
            is_error: toolResult.error != null,
          };
          toolResults.push(tr);
          yield tr;

          // Post-tool-use hooks.
          await this._permissionPipeline.runPostToolUse(
            block.name,
            block.input,
            tr.content,
          );
        }

        // Apply per-message aggregate tool result budget.
        await AgentLoop._applyToolResultBudget(toolResults, toolResultOutputs);

        this._messages.push({
          role: "user",
          content: toolResults,
        });

        // Log tool execution cycle.
        if (this._logger && cycleToolCalls.length > 0) {
          this._logger.recordCycle({
            model,
            context: context.task_type,
            message_count: this._messages.length,
            input_summary: `[tool results: ${cycleToolCalls.join(", ")}]`,
            response: { content: toolUseBlocks },
            tool_calls: cycleToolCalls,
            tool_results: toolResults.map((tr) => tr.content),
          });
        }

        // If user denied permission, stop the turn.
        if (permissionDenied) {
          turn.summary = "permission denied by user";
          return;
        }

        isFirstCycle = false;
        continue; // loop back for next chat call with fresh model selection
      }

      // No tools — end turn.
      if (textBlocks.length > 0 || thinkingBlocks.length > 0) {
        this._messages.push({
          role: "assistant",
          content: [...thinkingBlocks, ...textBlocks],
        });
      }
      turn.summary = this._lastAssistantText().slice(0, 200);
      turn.model_id = model;
      return; // end_turn
    }
  }

  // -- Internal helpers --

  private _selectModel(context: AgentContext): string {
    return this._selector.select(context.task_type, context.model_override);
  }

  /**
   * Handle a large tool result: persist full output to disk, return a
   * preview for the model. Matches claude-code's maybePersistLargeToolResult.
   */
  private static async _persistToolResult(
    output: string,
    toolUseId: string,
    limit: number,
  ): Promise<string> {
    if (output.length <= limit) return output;

    const preview = output.slice(0, AgentLoop.PREVIEW_CHARS);
    // Cut at last newline in preview when possible.
    const lastNl = preview.lastIndexOf("\n");
    const cutPoint = lastNl > AgentLoop.PREVIEW_CHARS * 0.5 ? lastNl : AgentLoop.PREVIEW_CHARS;
    const previewText = output.slice(0, cutPoint);
    const hasMore = cutPoint < output.length;

    // Persist to disk in session directory.
    const { getSessionToolResultsDir } = await import("../services/session-paths.ts");
    const dir = getSessionToolResultsDir();
    let filePath: string;
    try {
      mkdirSync(dir, { recursive: true });
      filePath = join(dir, `${toolUseId}.txt`);
      writeFileSync(filePath, output);
    } catch {
      filePath = "[write failed]";
    }

    const sizeKB = (output.length / 1024).toFixed(1);
    return [
      `<persisted-output>`,
      `Output too large (${sizeKB} KB). Full output saved to: ${filePath}`,
      ``,
      `Preview (first ${(previewText.length / 1024).toFixed(1)} KB):`,
      previewText,
      hasMore ? `\n... [${((output.length - cutPoint) / 1024).toFixed(1)} KB more]` : "",
      `</persisted-output>`,
    ].join("\n");
  }

  /**
   * Apply per-message aggregate budget. If total tool results in one turn
   * exceed MAX_TOOL_RESULTS_PER_MESSAGE_CHARS, persist the largest results.
   */
  private static async _applyToolResultBudget(
    results: ToolResultBlock[],
    originalOutputs: Map<string, string>,
  ): Promise<void> {
    let total = results.reduce((sum, r) => sum + r.content.length, 0);
    if (total <= AgentLoop.MAX_TOOL_RESULTS_PER_MESSAGE_CHARS) return;

    // Sort by size descending, persist largest first.
    const indexed = results
      .map((r, i) => ({ r, i, len: r.content.length }))
      .sort((a, b) => b.len - a.len);

    for (const { r, i, len } of indexed) {
      if (total <= AgentLoop.MAX_TOOL_RESULTS_PER_MESSAGE_CHARS) break;
      const original = originalOutputs.get(r.tool_use_id);
      if (!original) continue;
      const persisted = await AgentLoop._persistToolResult(
        original, r.tool_use_id, 1,
      );
      total = total - len + persisted.length;
      results[i] = { ...r, content: persisted };
    }
  }

  private _needsCompact(context: AgentContext, cfg: ModelConfig): boolean {
    if (this._messages.length < 6) return false;
    const budget = new TokenBudget(cfg.context_window, {
      systemPromptTokens: Math.floor(
        context.system_prompt.length / TokenBudget.CHARS_PER_TOKEN,
      ),
    });
    return budget.needsCompact(this._messages);
  }

  private async _compactMessages(
    context: AgentContext,
    cfg: ModelConfig,
  ): Promise<void> {
    const { compactMessages } = await import("../services/compact.ts");
    const model = this._selectModel(context);
    this._messages = await compactMessages(this._messages, {
      queryEngine: this._queryEngine,
      model,
      config: cfg,
    });
    if (this._logger) {
      this._logger.recordCycle({
        model,
        context: context.task_type,
        message_count: this._messages.length,
        input_summary: "[compaction performed]",
        response: { content: [] },
        tool_calls: [],
      });
    }
  }

  private _assembleMessages(
    userInput: string,
    context: AgentContext,
  ): void {
    if (context.system_prompt && this._messages.length === 0) {
      this._messages.push({
        role: "system",
        content: [{ type: "text", text: context.system_prompt }],
      });
    }
    this._messages.push({
      role: "user",
      content: [{ type: "text", text: userInput }],
    });
  }

  private _lastAssistantText(): string {
    for (let i = this._messages.length - 1; i >= 0; i--) {
      const msg = this._messages[i]!;
      if (msg.role === "assistant") {
        const texts = msg.content
          .filter((b) => b.type === "text")
          .map((b) => (b as TextBlock).text);
        return texts.join(" ");
      }
    }
    return "";
  }
}
