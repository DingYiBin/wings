import React, { useState, useEffect } from "react";
import { Text } from "ink";

export function WorkingIndicator({ inputChars, outputChars, totalOutput, mode }: {
  inputChars: number; outputChars: number; totalOutput: number;
  mode: "ready" | "running" | "permission";
}) {
  const [dots, setDots] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setDots((d) => (d + 1) % 7), 100);
    return () => clearInterval(id);
  }, []);

  const isRunning = mode === "running";
  const label = isRunning ? "Working" : "Waiting";
  const d = isRunning ? ".".repeat(dots) + " ".repeat(6 - dots) : "......";
  const totalOutputChars = outputChars + totalOutput;

  return (
    <Text dimColor>
      {label}{d}
      {"  ( input: "}{inputChars}{" chars, output: "}{totalOutputChars}{" chars )"}
    </Text>
  );
}
