/**
 * StatusBar — contextual hints below the input area. Matches claude-code.
 */

import React from "react";
import { Text } from "ink";

export function StatusBar({
  mode, showExitHint, showAbortHint,
}: {
  mode: "ready" | "running" | "permission";
  showExitHint: boolean;
  showAbortHint: boolean;
}) {
  if (mode === "running" && showAbortHint) {
    return <Text dimColor>  Esc or Ctrl+C to stop</Text>;
  }
  if (mode === "ready" && showExitHint) {
    return <Text dimColor>  Press Ctrl+C again to exit</Text>;
  }
  if (mode === "ready") {
    return <Text dimColor>  Ctrl+C twice to exit</Text>;
  }
  return <Text> </Text>;
}
