/**
 * Static permission rules — allowlist and denylist matching.
 *
 * Supports both tool-level rules (`addAllow("bash")`) and scoped rules
 * (`addAllow("bash", "git commit:*")`) that match against specific tool input.
 */

export type PermissionResult = "allow" | "deny" | "ask";

/**
 * Static allowlist / denylist for tool permissions.
 *
 * Stage 1 of the permission pipeline: fast, deterministic matching.
 *
 * Scoped rules match against tool input:
 * - bash: command prefix (e.g. `git commit:*` matches `git commit -m ...`)
 * - write/edit: directory prefix (e.g. `/home/user/project/*`)
 */
export class PermissionRules {
  allowlist: Set<string>;
  denylist: Set<string>;
  asklist: Set<string>;
  /** tool_name → set of scope patterns (e.g. "bash" → {"git commit:*", "npm:*"}). */
  scopedAllowlist: Map<string, Set<string>> = new Map();

  constructor(opts: { allowlist?: Iterable<string>; denylist?: Iterable<string>; asklist?: Iterable<string> } = {}) {
    this.allowlist = new Set(opts.allowlist ?? []);
    this.denylist = new Set(opts.denylist ?? []);
    this.asklist = new Set(opts.asklist ?? []);
  }

  // -- Tool-level matching --

  /** Match a tool name against the tool-level rules.
   * Priority: denylist > allowlist > asklist > default "ask".
   */
  match(toolName: string): PermissionResult {
    if (this.denylist.has(toolName)) return "deny";
    if (this.allowlist.has(toolName)) return "allow";
    if (this.asklist.has(toolName)) return "ask";
    return "ask";
  }

  // -- Scoped matching --

  /** Check scoped allow rules against tool input.
   * Returns "allow" if the input matches a scoped rule, null otherwise.
   */
  checkScoped(toolName: string, toolInput: Record<string, unknown>): PermissionResult | null {
    const patterns = this.scopedAllowlist.get(toolName);
    if (!patterns || patterns.size === 0) return null;

    const target = extractScopeTarget(toolName, toolInput);
    if (target === null) return null;

    for (const pattern of patterns) {
      if (scopeMatches(target, pattern)) return "allow";
    }
    return null;
  }

  // -- Mutation --

  /** Add an allow rule. With pattern = scoped, without = tool-level. */
  addAllow(toolName: string, pattern?: string): void {
    if (pattern) {
      let set = this.scopedAllowlist.get(toolName);
      if (!set) {
        set = new Set();
        this.scopedAllowlist.set(toolName, set);
      }
      set.add(pattern);
    } else {
      this.allowlist.add(toolName);
    }
  }

  addDeny(toolName: string): void {
    this.denylist.add(toolName);
  }

  addAsk(toolName: string): void {
    this.asklist.add(toolName);
  }

  static fromConfig(config: Record<string, unknown>): PermissionRules {
    return new PermissionRules({
      allowlist: (config["allowlist"] as string[]) ?? [],
      denylist: (config["denylist"] as string[]) ?? [],
      asklist: (config["asklist"] as string[]) ?? [],
    });
  }
}

// -- Scope helpers ------------------------------------------------------------

/** Extract the match target from tool input for scoped rule matching.
 * - bash: the command string
 * - write/edit/read: the file path
 */
export function extractScopeTarget(
  toolName: string,
  toolInput: Record<string, unknown>,
): string | null {
  if (toolName === "bash") {
    return (toolInput["command"] as string) ?? "";
  }
  if (toolName === "write" || toolName === "edit" || toolName === "read") {
    return (toolInput["file_path"] as string) ?? "";
  }
  return null;
}

/** Check if a target matches a scope pattern.
 *
 * Patterns ending with `:*` match by prefix (everything before `:*`).
 * Patterns ending with `/*` match by directory prefix.
 * Otherwise exact match.
 */
export function scopeMatches(target: string, pattern: string): boolean {
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return target === prefix || target.startsWith(prefix + " ");
  }
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    return target.startsWith(prefix + "/") || target === prefix;
  }
  return target === pattern;
}

/** Generate a suggested scope pattern for the "don't ask again" option.
 *
 * - bash: first 1-2 words of command → `git commit:*` or `git:*`
 * - write/edit: parent directory → `/home/user/project/*`
 */
export function suggestScope(
  toolName: string,
  toolInput: Record<string, unknown>,
): string | null {
  if (toolName === "bash") {
    const cmd = ((toolInput["command"] as string) ?? "").trim();
    if (!cmd) return null;
    const words = cmd.split(/\s+/);
    if (words.length >= 2 && words[1] && /^[a-z-]+$/.test(words[1])) {
      return `${words[0]} ${words[1]}:*`;
    }
    return `${words[0]}:*`;
  }

  if (toolName === "write" || toolName === "edit") {
    const path = (toolInput["file_path"] as string) ?? "";
    if (path && path.includes("/")) {
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent) return `${parent}/*`;
    }
    return null;
  }

  return null;
}
