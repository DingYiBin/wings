/**
 * Ink entry point — renders the App component tree.
 */

import React from "react";
import { render } from "ink";
import { App } from "./app.tsx";

export function runInkApp() {
  const { waitUntilExit } = render(React.createElement(App));
  return waitUntilExit();
}
