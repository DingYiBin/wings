/**
 * PromptInput — Ink v7 input bar with full keybindings.
 * History loaded from ~/.wings/history.jsonl (cross-session).
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HISTORY_PATH = join(homedir(), ".wings", "history.jsonl");
const MAX_HISTORY = 1000;

function graphemeBackspace(s: string): string {
  if (!s) return s;
  try { return [...new Intl.Segmenter("en",{granularity:"grapheme"}).segment(s)].slice(0,-1).map(x=>x.segment).join(""); } catch { return s.slice(0,-1); }
}
function graphemeDelete(s: string): string {
  if (!s) return s;
  try { return [...new Intl.Segmenter("en",{granularity:"grapheme"}).segment(s)].slice(1).map(x=>x.segment).join(""); } catch { return s.slice(1); }
}
function wordLeft(s: string, p: number): number {
  while (p>0&&s[p-1]===" ") p--; while (p>0&&s[p-1]!==" ") p--; return p;
}
function wordRight(s: string, p: number): number {
  while (p<s.length&&s[p]!==" ") p++; while (p<s.length&&s[p]===" ") p++; return p;
}

export function PromptInput({
  value, onChange, onSubmit, onExit, onInterrupt, onExitHint, isLoading,
}: {
  value: string; onChange: (v: string) => void; onSubmit: (v: string) => void;
  onExit: () => void; onInterrupt: () => void; onExitHint: (show: boolean) => void;
  isLoading: boolean;
}) {
  const [cursor, setCursor] = useState(value.length);
  const lastCtrlC = useRef(0);
  const history = useRef<string[]>([]);
  const histIdx = useRef(-1);

  // Load cross-session history on mount.
  useEffect(() => {
    try {
      if (existsSync(HISTORY_PATH)) {
        const raw = readFileSync(HISTORY_PATH, "utf-8").trim();
        history.current = raw.split("\n")
          .map(l => { try { return (JSON.parse(l) as any).text as string; } catch { return ""; } })
          .filter(Boolean);
        if (history.current.length > MAX_HISTORY) history.current = history.current.slice(-MAX_HISTORY);
        histIdx.current = history.current.length;
      }
    } catch {}
  }, []);

  const setValue = useCallback((v: string, c: number) => {
    onChange(v);
    setCursor(Math.max(0, Math.min(v.length, c)));
  }, [onChange]);

  const commit = useCallback((v: string) => {
    if (!v.trim()) return;
    const h = history.current;
    // No consecutive duplicates.
    if (h.length === 0 || h[h.length - 1] !== v) {
      h.push(v);
      if (h.length > MAX_HISTORY) h.shift();
      // Persist to ~/.wings/history.jsonl.
      try {
        mkdirSync(join(homedir(), ".wings"), { recursive: true });
        appendFileSync(HISTORY_PATH, JSON.stringify({ text: v }) + "\n");
      } catch {}
    }
    histIdx.current = h.length;
    onChange(""); setCursor(0);
    onSubmit(v);
  }, [onSubmit, onChange]);

  useInput((input, key) => {
    // ── ESC / Ctrl+C during loading: interrupt ──
    if (isLoading && (key.escape || (key.ctrl && input === "c"))) {
      onInterrupt();
      return;
    }
    // ── Ctrl+C when idle: double-press to exit ──
    if (!isLoading && key.ctrl && input === "c") {
      const now = Date.now();
      if (lastCtrlC.current > 0 && now - lastCtrlC.current < 800) { onExit(); return; }
      lastCtrlC.current = now;
      if (value === "") {
        onExitHint(true);
        setTimeout(() => onExitHint(false), 2000);
      } else {
        onChange(""); setCursor(0);
      }
      return;
    }
    if (isLoading) return;

    // ── Ctrl+D: double-press exit on empty, else delete forward ──
    if (key.ctrl && input === "d") {
      if (value === "") {
        const now = Date.now();
        if (lastCtrlC.current > 0 && now - lastCtrlC.current < 800) { onExit(); return; }
        lastCtrlC.current = now;
        onExitHint(true);
        setTimeout(() => onExitHint(false), 2000);
        return;
      }
      setValue(value.slice(0, cursor) + graphemeDelete(value.slice(cursor)), cursor);
      return;
    }

    // ── Navigation ──
    if (key.upArrow) {
      const h = history.current;
      if (h.length > 0) {
        if (histIdx.current === h.length || histIdx.current < 0) histIdx.current = h.length - 1;
        else if (histIdx.current > 0) histIdx.current--;
        const v = h[histIdx.current] ?? ""; onChange(v); setCursor(v.length);
      }
      return;
    }
    if (key.downArrow) {
      const h = history.current;
      if (histIdx.current < h.length - 1) { histIdx.current++; const v = h[histIdx.current] ?? ""; onChange(v); setCursor(v.length); }
      else { histIdx.current = h.length; onChange(""); setCursor(0); }
      return;
    }
    if ((key.leftArrow && !key.ctrl && !key.meta) || (key.ctrl && input === "b")) {
      setCursor(Math.max(0, cursor - 1)); return;
    }
    if ((key.rightArrow && !key.ctrl && !key.meta) || (key.ctrl && input === "f")) {
      setCursor(Math.min(value.length, cursor + 1)); return;
    }
    if ((key.leftArrow && key.ctrl) || (key.meta && input === "b")) {
      setCursor(wordLeft(value, cursor)); return;
    }
    if ((key.rightArrow && key.ctrl) || (key.meta && input === "f")) {
      setCursor(wordRight(value, cursor)); return;
    }
    // v7: home/end are native!
    if (key.home || (key.ctrl && input === "a")) { setCursor(0); return; }
    if (key.end || (key.ctrl && input === "e")) { setCursor(value.length); return; }

    // ── Editing ──
    if (key.return) { commit(value); return; }
    // v7: delete/backspace are native!
    if (key.delete || (key.ctrl && input === "d" && value !== "")) {
      if (cursor < value.length) setValue(value.slice(0, cursor) + graphemeDelete(value.slice(cursor)), cursor);
      return;
    }
    if (key.backspace || (key.ctrl && input === "h")) {
      if (cursor > 0) {
        const before = value.slice(0, cursor);
        const nb = graphemeBackspace(before);
        setValue(nb + value.slice(cursor), cursor - (before.length - nb.length));
      }
      return;
    }
    if (key.ctrl && input === "w") { const p = wordLeft(value, cursor); setValue(value.slice(0, p) + value.slice(cursor), p); return; }
    if (key.ctrl && input === "k") { setValue(value.slice(0, cursor), cursor); return; }
    if (key.ctrl && input === "u") { setValue(value.slice(cursor), 0); return; }

    // ── Printable (non-control, non-meta single char or IME composed text) ──
    if (input && !key.ctrl && !key.meta && !key.escape) {
      setValue(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
    }
  });

  const before = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="green">❯ </Text>
        <Text>
          {before}
          <Text inverse>{at}</Text>
          {after}
        </Text>
      </Box>
    </Box>
  );
}
