/**
 * Wings CLI — chat REPL + single-turn (run).
 *
 * Raw mode stdin for line editing (like claude-code).
 * Permission prompts read directly from /dev/tty for reliability.
 */

import { openSync, readSync, closeSync } from "node:fs";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { createSession, makeAgentContext } from "./bootstrap.ts";
import { shouldExtractMemory, recordExtraction, extractSessionMemory } from "../services/session-memory.ts";
import { activeChild } from "../tools/builtin/bash.ts";
import type { TurnLogger } from "./logging.ts";

const GREEN = "\x1b[32m"; const CYAN = "\x1b[36m"; const YELLOW = "\x1b[33m";
const RED = "\x1b[31m"; const RESET = "\x1b[0m"; const BOLD = "\x1b[1m"; const DIM = "\x1b[2m";
const SHOW_CURSOR = "\x1b[?25h"; const HIDE_CURSOR = "\x1b[?25l";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function trunc(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n); }

const encoder = new TextEncoder();
const write = (s: string) => { process.stdout.write(encoder.encode(s)); };

// -- Debug --
const DLOG = process.env["WINGS_DEBUG"] ? (tag: string, ...args: unknown[]) => {
  const ts = new Date().toISOString().slice(11, 23);
  try { appendFileSync("/tmp/wings-debug.log", `[${ts}] ${tag} ${args.map(String).join(" ")}\n`); } catch {}
} : (..._: unknown[]) => {};

// -- Display width (CJK = 2 cols) --
function stripAnsi(s: string): string { return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][0-9;]*[^\x07]*\x07/g, ""); }
function charWidth(code: number): number {
  if (code >= 0x1100 && code <= 0x115f) return 2; if (code >= 0x2329 && code <= 0x232a) return 2;
  if (code >= 0x2e80 && code <= 0xa4cf) return 2; if (code >= 0xac00 && code <= 0xd7a3) return 2;
  if (code >= 0xf900 && code <= 0xfaff) return 2; if (code >= 0xfe10 && code <= 0xfe19) return 2;
  if (code >= 0xfe30 && code <= 0xfe6f) return 2; if (code >= 0xff00 && code <= 0xff60) return 2;
  if (code >= 0xffe0 && code <= 0xffe6) return 2; if (code >= 0x1f300 && code <= 0x1f64f) return 2;
  if (code >= 0x1f900 && code <= 0x1f9ff) return 2; return 1;
}
function displayWidth(s: string): number { let w = 0; for (const ch of stripAnsi(s)) w += charWidth(ch.charCodeAt(0)); return w; }

// -- Raw mode --
function enterRawMode(): boolean { const s = process.stdin as any; if (typeof s.setRawMode !== "function") return false; try { s.setRawMode(true); return true; } catch { return false; } }
function exitRawMode() { try { (process.stdin as any).setRawMode(false); } catch {} }
function graphemeBackspace(s: string): string { if (!s) return s; try { return [...new Intl.Segmenter("en",{granularity:"grapheme"}).segment(s)].slice(0,-1).map(x=>x.segment).join(""); } catch { return s.slice(0,-1); } }

