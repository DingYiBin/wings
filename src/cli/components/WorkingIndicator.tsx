import React, { useState, useEffect } from "react";
import { Text } from "ink";

export function WorkingIndicator({ totalInput, outputChars, totalOutput, mode }: {
  totalInput: number; outputChars: number; totalOutput: number;
  mode: "ready" | "running" | "permission";
}) {
  const [dots, setDots] = useState(0);

  useEffect(() => {
    // Only animate while working. An always-on timer re-renders the live frame
    // every 100ms, which snaps the terminal to the bottom and breaks scrollback.
    if (mode !== "running") return;
    const id = setInterval(() => setDots((d) => (d + 1) % 4), 100);
    return () => clearInterval(id);
  }, [mode]);

  const isRunning = mode === "running";
  const label = isRunning ? "Working" : "Waiting";
  const d = isRunning ? ".".repeat(dots) + " ".repeat(3 - dots) : "...";
  const outputTotal = outputChars + totalOutput;

  return (
    <Text dimColor>
      {label}{d}
      {"  ( input: "}{totalInput}{" chars, output: "}{outputTotal}{" chars )"}
    </Text>
  );
}
