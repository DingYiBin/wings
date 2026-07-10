/**
 * Messages — renders output history matching claude-code visual format.
 *
 * Uses Ink <Static> for completed messages so they never re-render.
 * Only the last few items (streaming text, active tool) render dynamically.
 */

import React from "react";
import { Box, Text, Static } from "ink";
import type { OutputLine } from "../app-state.ts";

const MAX_RESULT_LINES = 3;
const DYNAMIC_TAIL = 4; // last N items rendered dynamically for streaming updates

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

function renderLine(line: OutputLine, i: number) {
  switch (line.type) {
    case "text":
      return <Text key={i}>{line.text}</Text>;
    case "tool_use":
      return (
        <Box key={i} flexDirection="row" marginTop={1}>
          <Text color="cyan">●</Text>
          <Text bold> {line.name}</Text>
          <Text dimColor>{formatInput(line.name, line.input)}</Text>
        </Box>
      );
    case "tool_result":
      return (
        <Text key={i} dimColor color={line.isError ? "red" : undefined}>
          {"  ⎿ "}{formatResult(line.content)}
        </Text>
      );
    case "subagent_start":
      return <Text key={i} dimColor>{"  ┌ subagent "}{line.agentType}{" "}{line.description}</Text>;
    case "subagent_end":
      return <Text key={i} dimColor>{"  └ done"}</Text>;
    case "separator":
      return <Text key={i}> </Text>;
  }
}

export function Messages({ lines }: { lines: OutputLine[] }) {
  // Clip to terminal height to prevent Ink frame overflow and scroll jumping.
  const termRows = process.stdout.rows || 24;
  const maxLines = Math.max(6, termRows - 8); // reserve for header, prompt, dividers
  const visible = lines.length > maxLines ? lines.slice(-maxLines) : lines;

  if (visible.length <= DYNAMIC_TAIL) {
    return <Box flexDirection="column">{visible.map(renderLine)}</Box>;
  }
  const staticLines = visible.slice(0, -DYNAMIC_TAIL);
  const dynamicLines = visible.slice(-DYNAMIC_TAIL);

  return (
    <Box flexDirection="column">
      {lines.length > maxLines && <Text dimColor>  … {lines.length - maxLines} earlier lines</Text>}
      <Static items={staticLines}>{(line) => renderLine(line, 0)}</Static>
      <Box flexDirection="column">{dynamicLines.map(renderLine)}</Box>
    </Box>
  );
}
