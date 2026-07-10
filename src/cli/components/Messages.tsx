/**
 * Messages — renders the output history. Matches claude-code's Messages component.
 *
 * Streams text in-place while the agent is running.
 */

import React from "react";
import { Box, Text } from "ink";
import type { OutputLine } from "../app-state.ts";

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
                {"      ↳ "}{line.content}
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
