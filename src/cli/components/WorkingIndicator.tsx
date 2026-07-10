import React, { useState, useEffect } from "react";
import { Text } from "ink";

export function WorkingIndicator({ inputChars, outputChars, totalOutput, visible }: { inputChars: number; outputChars: number; totalOutput: number; visible: boolean }) {
  const [dots, setDots] = useState(0);

  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setDots((d) => (d + 1) % 7), 100);
    return () => clearInterval(id);
  }, [visible]);

  if (!visible) return null;

  return (
    <Text dimColor>
      {"Working"}{".".repeat(dots)}{" ".repeat(6 - dots)}
      {"  ( input: "}{inputChars}{" chars, output: "}{outputChars + totalOutput}{" chars )"}
    </Text>
  );
}
