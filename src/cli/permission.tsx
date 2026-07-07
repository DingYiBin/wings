/**
 * Permission prompt with arrow-key cursor navigation.
 *
 * Matches claude-code / wings Python UI:
 *   ❯ 1. Yes                                       (selected, bold)
 *     2. Yes, and don't ask again for bash(git:*)   (dimmed)
 *     3. No, tell Wings what to do differently      (dimmed)
 *
 * Up/Down/j/k move cursor. Enter selects. y=allow, n/esc=deny.
 *
 * In Bun without setRawMode, falls back to numbered readline input.
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";

// -- ANSI cursor control --
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";
const CURSOR_UP = (n: number) => `\x1b[${n}A`;

function dim(s: string) { return `${DIM}${s}${RESET}`; }

interface Option {
  value: string;
  label: string;
}

function buildOptions(
  toolName: string,
  scope?: string,
): Option[] {
  const alwaysLabel = scope
    ? `Yes, and don't ask again for ${toolName}(${scope})`
    : `Yes, and don't ask again for ${toolName}`;
  return [
    { value: "allow", label: "Yes" },
    { value: "allow_always", label: alwaysLabel },
    { value: "deny", label: "No, tell Wings what to do differently" },
  ];
}

function render(
  inputDesc: string,
  options: Option[],
  selected: number,
): string {
  const lines: string[] = [];

  // Top border: ┌ bash ───────────────────┐
  const inputShort = inputDesc.length > 72 ? inputDesc.slice(0, 69) + dim("…") : inputDesc;
  lines.push(`\n  ${CYAN}┌${RESET} ${YELLOW}Permission${RESET} ${dim("─".repeat(Math.max(1, 66 - "Permission".length)))}`);

  // Input description.
  lines.push(`  │ ${dim(inputShort)}`);

  // Blank line.
  lines.push(`  │`);

  // Options.
  for (let i = 0; i < options.length; i++) {
    const isSel = i === selected;
    const prefix = isSel ? ` ${YELLOW}❯${RESET}` : `  `;
    const { label } = options[i]!;
    if (isSel) {
      lines.push(`  │${prefix} ${BOLD}${GREEN}${label}${RESET}`);
    } else {
      lines.push(`  │${prefix} ${dim(label)}`);
    }
  }

  // Footer.
  lines.push(`  │`);
  lines.push(`  │ ${dim("↑↓ to select  ·  Enter to confirm  ·  y=allow  n=deny  esc=deny")}`);

  // Bottom border.
  lines.push(`  ${dim("└" + "─".repeat(68))}`);

  return lines.join("\n");
}

/** Read a single key from raw stdin. Handles ANSI arrow-key sequences. */
function readKey(): Promise<string> {
  const stdin = process.stdin as any;
  return new Promise((resolve) => {
    const buf = Buffer.alloc(16);

    const onData = (chunk: Buffer) => {
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(false);
      resolve(chunk.toString("utf-8"));
    };

    const timer = setTimeout(() => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(false);
      resolve("");
    }, 300_000); // 5 min timeout

    stdin.setRawMode?.(true);
    stdin.on("data", onData);
  });
}

/** Parse a raw key sequence into a semantic action. */
function parseKey(raw: string): { action: "up" | "down" | "select" | "allow" | "deny" | "always" | "ignore" } {
  if (raw === "\x1b[A" || raw === "k") return { action: "up" };
  if (raw === "\x1b[B" || raw === "j") return { action: "down" };
  if (raw === "\r" || raw === "\n") return { action: "select" };
  if (raw === "y" || raw === "Y") return { action: "allow" };
  if (raw === "n" || raw === "N") return { action: "deny" };
  if (raw === "\x1b" || raw === "\x03") return { action: "deny" }; // Esc or Ctrl+C
  if (raw === "a" || raw === "A") return { action: "always" };
  if (raw.length === 1 && (raw[0] === "1" || raw[0] === "2" || raw[0] === "3")) {
    return { action: "select" }; // number keys select directly
  }
  return { action: "ignore" };
}

/** Map number key + selected index to option value. */
function numberToValue(key: string, options: Option[]): string | null {
  const n = parseInt(key);
  if (n >= 1 && n <= options.length) {
    return options[n - 1]!.value;
  }
  return null;
}

/**
 * Show an arrow-key-navigable permission prompt.
 *
 * Falls back to simple numbered prompt if raw mode is unavailable (piped stdin).
 */
async function promptPermissionInteractive(
  toolName: string,
  toolInput: Record<string, unknown>,
  scope?: string,
): Promise<string> {
  const inputDesc = JSON.stringify(toolInput);
  const options = buildOptions(toolName, scope);

  // Check if raw mode is available.
  const hasRawMode = typeof (process.stdin as any).setRawMode === "function";

  if (!hasRawMode) {
    // Fallback: simple numbered prompt.
    return promptPermissionFallback(toolName, toolInput, scope, options);
  }

  // Raw mode: render interactive UI.
  let selected = 0;
  const numLines = options.length + 7; // borders + input + footer

  process.stdout.write(HIDE_CURSOR);
  try {
    while (true) {
      // Render.
      process.stdout.write(render(inputDesc, options, selected) + "\n");

      const raw = await readKey();
      const parsed = parseKey(raw);

      // Handle number keys directly.
      if (parsed.action === "select" && raw.length === 1) {
        const numVal = numberToValue(raw, options);
        if (numVal) {
          process.stdout.write(SHOW_CURSOR);
          return numVal;
        }
      }

      switch (parsed.action) {
        case "up":
          selected = (selected - 1 + options.length) % options.length;
          break;
        case "down":
          selected = (selected + 1) % options.length;
          break;
        case "select":
          process.stdout.write(SHOW_CURSOR);
          return options[selected]!.value;
        case "allow":
          process.stdout.write(SHOW_CURSOR);
          return "allow";
        case "always":
          process.stdout.write(SHOW_CURSOR);
          return "allow_always";
        case "deny":
          process.stdout.write(SHOW_CURSOR);
          return "deny";
      }

      // Clear the rendered prompt for re-render.
      process.stdout.write(CURSOR_UP(numLines));
    }
  } finally {
    process.stdout.write(SHOW_CURSOR);
  }
}

/** Fallback: simple numbered readline prompt when raw mode isn't available. */
async function promptPermissionFallback(
  toolName: string,
  toolInput: Record<string, unknown>,
  scope: string | undefined,
  options: Option[],
): Promise<string> {
  const desc = JSON.stringify(toolInput).slice(0, 120);
  const lines: string[] = [];
  lines.push(`\n${YELLOW}  🔒 ${BOLD}${toolName}${RESET} — ${dim(desc)}`);
  if (scope) lines.push(`  ${dim("scope: " + scope)}`);
  for (let i = 0; i < options.length; i++) {
    lines.push(`  ${i + 1}. ${options[i]!.label}`);
  }
  lines.push("");
  console.log(lines.join("\n"));

  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`  ${GREEN}Choose (1-3) or y/n/a:${RESET} `, (a) => {
      resolve(a.trim().toLowerCase());
    });
  });
  rl.close();

  if (answer === "1" || answer === "y" || answer === "yes") return "allow";
  if (answer === "2" || answer === "a" || answer === "always") return "allow_always";
  return "deny";
}

export { promptPermissionInteractive as promptPermission };
