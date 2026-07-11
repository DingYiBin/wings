/**
 * Messages — renders output history matching claude-code visual format.
 *
 * Uses Ink <Static> for completed messages so they never re-render.
 * Only the last few items (streaming text, active tool) render dynamically.
 */

import React from "react";
import { Box, Text, Static } from "ink";
import type { OutputLine } from "../app-state.ts";
import { Markdown } from "./Markdown.tsx";

const MAX_RESULT_LINES = 3;

function formatResult(content: string): string {
  const formatted = content.replace(/\t/g, "    ");
  const lines = formatted.split("\n");
  if (lines.length <= MAX_RESULT_LINES) {
    return lines.map((l, i) => (i === 0 ? l : `    ${l}`)).join("\n");
  }
  const shown = lines.slice(0, MAX_RESULT_LINES);
  return shown.map((l, i) => (i === 0 ? l : `    ${l}`)).join("\n") +
    `\n    … +${lines.length - MAX_RESULT_LINES} lines`;
}

/** Format tool input: extract key field (command/file_path), not raw JSON. */
function formatInput(name: string, input: string): string {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(input); } catch {}
  if (name === "bash") {
    const cmd = (parsed["command"] as string) ?? input;
    return cmd.length > 80 ? `(${cmd.slice(0, 77)}…)` : `(${cmd})`;
  }
  if (name === "read" || name === "write" || name === "edit") {
    const fp = (parsed["file_path"] as string) ?? input;
    return fp.length > 60 ? `(${fp.slice(0, 57)}…)` : `(${fp})`;
  }
  return input.length > 60 ? `(${input.slice(0, 57)}…)` : `(${input})`;
}

/** Whether a tool call should have a blank line above it, given the prior line.
 * Only separate from real text or a non-empty result — consecutive tool calls
 * with no visible output between them stay tight. */
function needsGap(prev: OutputLine | undefined): boolean {
  if (!prev) return false;
  if (prev.type === "text") return prev.text.trim() !== "";
  if (prev.type === "tool_result") return prev.content.trim() !== "";
  return false;
}

function renderLine(line: OutputLine, prev: OutputLine | undefined, key?: number) {
  const k = key != null ? String(key) : undefined;
  switch (line.type) {
    case "text":
      return <Markdown key={k} content={line.text} />;
    case "tool_use":
      return (
        <Box key={k} flexDirection="row" marginTop={needsGap(prev) ? 1 : 0}>
          <Text color="cyan">●</Text>
          <Text bold> {line.name}</Text>
          <Text dimColor>{formatInput(line.name, line.input)}</Text>
        </Box>
      );
    case "tool_result":
      if (line.content.trim() === "") return null;
      return (
        <Text key={k} dimColor color={line.isError ? "red" : undefined}>
          {"  ⎿ "}{formatResult(line.content)}
        </Text>
      );
    case "subagent_start":
      return <Text key={k} dimColor>{"  ┌ subagent "}{line.agentType}{" "}{line.description}</Text>;
    case "subagent_end":
      return <Text key={k} dimColor>{"  └ done"}</Text>;
    case "separator":
      return <Text key={k}> </Text>;
  }
}

export function Messages({ lines }: { lines: OutputLine[] }) {
  if (lines.length === 0) return <Box flexDirection="column" />;
  if (lines.length === 1) {
    return <Box flexDirection="column">{renderLine(lines[0]!, undefined, 0)}</Box>;
  }
  const staticLines = lines.slice(0, -1);
  const last = lines[lines.length - 1]!;

  return (
    <Box flexDirection="column">
      <Static items={staticLines}>{(line, idx) => renderLine(line, staticLines[idx - 1], idx)}</Static>
      <Box flexDirection="column">{renderLine(last, staticLines[staticLines.length - 1], staticLines.length)}</Box>
    </Box>
  );
}
