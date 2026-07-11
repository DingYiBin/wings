/**
 * Session paths — all session-scoped data lives under one directory.
 *
 * ~/.wings/sessions/<session-hash>/
 *   ├── logs/           # --log JSONL files
 *   ├── tool-results/   # large tool output persisted to disk
 *   ├── session-memory/ # summary.md for compaction
 *   └── messages.jsonl  # message history for session resume
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSIONS_DIR = join(homedir(), ".wings", "sessions");
const INDEX_PATH = join(SESSIONS_DIR, "index.json");

let _sessionHash: string | null = null;

export function generateSessionHash(): string {
  const raw = `${Date.now()}-${Math.random()}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function getSessionHash(): string {
  if (!_sessionHash) _sessionHash = generateSessionHash();
  return _sessionHash;
}

export function initSessionHash(hash?: string): string {
  _sessionHash = hash ?? generateSessionHash();
  return _sessionHash;
}

export function getSessionDir(hash?: string): string {
  return join(SESSIONS_DIR, hash ?? getSessionHash());
}

// -- Sub-directories --

export function getSessionLogDir(): string {
  const d = join(getSessionDir(), "logs");
  mkdirSync(d, { recursive: true });
  return d;
}
export function getSessionToolResultsDir(): string {
  const d = join(getSessionDir(), "tool-results");
  mkdirSync(d, { recursive: true });
  return d;
}
export function getSessionMemoryDir(): string {
  const d = join(getSessionDir(), "session-memory");
  mkdirSync(d, { recursive: true });
  return d;
}
export function getSessionMemoryPath(): string {
  return join(getSessionMemoryDir(), "summary.md");
}

// -- Session resume: messages + meta --

export function getSessionMessagesPath(hash: string): string {
  return join(getSessionDir(hash), "messages.jsonl");
}

export function getSessionMetaPath(hash: string): string {
  return join(getSessionDir(hash), "meta.json");
}

export interface SessionMeta {
  hash: string;
  cwd: string;
  created: string;
  updated: string;
  turnCount: number;
  /** Cumulative input chars. Optional for backward compat (absent → 0). */
  totalInputChars?: number;
  /** Cumulative output chars. Optional for backward compat (absent → 0). */
  totalOutputChars?: number;
}

export function saveSessionMeta(hash: string, cwd: string, turnCount: number, totalInputChars = 0, totalOutputChars = 0) {
  const meta: SessionMeta = {
    hash, cwd,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    turnCount,
    totalInputChars,
    totalOutputChars,
  };
  const dir = getSessionDir(hash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(getSessionMetaPath(hash), JSON.stringify(meta, null, 2));
}

export function updateSessionMeta(hash: string, turnCount: number, totalInputChars?: number, totalOutputChars?: number) {
  const path = getSessionMetaPath(hash);
  try {
    const meta = JSON.parse(readFileSync(path, "utf-8")) as SessionMeta;
    meta.updated = new Date().toISOString();
    meta.turnCount = turnCount;
    if (totalInputChars !== undefined) meta.totalInputChars = totalInputChars;
    if (totalOutputChars !== undefined) meta.totalOutputChars = totalOutputChars;
    writeFileSync(path, JSON.stringify(meta, null, 2));
  } catch {}
}

export function loadSessionMeta(hash: string): SessionMeta | null {
  try {
    return JSON.parse(readFileSync(getSessionMetaPath(hash), "utf-8")) as SessionMeta;
  } catch { return null; }
}

/**
 * Append messages to the session transcript. Writes one JSON line per message.
 */
export function appendSessionMessages(hash: string, messages: Array<{ role: string; content: unknown[] }>) {
  const dir = getSessionDir(hash);
  mkdirSync(dir, { recursive: true });
  const lines = messages.map(m => JSON.stringify({ role: m.role, content: m.content })).join("\n") + "\n";
  appendFileSync(getSessionMessagesPath(hash), lines);
}

/**
 * Append a single turn's new messages (after the previous save point).
 * Only saves messages that haven't been saved yet.
 */
let _lastSavedIndex = 0;
export function saveNewMessages(hash: string, allMessages: Array<{ role: string; content: unknown[] }>) {
  const newMsgs = allMessages.slice(_lastSavedIndex);
  if (newMsgs.length === 0) return;
  const dir = getSessionDir(hash);
  mkdirSync(dir, { recursive: true });
  const lines = newMsgs.map(m => JSON.stringify(m)).join("\n") + "\n";
  appendFileSync(getSessionMessagesPath(hash), lines);
  _lastSavedIndex = allMessages.length;
}

export function resetSaveIndex() { _lastSavedIndex = 0; }

/** Mark the first N messages as already persisted (used when resuming a session
 * so a later save doesn't re-append the loaded history). */
export function setSaveIndex(n: number) { _lastSavedIndex = n; }

/**
 * Load message history from a session transcript.
 */
export function loadSessionMessages(hash: string): Array<{ role: string; content: unknown[] }> {
  const path = getSessionMessagesPath(hash);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8").trim().split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch { return []; }
}

// -- Session index --

export function updateSessionIndex(cwd: string, hash: string) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  let index: Record<string, string[]> = {};
  try { if (existsSync(INDEX_PATH)) index = JSON.parse(readFileSync(INDEX_PATH, "utf-8")); } catch {}
  const list = index[cwd] ?? [];
  const filtered = list.filter(h => h !== hash);
  filtered.unshift(hash);
  index[cwd] = filtered.slice(0, 10);
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

export function getLatestSessionHash(cwd: string): string | null {
  try {
    const index = JSON.parse(readFileSync(INDEX_PATH, "utf-8")) as Record<string, string[]>;
    return index[cwd]?.[0] ?? null;
  } catch { return null; }
}

export function listSessions(cwd?: string): SessionMeta[] {
  const result: SessionMeta[] = [];
  try {
    if (cwd) {
      const index = JSON.parse(readFileSync(INDEX_PATH, "utf-8")) as Record<string, string[]>;
      for (const hash of (index[cwd] ?? [])) {
        const meta = loadSessionMeta(hash);
        if (meta) result.push(meta);
      }
    }
  } catch {}
  return result;
}