// -- Permission dialog (reads /dev/tty) --
function buildPermOptions(n: string, scope?: string) { return [{v:"allow",l:"Yes"},{v:"allow_always",l:scope?`Yes, and don't ask again for ${n}(${scope})`:`Yes, and don't ask again for ${n}`},{v:"deny",l:"No, tell Wings what to do differently"}]; }
function renderPermDialog(input: Record<string,unknown>, opts: ReturnType<typeof buildPermOptions>, sel: number): number {
  const d = JSON.stringify(input).slice(0,76);
  const lines = [`\r\n  ${YELLOW}┌${RESET} Permission ${dim("─".repeat(60))}`,`\r\n  │ ${dim(d)}`,`\r\n  │`];
  for (let i=0;i<opts.length;i++) lines.push(`\r\n  │ ${i===sel?`${BOLD}❯ `:"  "}${i===sel?opts[i]!.l:dim(opts[i]!.l)}`);
  lines.push(`\r\n  │`,`\r\n  │ ${dim("↑↓ navigate  ·  Enter select  ·  y=allow  n=deny  esc=deny")}`,`\r\n  ${dim("└"+"─".repeat(66))}`);
  write(lines.join("")); return lines.length;
}
async function promptPermission(toolName: string, toolInput: Record<string,unknown>, scope?: string): Promise<string> {
  const opts = buildPermOptions(toolName, scope); let sel = 0;
  let fd = -1; try { fd = openSync("/dev/tty","r"); } catch { fd = -1; }
  if (fd < 0) {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    write(`\r\n${YELLOW}  🔒 ${BOLD}${toolName}${RESET}: ${dim(JSON.stringify(toolInput).slice(0,80))}\r\n  ${dim("[y=allow / n=deny / a=allow always]")}\r\n`);
    const a = await new Promise<string>(r=>rl.question(`  ${GREEN}>${RESET} `, x => r(x.trim().toLowerCase())));
    rl.close(); if (a==="y"||a==="yes") return "allow"; if (a==="a"||a==="always") return "allow_always"; return "deny";
  }
  write(HIDE_CURSOR); let r = renderPermDialog(toolInput, opts, sel);
  while (true) {
    const buf = Buffer.alloc(16); const n = readSync(fd, buf, 0, 16, null); if (n <= 0) { await new Promise(r=>setTimeout(r,10)); continue; }
    const raw = buf.toString("utf-8",0,n);
    for (let i=0;i<raw.length;i++) {
      const ch=raw[i]!,c=ch.charCodeAt(0);
      if (raw.slice(i).startsWith("\x1b[A")) { sel=(sel-1+opts.length)%opts.length; write(`\x1b[${r}A`); r=renderPermDialog(toolInput,opts,sel); i+=2; continue; }
      if (raw.slice(i).startsWith("\x1b[B")) { sel=(sel+1)%opts.length; write(`\x1b[${r}A`); r=renderPermDialog(toolInput,opts,sel); i+=2; continue; }
      if (c===0x0d) { try{closeSync(fd)}catch{} write(SHOW_CURSOR); write(`\x1b[${r}A\x1b[J`); return opts[sel]!.v; }
      if (ch==="y"||ch==="Y") { try{closeSync(fd)}catch{} write(SHOW_CURSOR); write(`\x1b[${r}A\x1b[J`); return "allow"; }
      if (ch==="n"||ch==="N"||c===0x1b||c===0x03) { try{closeSync(fd)}catch{} write(SHOW_CURSOR); write(`\x1b[${r}A\x1b[J`); return "deny"; }
      if (c>=0x31&&c<=0x33) { try{closeSync(fd)}catch{} write(SHOW_CURSOR); write(`\x1b[${r}A\x1b[J`); return opts[c-0x31]!.v; }
      if (ch==="j") { sel=(sel+1)%opts.length; write(`\x1b[${r}A`); r=renderPermDialog(toolInput,opts,sel); }
      if (ch==="k") { sel=(sel-1+opts.length)%opts.length; write(`\x1b[${r}A`); r=renderPermDialog(toolInput,opts,sel); }
    }
  }
}

// -- Single-turn --
export async function runSingle(prompt: string, opts: { workingDir?: string; model?: string|null; logger?: { recordCycle(o: Record<string,unknown>): void }|null } = {}): Promise<void> {
  const { loop, config } = await createSession(opts.workingDir, opts.logger);
  const ctx = makeAgentContext(config, { workingDir: opts.workingDir, modelOverride: opts.model??null, customAgents: (loop as any).customAgents??null, skills: (loop as any).skillsList??[] });
  for await (const event of loop.run(prompt, ctx)) {
    if (event.type==="text_delta") write((event as any).text);
    else if (event.type==="tool_use") write(`\r\n${dim("  ⚙")} ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input),80))}`);
    else if (event.type==="tool_result") { const c = (event as any).content??""; const p = trunc(c,80).replace(/\n/g," "); if ((event as any).is_error) write(`\r\n${dim("  ↳")} ${RED}${p}${RESET}`); else if (p) write(`\r\n${dim("  ↳")} ${dim(p)}`); }
    else if (event.type==="permission_request") loop.setPermissionResponse(await promptPermission(event.tool_name, event.tool_input, event.scope));
  }
  write("\r\n");
}

