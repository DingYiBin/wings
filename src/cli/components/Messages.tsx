/**
 * Messages — renders the output history. Matches claude-code's Messages component.
 *
 * Streams text in-place while the agent is running.
 */

import React from "react";
import { Box, Text } from "ink";
import type { OutputLine } from "../app-state.ts";

/** Format tool result for display: replace tabs, indent multi-line output. */
function formatResult(content: string): string {
  // Replace tabs with 4 spaces for consistent display.
  let formatted = content.replace(/\t/g, "    ");
  // Split into lines and indent continuation lines.
  const lines = formatted.split("\n");
  if (lines.length <= 1) return formatted;
  // First line is the summary (e.g. "Read N lines from path"),
  // subsequent lines are the content and get indented.
  return lines.map((l, i) => i === 0 ? l : `    ${l}`).join("\n");
}

export function Messages({ lines }: { lines: OutputLine[] }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        switch (line.type) {
          case "text":
            return (
              <Text key={i} dimColor={line.streaming}>
                {line.text}
              </Text>
            );
          case "tool_use":
            return (
              <Text key={i} dimColor>
                {"  ⚙ "}{line.name}{" "}{line.input}
              </Text>
            );
          case "tool_result":
            return (
              <Text key={i} dimColor color={line.isError ? "red" : undefined}>
                {"      ↳ "}{formatResult(line.content)}
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
