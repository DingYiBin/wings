/**
 * Session paths — all session-scoped data lives under one directory.
 *
 * ~/.wings/sessions/<session-hash>/
 *   ├── logs/           # --log JSONL files
 *   ├── tool-results/   # large tool output persisted to disk
 *   └── session-memory/ # summary.md for compaction
 *
 * Memory (.wings/memory/) is project-scoped, not session-scoped,
 * so it stays in the project directory.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSIONS_DIR = join(homedir(), ".wings", "sessions");

let _sessionHash: string | null = null;

/** Generate a 64-bit hex hash from the current timestamp + random. */
export function generateSessionHash(): string {
  const raw = `${Date.now()}-${Math.random()}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16); // 64 bits = 16 hex chars
}

export function getSessionHash(): string {
  if (!_sessionHash) _sessionHash = generateSessionHash();
  return _sessionHash;
}

export function initSessionHash(): string {
  _sessionHash = generateSessionHash();
  return _sessionHash;
}

export function getSessionDir(): string {
  return join(SESSIONS_DIR, getSessionHash());
}

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
