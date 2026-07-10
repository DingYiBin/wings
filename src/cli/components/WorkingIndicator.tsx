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

  const label = mode === "running" ? "Working" : "Waiting";
  const totalOutputChars = outputChars + totalOutput;

  return (
    <Text dimColor>
      {label}{".".repeat(dots)}{" ".repeat(6 - dots)}
      {"  ( input: "}{inputChars}{" chars, output: "}{totalOutputChars}{" chars )"}
    </Text>
  );
}
