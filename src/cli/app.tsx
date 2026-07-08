/**
 * App — root component. Matches claude-code's App.tsx.
 *
 * Wraps REPL with any future providers (theme, keybindings, etc.).
 */

import React from "react";
import { REPL } from "./repl.tsx";

export function App() {
  return <REPL />;
}
