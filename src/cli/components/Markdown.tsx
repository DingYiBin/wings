/**
 * Markdown — renders model responses with formatting.
 *
 * Uses marked with a custom Renderer that produces terminal-formatted output
 * (box-drawing table borders, │ blockquote prefix, bullets, etc.) instead of
 * HTML. This lets marked handle all token walking and nesting correctly.
 */

import React from "react";
import { Text } from "ink";
import { marked, Renderer, type Token, type Tokens } from "marked";
import stringWidth from "string-width";

// ---------------------------------------------------------------------------
// Terminal renderer — set up once at module load
// ---------------------------------------------------------------------------

const COL_MIN = 3;
const COL_PAD = 1;
/** Extra headroom kept between the table and the terminal edge. Without it the
 * table sizes to nearly the full width, and a line Ink measures even slightly
 * wider (e.g. an emoji cell) overflows the layout box and gets re-wrapped,
 * breaking border alignment. Matches claude-code's SAFETY_MARGIN. */
const SAFETY_MARGIN = 4;

/** Render inline tokens to a plain string (no ANSI), for display and measurement. */
function inlineText(tokens: Token[]): string {
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "text":    out += t.text; break;
      case "strong":  out += (t as Tokens.Strong).text; break;
      case "em":      out += (t as Tokens.Em).text; break;
      case "codespan":out += (t as Tokens.Codespan).text; break;
      case "link":    out += (t as Tokens.Link).text; break;
      case "del":     out += (t as Tokens.Del).text; break;
      case "image":   out += (t as Tokens.Image).text; break;
      case "br":      out += "\n"; break;
      default:
        if ("text" in t && typeof t.text === "string") out += t.text;
    }
  }
  return out;
}

/** Wrap text to a display width, breaking on spaces and hard-breaking overly
 * long words. Width-aware so CJK / wide characters count as 2 columns. */
function wrapCell(text: string, width: number): string[] {
  const w = Math.max(1, width);
  if (stringWidth(text) <= w) return [text]; // fits — keep verbatim
  const lines: string[] = [];
  let cur = "";
  const flush = () => { lines.push(cur); cur = ""; };
  for (let word of text.split(/\s+/).filter((x) => x.length > 0)) {
    // Hard-break a single word that is wider than the column.
    while (stringWidth(word) > w) {
      let take = "";
      for (const ch of word) {
        if (take === "") { take = ch; continue; } // always advance ≥1 char
        if (stringWidth(take + ch) > w) break;
        take += ch;
      }
      if (cur !== "") flush();
      lines.push(take);
      word = word.slice(take.length);
    }
    if (cur === "") cur = word;
    else if (stringWidth(cur + " " + word) <= w) cur += " " + word;
    else { flush(); cur = word; }
  }
  if (cur !== "" || lines.length === 0) lines.push(cur);
  return lines;
}

/** Width of the longest unbreakable word — the minimum a column can shrink to
 * without breaking mid-word. CJK runs have no spaces, so they count whole. */
function longestWord(text: string): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return COL_MIN;
  return Math.max(...words.map((w) => stringWidth(w)));
}

