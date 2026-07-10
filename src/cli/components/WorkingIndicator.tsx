import React, { useState, useEffect } from "react";
import { Text } from "ink";

export function WorkingIndicator({ charCount, visible }: { charCount: number; visible: boolean }) {
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
      {charCount > 0 ? `  ${charCount} chars` : ""}
    </Text>
  );
}
