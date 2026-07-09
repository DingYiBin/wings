/** Read a file from the local filesystem. */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, extname } from "node:path";

import { z } from "zod";

import { buildTool } from "../types.ts";

const MAX_SAMPLE = 8192; // bytes to read for binary detection

// Paths that should never be read (device files, etc.)
const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero", "/dev/random", "/dev/urandom", "/dev/full",
  "/dev/stdin", "/dev/stdout", "/dev/stderr",
  "/dev/tty", "/dev/console",
]);

// Block /dev/fd/0, /dev/fd/1, /dev/fd/2
const BLOCKED_FD_PREFIXES = ["/dev/fd/"];

// Block /proc/.../fd/0, /proc/.../fd/1, /proc/.../fd/2
const BLOCKED_PROC_FD_SUFFIXES = ["fd/0", "fd/1", "fd/2"];

// Extensions that indicate binary (non-text) files
const BINARY_EXTENSIONS = new Set([
  ".7z", ".bin", ".bz2", ".dmg", ".exe", ".gz", ".o",
  ".rar", ".tar", ".zip", ".xz", ".lz", ".lz4", ".zst",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".flac",
  ".pdf", ".pyc", ".pyo", ".so", ".class", ".jar",
  ".ttf", ".otf", ".woff", ".woff2",
  ".xlsx", ".docx", ".pptx",
]);

function isBlockedDevice(path: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(path)) return true;
  for (const prefix of BLOCKED_FD_PREFIXES) {
    if (path.startsWith(prefix) && ["0", "1", "2"].includes(path.slice(prefix.length))) {
      return true;
    }
  }
  if (path.includes("/proc/")) {
    for (const suffix of BLOCKED_PROC_FD_SUFFIXES) {
      if (path.endsWith("/" + suffix)) return true;
    }
  }
  return false;
}

function isBinaryByExtension(path: string): boolean {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

function isBinaryByContent(path: string): boolean {
  /** Check if a file contains NUL bytes (strong indicator of binary).
   * Only reads the first MAX_SAMPLE bytes to avoid loading large files. */
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(MAX_SAMPLE);
    const bytesRead = readSync(fd, buf, 0, MAX_SAMPLE, 0);
    closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export const readTool = buildTool({
  name: "read",
  description: "Read a file from the local filesystem. Supports text files only.",
  search_hint: "read /path/to/file",
  is_read_only: true,
  inputSchema: z.object({
    file_path: z.string().describe("Absolute path to the file to read"),
    offset: z.number().optional().describe("Line number to start reading from (1-based)"),
    limit: z.number().optional().describe("Maximum number of lines to read"),
  }),
  async call(input, context) {
    let pathStr = input.file_path;
    if (!isAbsolute(pathStr)) pathStr = join(context.working_dir, pathStr);

    // Block device paths
    if (isBlockedDevice(pathStr)) {
      return `Error: cannot read device path: ${pathStr}`;
    }

    // Check for directory
    const stat = existsSync(pathStr) ? statSync(pathStr) : null;
    if (stat && stat.isDirectory()) {
      return `Error: path is a directory: ${pathStr}`;
    }
    if (!stat) {
      return `Error: file not found: ${pathStr}`;
    }

    // Binary detection — extension first (fast), then content (accurate)
    if (isBinaryByExtension(pathStr)) {
      return `Error: cannot read binary file (by extension): ${pathStr}`;
    }
    if (isBinaryByContent(pathStr)) {
      return `Error: cannot read binary file: ${pathStr}`;
    }

    let text: string;
    try {
      // Validate UTF-8 strictly: Node's readFileSync(..., "utf-8") silently
      // replaces invalid byte sequences with U+FFFD instead of erroring, so
      // a latin-1 / non-UTF-8 file (no NUL bytes) would pass the binary
      // check above but yield garbled output. Mirror Python's read_text(),
      // which raises UnicodeDecodeError -> "cannot read binary file".
      const buf = readFileSync(pathStr);
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      return `Error: cannot read binary file: ${pathStr}`;
    }

    // Track this read in the context for stale-write detection
    context.read_cache[pathStr] = stat.mtimeMs / 1000;

    const lines = text.split("\n");
    const start = (input.offset ?? 1) - 1;
    const end = input.limit ? start + input.limit : lines.length;
    const selected = lines.slice(start, end);

    // Summary line matching claude-code: "Read N lines from path"
    const total = lines.length;
    const label = selected.length === 1 ? "line" : "lines";
    let summary = `Read ${selected.length} ${label}`;
    if (input.offset || input.limit) {
      summary += ` (lines ${start + 1}-${end} of ${total})`;
    }
    summary += ` from ${pathStr}`;

    const result = [summary, ""];
    for (let i = 0; i < selected.length; i++) {
      result.push(`${start + 1 + i}\t${selected[i]}`);
    }
    return result.join("\n");
  },
});