function buildTableStr(table: Tokens.Table): string {
  // Resolve inline formatting to measure and display plain text.
  const headerTexts = table.header.map((c) => inlineText(c.tokens));
  const bodyTexts = table.rows.map((row) => row.map((c) => inlineText(c.tokens)));

  const allRows = [headerTexts, ...bodyTexts];
  const n = allRows[0]!.length;
  const colCells = (i: number) => allRows.map((r) => r[i] ?? "");
  // Minimum column width = longest unbreakable word; ideal = full content.
  const minWidths = Array.from({ length: n }, (_, i) =>
    Math.max(COL_MIN, ...colCells(i).map(longestWord)),
  );
  const idealWidths = Array.from({ length: n }, (_, i) =>
    Math.max(COL_MIN, ...colCells(i).map((t) => stringWidth(t))),
  );

  // Fit the table to the terminal, keeping SAFETY_MARGIN of headroom. Narrow
  // columns keep their ideal width; the overflow is taken from wide columns.
  const term = Math.max(20, process.stdout.columns ?? 80);
  const overhead = n + 1 + n * COL_PAD * 2; // │ borders + per-cell padding
  const available = Math.max(n * COL_MIN, term - overhead - SAFETY_MARGIN);
  const totalMin = minWidths.reduce((a, b) => a + b, 0);
  const totalIdeal = idealWidths.reduce((a, b) => a + b, 0);

  let widths: number[];
  if (totalIdeal <= available) {
    widths = idealWidths;
  } else if (totalMin <= available) {
    const extra = available - totalMin;
    const overflow = idealWidths.map((w, i) => w - minWidths[i]!);
    const totalOverflow = overflow.reduce((a, b) => a + b, 0);
    widths = minWidths.map((m, i) =>
      totalOverflow === 0 ? m : m + Math.floor((overflow[i]! / totalOverflow) * extra),
    );
  } else {
    const scale = available / totalMin;
    widths = minWidths.map((m) => Math.max(COL_MIN, Math.floor(m * scale)));
  }

  const fill = (w: number, ch: string) => ch.repeat(w + COL_PAD * 2);
  const join = (ch: string) => widths.map((w) => fill(w, "─")).join(ch);

  const top = "┌" + join("┬") + "┐";
  const sep = "├" + join("┼") + "┤";
  const bot = "└" + join("┴") + "┘";

  function rowLines(texts: string[], cells: Tokens.TableCell[]): string[] {
    const wrapped = texts.map((t, i) => wrapCell(t, widths[i] ?? COL_MIN));
    const height = Math.max(1, ...wrapped.map((c) => c.length));
    const out: string[] = [];
    for (let r = 0; r < height; r++) {
      let line = "│";
      for (let i = 0; i < n; i++) {
        const w = widths[i] ?? COL_MIN;
        const text = wrapped[i]?.[r] ?? "";
        const pad = Math.max(0, w - stringWidth(text));
        const align = cells[i]?.align;
        const padded =
          align === "right"
            ? " ".repeat(pad) + text
            : align === "center"
              ? " ".repeat(Math.floor(pad / 2)) +
                text +
                " ".repeat(pad - Math.floor(pad / 2))
              : text + " ".repeat(pad);
        line += " " + padded + " │";
      }
      out.push(line);
    }
    return out;
  }

  return [
    top,
    ...rowLines(headerTexts, table.header),
    sep,
    ...table.rows.flatMap((row, i) => rowLines(bodyTexts[i]!, row)),
    bot,
    "",
  ].join("\n");
}

const renderer = new Renderer();

// -- block-level --
renderer.heading = function (tok: Tokens.Heading) {
  return this.parser.parseInline(tok.tokens) + "\n";
};
renderer.paragraph = function (tok: Tokens.Paragraph) {
  return this.parser.parseInline(tok.tokens) + "\n";
};
renderer.space = (tok: Tokens.Space) => tok.raw ?? "\n";
renderer.text = (tok: Tokens.Text) => tok.text;
renderer.code = (tok: Tokens.Code) => tok.text + "\n";
renderer.blockquote = function (tok: Tokens.Blockquote) {
  const body = this.parser.parse(tok.tokens);
  return (
    body
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => "│ " + l)
      .join("\n") + "\n"
  );
};
renderer.list = function (tok: Tokens.List) {
  let out = "";
  for (let i = 0; i < tok.items.length; i++) {
    const item = tok.items[i]!;
    const bullet = tok.ordered ? `${i + 1}. ` : "  • ";
    const body = this.parser.parse(item.tokens);
    const lines = body.split("\n").filter((l) => l !== "");
    if (lines.length > 0) {
      out += bullet + lines[0]! + "\n";
      for (let j = 1; j < lines.length; j++) {
        out += "    " + lines[j]! + "\n";
      }
    }
  }
  return out;
};
renderer.listitem = function (tok: Tokens.ListItem) {
  return this.parser.parse(tok.tokens);
};
renderer.table = (tok: Tokens.Table) => buildTableStr(tok) + "\n";
renderer.hr = () => "────────────\n";
renderer.html = (tok: Tokens.HTML | Tokens.Tag) => tok.text;

// -- inline (plain text, no terminal escape codes) --
renderer.strong = (tok: Tokens.Strong) => tok.text;
renderer.em = (tok: Tokens.Em) => tok.text;
renderer.codespan = (tok: Tokens.Codespan) => tok.text;
renderer.link = (tok: Tokens.Link) => tok.text;
renderer.del = (tok: Tokens.Del) => tok.text;
renderer.br = () => "\n";
renderer.image = (tok: Tokens.Image) => tok.text;

marked.use({ renderer });

// ---------------------------------------------------------------------------
// Fast-path check
// ---------------------------------------------------------------------------

const MD_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;
function hasMarkdown(s: string): boolean {
  return MD_RE.test(s.length > 500 ? s.slice(0, 500) : s);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Markdown({ content }: { content: string }) {
  // Drop trailing newlines so a text block doesn't render an extra blank line
  // below it — spacing between blocks is controlled by the callers' margins.
  const c = content.replace(/\n+$/, "");
  if (!hasMarkdown(c)) {
    return <Text>{c}</Text>;
  }
  try {
    const text = (marked.parse(c) as string).replace(/\n+$/, "");
    return <Text>{text}</Text>;
  } catch {
    return <Text>{c}</Text>;
  }
}
