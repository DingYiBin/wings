/**
 * PromptInput — claude-code style input bar with full keybindings.
 */

import React, { useState, useCallback, useRef } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";

// Simple grapheme-aware cursor. In production, use Intl.Segmenter.
function graphemeLen(s: string): number {
  try { return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length; } catch { return s.length; }
}
function graphemeSlice(s: string, start: number): string {
  try { return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].slice(start).map(x => x.segment).join(""); } catch { return s.slice(start); }
}
function graphemeBackspace(s: string): string {
  if (!s) return s;
  try { return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].slice(0, -1).map(x => x.segment).join(""); } catch { return s.slice(0, -1); }
}
function wordLeft(s: string, pos: number): number {
  let p = pos; while (p > 0 && s[p - 1] === " ") p--; while (p > 0 && s[p - 1] !== " ") p--; return p;
}
function wordRight(s: string, pos: number): number {
  let p = pos; while (p < s.length && s[p] !== " ") p++; while (p < s.length && s[p] === " ") p++; return p;
}

export function PromptInput({
  value, onChange, onSubmit, onExit, isLoading, placeholder,
}: {
  value: string; onChange: (v: string) => void; onSubmit: (v: string) => void;
  onExit: () => void; isLoading: boolean; placeholder?: string;
}) {
  const [cursor, setCursor] = useState(value.length);
  const [exitMsg, setExitMsg] = useState(false);
  const lastCtrlC = useRef(0);
  const historyRef = useRef<string[]>([]);
  const histIdx = useRef(-1);

  const setValue = useCallback((v: string, c: number) => {
    onChange(v);
    setCursor(Math.max(0, Math.min(v.length, c)));
  }, [onChange]);

  const commit = useCallback((v: string) => {
    if (!v.trim()) return;
    historyRef.current = historyRef.current.filter(h => h !== v);
    historyRef.current.push(v);
    histIdx.current = historyRef.current.length;
    onChange(""); setCursor(0);
    onSubmit(v);
  }, [onSubmit, onChange]);

  useInput((char, key) => {
    if (isLoading) return;

    // ── Ctrl+C: double-press to exit ──
    if (key.ctrl && char === "c") {
      const now = Date.now();
      if (exitMsg || (lastCtrlC.current > 0 && now - lastCtrlC.current < 800)) {
        onExit();
        return;
      }
      lastCtrlC.current = now;
      if (value === "") { setExitMsg(true); setTimeout(() => setExitMsg(false), 2000); }
      else { onChange(""); setCursor(0); }
      return;
    }
    // Ctrl+D: double-press to exit on empty, else delete
    if (key.ctrl && char === "d") {
      if (value === "") {
        const now = Date.now();
        if (lastCtrlC.current > 0 && now - lastCtrlC.current < 800) { onExit(); return; }
        lastCtrlC.current = now;
        setExitMsg(true); setTimeout(() => setExitMsg(false), 2000);
        return;
      }
      setValue(graphemeSlice(value, cursor + 1) ? value.slice(0, cursor) + graphemeSlice(value, cursor + 1) : value.slice(0, cursor), cursor);
      return;
    }

    // ── Navigation ──
    if (key.upArrow) { // History up
      const h = historyRef.current;
      if (h.length > 0 && histIdx.current > 0) {
        histIdx.current--;
        const v = h[histIdx.current]!; onChange(v); setCursor(v.length);
      }
      return;
    }
    if (key.downArrow) { // History down
      const h = historyRef.current;
      if (histIdx.current < h.length - 1) { histIdx.current++; const v = h[histIdx.current]!; onChange(v); setCursor(v.length); }
      else { histIdx.current = h.length; onChange(""); setCursor(0); }
      return;
    }
    if (key.leftArrow && !key.ctrl) { setCursor(Math.max(0, cursor - 1)); return; }
    if (key.rightArrow && !key.ctrl) { setCursor(Math.min(value.length, cursor + 1)); return; }
    // Ctrl+Left/Right: word navigation
    if (key.leftArrow && key.ctrl) { setCursor(wordLeft(value, cursor)); return; }
    if (key.rightArrow && key.ctrl) { setCursor(wordRight(value, cursor)); return; }

    // ── Editing ──
    if (key.return) { commit(value); return; }
    if (key.delete || (char === "\x1b[3~")) {
      if (cursor < value.length) setValue(value.slice(0, cursor) + graphemeSlice(value, cursor + 1), cursor);
      return;
    }
    // Backspace: Ink key.backspace, or raw DEL (127), or raw BS (8)
    if (key.backspace || char === "\x7f" || char === "\x08" || (key.ctrl && char === "h")) {
      if (cursor > 0) {
        const before = value.slice(0, cursor);
        const newBefore = graphemeBackspace(before);
        setValue(newBefore + value.slice(cursor), cursor - (before.length - newBefore.length));
      }
      return;
    }
    // Home/End via Ctrl+A/E (Ink doesn't expose home/end keys)
    if (key.ctrl && char === "a") { setCursor(0); return; }
    if (key.ctrl && char === "e") { setCursor(value.length); return; }
    // Ctrl+W: delete word before
    if (key.ctrl && char === "w") {
      const p = wordLeft(value, cursor);
      setValue(value.slice(0, p) + value.slice(cursor), p);
      return;
    }
    // Ctrl+K: kill to end
    if (key.ctrl && char === "k") { setValue(value.slice(0, cursor), cursor); return; }
    // Ctrl+U: kill to start
    if (key.ctrl && char === "u") { setValue(value.slice(cursor), 0); return; }

    // ── Printable ──
    if (char && char.length === 1 && !key.ctrl && !key.meta) {
      setValue(value.slice(0, cursor) + char + value.slice(cursor), cursor + 1);
    }
  });

  const displayValue = value || (placeholder ?? "");
  const before = displayValue.slice(0, cursor);
  const at = displayValue[cursor] ?? " ";
  const after = displayValue.slice(cursor + 1);
  const isPlaceholder = !value && !!placeholder;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="green">❯ </Text>
        <Text dimColor={isPlaceholder}>
          {before}
          <Text inverse>{at}</Text>
          {after}
        </Text>
      </Box>
      {exitMsg && <Text dimColor>  Press Ctrl+C again to exit</Text>}
    </Box>
  );
}
