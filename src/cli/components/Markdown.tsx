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

function buildTableStr(table: Tokens.Table): string {
  // Resolve inline formatting to measure and display plain text.
  const headerTexts = table.header.map((c) => inlineText(c.tokens));
  const bodyTexts = table.rows.map((row) => row.map((c) => inlineText(c.tokens)));

  const allRows = [headerTexts, ...bodyTexts];
  const n = allRows[0]!.length;
  const widths: number[] = Array<number>(n).fill(COL_MIN);
  for (const row of allRows) {
    for (let i = 0; i < Math.min(n, row.length); i++) {
      widths[i] = Math.max(widths[i]!, stringWidth(row[i]!));
    }
  }

  const fill = (w: number, ch: string) => ch.repeat(w + COL_PAD * 2);
  const join = (ch: string) => widths.map((w) => fill(w, "─")).join(ch);

  const top = "┌" + join("┬") + "┐";
  const sep = "├" + join("┼") + "┤";
  const bot = "└" + join("┴") + "┘";

  function rowStr(texts: string[], cells: Tokens.TableCell[]): string {
    return (
      "│" +
      texts
        .map((text, i) => {
          const w = widths[i] ?? COL_MIN;
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
          return " " + padded + " ";
        })
        .join("│") +
      "│"
    );
  }

  return [
    top,
    rowStr(headerTexts, table.header),
    sep,
    ...table.rows.map((row, i) => rowStr(bodyTexts[i]!, row)),
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
  if (!hasMarkdown(content)) {
    return <Text>{content}</Text>;
  }
  try {
    const text = marked.parse(content) as string;
    return <Text>{text}</Text>;
  } catch {
    return <Text>{content}</Text>;
  }
}