// -- Memory extraction helpers --
async function maybeExtract(loop: any, userInput: string): Promise<void> {
  const extractor = loop?.extractMemories;
  if (typeof extractor !== "function") return;
  try { const ctx = `User: ${userInput}\n\nAssistant answered with the content above.`; await extractor.call(loop, ctx); } catch {}
}
function tryExtractSessionMemory(wd: string, loop: any, engine: any, mr: any, tr: any, sel: any) {
  const msgs = loop.messages as any[]|undefined; if (!msgs||msgs.length===0) return;
  if (!shouldExtractMemory(msgs, 0)) return;
  extractSessionMemory({ workingDir: wd, messages: msgs, queryEngine: engine, modelRegistry: mr, toolRegistry: tr, modelSelector: sel }).then(u => { if (u) recordExtraction(msgs, 0); }).catch(()=>{});
}

// -- Interactive chat --
export async function runChat(opts: { workingDir?: string; model?: string|null; logger?: (TurnLogger|null) } = {}): Promise<void> {
  const { loop, config, poolMgr, engine, modelRegistry, toolRegistry } = await createSession(opts.workingDir, opts.logger);
  const ctx = makeAgentContext(config, { workingDir: opts.workingDir, modelOverride: opts.model??null, customAgents: (loop as any).customAgents??null, skills: (loop as any).skillsList??[] });

  write(`\r\n${BOLD}wings${RESET} ${dim("— each model is a wing")}\r\n`);
  if (opts.logger) console.log(`Logging to ${opts.logger.path}`);
  if (!enterRawMode()) { write(dim("(raw mode unavailable)\r\n")); await runChatFallback(loop,ctx,poolMgr,config); return; }

  let buffer = "", running = false;
  const DIV = dim("───");
  const PROMPT = `${GREEN}❯${RESET} `;

  // Draw divider + prompt.
  write(`\r\n${DIV}\r\n`);
  write(`\r\x1b[K${PROMPT}`);

  // History.
  const hf = pathJoin(homedir(),".wings","sessions","history.jsonl");
  let history: string[] = [], hi = 0;
  try { if (existsSync(hf)) { history = readFileSync(hf,"utf-8").trim().split("\n").map(l=>{try{return(JSON.parse(l) as any).text as string}catch{return""}}).filter(Boolean); hi = history.length; } } catch {}
  const saveH = (l: string) => { try { mkdirSync(pathJoin(homedir(),".wings","sessions"),{recursive:true}); appendFileSync(hf, JSON.stringify({text:l})+"\n"); } catch {} };

  // Cursor state.
  let cursor = 0, lastCtrlC = 0;
  const wl = (s:string,p:number)=>{while(p>0&&s[p-1]===" ")p--;while(p>0&&s[p-1]!==" ")p--;return p;};
  const wr = (s:string,p:number)=>{while(p<s.length&&s[p]!==" ")p++;while(p<s.length&&s[p]===" ")p++;return p;};

  // Input area render (above divider is untouched).
  let _inputLines = 1;
  const render = () => {
    const cols = process.stdout.columns||80;
    const text = PROMPT+buffer;
    const tw = displayWidth(text);
    const cl = Math.max(1, Math.ceil(tw/cols));
    if (_inputLines>1) write(`\x1b[${_inputLines-1}A`);
    write(`\r\x1b[J`);
    write(text);
    if (cursor<buffer.length) {
      const cw = displayWidth(PROMPT)+displayWidth(buffer.slice(0,cursor));
      const d = tw-cw; if (d>0) {
        const er=cl-1, cr=Math.floor(cw/cols);
        if (er>cr) write(`\x1b[${er-cr}A`);
        write(`\r\x1b[${cw%cols}C`);
      }
    }
    _inputLines = cl;
  };

  // Redraw divider + prompt after output.
  const redrawPrompt = () => { write(`\r\n${DIV}\r\n`); write(`\r\x1b[K${PROMPT}`); _inputLines = 1; };

  const doTurn = async (line: string) => {
    const text = line.trim();
    if (!text) { redrawPrompt(); return; }
    history = history.filter(h=>h!==text); history.push(text); if (history.length>1000) history.shift(); hi=history.length; saveH(text);
    running = true;
    if (text.startsWith("/")) { handleCommand(text,poolMgr); redrawPrompt(); running=false; return; }
    let pe = "";
    try {
      for await (const event of loop.run(text, ctx)) {
        if (event.type==="text_delta") { if (pe==="tool_result") write(`\r\n${dim("  ──────")}\r\n`); write((event as any).text); }
        else if (event.type==="tool_use") write(`\r\n${dim("  ⚙")} ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input),80))}`);
        else if (event.type==="tool_result") { const c = (event as any).content??""; const p = trunc(c,80).replace(/\n/g," "); if ((event as any).is_error) write(`\r\n${dim("  ↳")} ${RED}${p}${RESET}`); else if (p) write(`\r\n${dim("  ↳")} ${dim(p)}`); }
        else if (event.type==="permission_request") { DLOG("PERM","show",event.tool_name); loop.setPermissionResponse(await promptPermission(event.tool_name, event.tool_input, event.scope)); DLOG("PERM","done"); }
        else if (event.type==="subagent_start") write(`\r\n${dim("  ┌ subagent")} ${CYAN}${(event as any).agent_type}${RESET} ${dim((event as any).description)}\r\n`);
        else if (event.type==="subagent_end") write(`${dim("  └ done")}\r\n`);
        pe = event.type;
      }
      write("\r\n");
    } catch (e) { write(`${RED}Error:${RESET} ${(e as Error).message}\r\n`); }
    await maybeExtract(loop, text);
    tryExtractSessionMemory(opts.workingDir??process.cwd(), loop, engine, modelRegistry, toolRegistry, poolMgr);
    redrawPrompt();
    running = false;
  };

  // Data handler.
  process.stdin.on("data", (data: Buffer) => {
    if (running) { const raw = data.toString("utf-8"); if (raw==="\x1b"||raw==="\x03"||(raw.includes("\x1b")&&!raw.includes("\x1b[")&&!raw.includes("\x1bO"))) { (loop as any)._aborted=true; if (activeChild) activeChild.kill("SIGKILL"); } return; }
    const s = data.toString("utf-8");
    for (let i=0;i<s.length;i++) {
      const ch=s[i]!,c=ch.charCodeAt(0),r=s.slice(i);
      // History: up/down
      if (r.startsWith("\x1b[A")||c===0x10) { if (history.length>0&&hi>0) { hi--; buffer=history[hi]??""; cursor=buffer.length; render(); } i+=c===0x10?0:2; continue; }
      if (r.startsWith("\x1b[B")||c===0x0e) { if (hi<history.length-1) { hi++; buffer=history[hi]??""; } else { hi=history.length; buffer=""; } cursor=buffer.length; render(); i+=c===0x0e?0:2; continue; }
      // Navigation
      if (r.startsWith("\x1b[D")||c===0x02) { cursor=Math.max(0,cursor-1); render(); i+=c===0x02?0:2; continue; }
      if (r.startsWith("\x1b[C")||c===0x06) { cursor=Math.min(buffer.length,cursor+1); render(); i+=c===0x06?0:2; continue; }
      if (r.startsWith("\x1b[1;5D")||r.startsWith("\x1b[1;2D")) { cursor=wl(buffer,cursor); render(); i+=5; continue; }
      if (r.startsWith("\x1b[1;5C")||r.startsWith("\x1b[1;2C")) { cursor=wr(buffer,cursor); render(); i+=5; continue; }
      if (r.startsWith("\x1b[H")||r.startsWith("\x1b[1~")||c===0x01) { cursor=0; render(); if (c!==0x01) i+=r.startsWith("\x1b[1~")?3:2; continue; }
      if (r.startsWith("\x1b[F")||r.startsWith("\x1b[4~")||c===0x05) { cursor=buffer.length; render(); if (c!==0x05) i+=r.startsWith("\x1b[4~")?3:2; continue; }
      // Editing
      if (c===0x0d) { const l=buffer; buffer=""; cursor=0; write("\r\n"); doTurn(l); return; }
      if (r.startsWith("\x1b[3~")) { if (cursor<buffer.length) { const seg=new Intl.Segmenter("en",{granularity:"grapheme"}); const gs=[...seg.segment(buffer.slice(cursor))]; buffer=buffer.slice(0,cursor)+gs.slice(1).map(x=>x.segment).join(""); render(); } i+=3; continue; }
      if (c===0x7f||c===0x08) { if (cursor>0) { const b=buffer.slice(0,cursor); const nb=graphemeBackspace(b); buffer=nb+buffer.slice(cursor); cursor-=b.length-nb.length; render(); } continue; }
      if (c===0x17) { const cp=wl(buffer,cursor); buffer=buffer.slice(0,cp)+buffer.slice(cursor); cursor=cp; render(); continue; }
      // Exit
      if (c===0x03) { const n=Date.now(); if (lastCtrlC>0&&n-lastCtrlC<2000) { exitRawMode(); write(SHOW_CURSOR+"\r\n"); process.exit(0); } lastCtrlC=n; write(`\r\n${dim("  Press Ctrl+C again to exit")}\r\n`); buffer=""; cursor=0; render(); continue; }
      if (c===0x04&&!buffer) { exitRawMode(); write(SHOW_CURSOR+"\r\n"); process.exit(0); }
      // Printable
      if (c>=0x20) { buffer=buffer.slice(0,cursor)+ch+buffer.slice(cursor); cursor++; render(); continue; }
      if (c===0x1b) { let j=i+1; while (j<s.length&&s.charCodeAt(j)<0x40) j++; if (j<s.length) j++; i=j-1; }
    }
  });
}

