/**
 * PromptInput — the input bar at the bottom. Matches claude-code's PromptInput.
 *
 * Uses Ink's useInput for raw keystroke capture. Shows ▸ cursor.
 */

import React from "react";
import { Box, Text, useInput } from "ink";

export function PromptInput({
  value,
  mode,
  onChange,
  onSubmit,
}: {
  value: string;
  mode: "ready" | "running" | "permission";
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
}) {
  useInput((char, key) => {
    if (mode !== "ready") return;

    if (key.return) {
      const trimmed = value.trim();
      if (trimmed) {
        onChange("");
        onSubmit(trimmed);
      }
    } else if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
    } else if (char && char.length === 1 && !key.ctrl) {
      onChange(value + char);
    }
  });

  if (mode === "running") {
    return (
      <Box>
        <Text color="green">▸ </Text>
        <Text dimColor>…</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color="green">▸ </Text>
      <Text>{value}</Text>
    </Box>
  );
}
