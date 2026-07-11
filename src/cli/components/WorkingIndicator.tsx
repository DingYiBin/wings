import React, { useState, useEffect } from "react";
import { Text } from "ink";

/** Human-readable duration: "12.3s" under a minute, else "1m23s". */
function formatDuration(ms: number): string {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

export function WorkingIndicator({ totalInput, outputChars, totalOutput, totalWaitMs, runStartMs, mode }: {
  totalInput: number; outputChars: number; totalOutput: number;
  totalWaitMs: number; runStartMs: number | null;
  mode: "ready" | "running" | "permission";
}) {
  const [dots, setDots] = useState(0);

  useEffect(() => {
    // Only animate while working. An always-on timer re-renders the live frame
    // every 100ms, which snaps the terminal to the bottom and breaks scrollback.
    // The same tick also advances the elapsed-time display below.
    if (mode !== "running") return;
    const id = setInterval(() => setDots((d) => (d + 1) % 4), 100);
    return () => clearInterval(id);
  }, [mode]);

  const isRunning = mode === "running";
  const label = isRunning ? "Working" : "Waiting";
  const d = isRunning ? ".".repeat(dots) + " ".repeat(3 - dots) : "...";
  const outputTotal = outputChars + totalOutput;
  // Cumulative API wait time: ticks while running, frozen otherwise.
  const waitMs = isRunning && runStartMs != null ? totalWaitMs + (Date.now() - runStartMs) : totalWaitMs;

  return (
    <Text dimColor>
      {label}{d}{"  "}{formatDuration(waitMs)}
      {"  ( input: "}{totalInput}{" chars, output: "}{outputTotal}{" chars )"}
    </Text>
  );
}