// -- Readline fallback --
async function runChatFallback(loop: any, ctx: any, poolMgr: any, config: any) {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const sp = () => { try { rl.prompt(); } catch {} };
  rl.setPrompt(`${GREEN}❯${RESET} `); sp();
  rl.on("line", async (line) => {
    const text = line.trim(); if (!text) { sp(); return; }
    if (text.startsWith("/")) { handleCommand(text, poolMgr); sp(); return; }
    try { for await (const e of loop.run(text, ctx)) {
      if (e.type==="text_delta") write((e as any).text);
      else if (e.type==="tool_use") write(`\r\n${dim("  ⚙")} ${CYAN}${e.name}${RESET} ${dim(trunc(JSON.stringify(e.input),80))}`);
      else if (e.type==="permission_request") loop.setPermissionResponse(await promptPermission(e.tool_name, e.tool_input, e.scope));
    } write("\r\n"); } catch (e) { write(`${RED}Error:${RESET} ${(e as Error).message}\r\n`); }
    await maybeExtract(loop, text); sp();
  });
}

function handleCommand(cmd: string, poolMgr: any) {
  const p = cmd.split(/\s+/); const n = p[0]!;
  if (n==="/help"||n==="/h") write(dim("Commands: /help, /pool, /pool up|down <api>, Ctrl+C to exit\r\n"));
  else if (n==="/pool"&&poolMgr) {
    if (p.length===1) { const i=poolMgr.getPoolInfo("main"); write(dim("API pool (main task type):\r\n")); for (const [id,s] of Object.entries(i as Record<string,any>)) write(dim(`  ${id}: base=${s.base.toFixed(1)} delta=${s.delta.toFixed(1)} score=${s.effective===-Infinity?"disabled":s.effective.toFixed(1)}\r\n`)); }
    else if (p.length===3&&(p[1]==="up"||p[1]==="down")) { p[1]==="up"?poolMgr.upvote("main",p[2]!):poolMgr.downvote("main",p[2]!); write(dim(`  ${p[1]==="up"?"↑":"↓"} ${p[2]}\r\n`)); }
  } else write(dim(`Unknown command: ${n}. Type /help.\r\n`));
}
