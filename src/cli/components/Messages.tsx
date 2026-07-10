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

function formatInput(input: string): string {
  return input.length > 80 ? `(${input.slice(0, 77)}…)` : `(${input})`;
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
          <Text dimColor>{formatInput(line.input)}</Text>
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
  if (lines.length <= DYNAMIC_TAIL) {
    return <Box flexDirection="column">{lines.map(renderLine)}</Box>;
  }
  const staticLines = lines.slice(0, -DYNAMIC_TAIL);
  const dynamicLines = lines.slice(-DYNAMIC_TAIL);

  return (
    <Box flexDirection="column">
      <Static items={staticLines}>{(line) => renderLine(line, 0)}</Static>
      <Box flexDirection="column">{dynamicLines.map(renderLine)}</Box>
    </Box>
  );
}
