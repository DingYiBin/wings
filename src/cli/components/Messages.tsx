/**
 * Messages — renders output history matching claude-code visual format.
 *
 * ● ToolName(input)   — tool call (cyan bullet, bold name, dim input)
 *   ⎿ result          — tool result (dimmed, 2-space indent + ⎿ prefix)
 * … +N lines           — truncation indicator for long results
 */

import React from "react";
import { Box, Text } from "ink";
import type { OutputLine } from "../app-state.ts";

const MAX_RESULT_LINES = 3;

/** Format tool result: show first N lines, append truncation hint if needed. */
function formatResult(content: string): string {
  const formatted = content.replace(/\t/g, "    ");
  const lines = formatted.split("\n");
  if (lines.length <= MAX_RESULT_LINES) {
    return lines.map((l, i) => (i === 0 ? l : `    ${l}`)).join("\n");
  }
  const shown = lines.slice(0, MAX_RESULT_LINES);
  const remaining = lines.length - MAX_RESULT_LINES;
  return shown.map((l, i) => (i === 0 ? l : `    ${l}`)).join("\n") +
    `\n    … +${remaining} lines`;
}

/** Format tool input: truncate and wrap in parens. */
function formatInput(input: string): string {
  return input.length > 80 ? `(${input.slice(0, 77)}…)` : `(${input})`;
}

export function Messages({ lines }: { lines: OutputLine[] }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        switch (line.type) {
          case "text":
            return (
              <Text key={i}>{line.text}</Text>
            );
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
            return (
              <Text key={i} dimColor>
                {"  ┌ subagent "}{line.agentType}{" "}{line.description}
              </Text>
            );
          case "subagent_end":
            return (
              <Text key={i} dimColor>{"  └ done"}</Text>
            );
          case "separator":
            return <Text key={i}> </Text>;
        }
      })}
    </Box>
  );
}
