/**
 * Runs a real AI agent: Claude (Claude Code, headless) with only the Kuasa MCP server, so every
 * action the model takes goes through the mandate, the shop's guard and Kuasa Cover. Its tool calls
 * stream into `trace` for the demo page. Any MCP client works the same way; this one needs the
 * `claude` CLI on PATH and a logged-in account.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type TraceEvent = { kind: 'tool'; name: string; input: unknown } | { kind: 'result'; text: string; error?: boolean } | { kind: 'say'; text: string } | { kind: 'done'; ok: boolean; ms?: number };

const agentDir = fileURLToPath(new URL('../../agent/', import.meta.url));
export const trace: { running: boolean; events: TraceEvent[] } = { running: false, events: [] };

const SYSTEM = [
  "You are Alice's autonomous shopping agent. Alice has given you a Kuasa mandate (budget, categories, merchants) on Concordium.",
  'Act only through the kuasa tools. Tool outputs show amounts in atomic EUDemo (6 decimals: 24000000 = 24 EUDemo); tool inputs take whole EUDemo.',
  'Never invent transaction hashes. Keep replies to one or two short sentences.',
].join(' ');

export function runAiAgent(task: string, agent = 'alice'): Promise<{ ok: boolean; events: TraceEvent[] }> {
  if (trace.running) return Promise.reject(new Error('the agent is already running'));
  trace.running = true;
  trace.events = [];
  // a fresh private directory per run (mkdtemp is 0700): no other local user can swap the MCP command
  const dir = mkdtempSync(join(tmpdir(), 'kuasa-ai-'));
  const config = join(dir, 'mcp.json');
  writeFileSync(config, JSON.stringify({ mcpServers: { kuasa: { command: 'node', args: ['--import', 'tsx', 'src/mcp.ts'], env: { KUASA_AGENT: agent } } } }), { flag: 'wx', mode: 0o600 });
  const args = ['-p', task, '--append-system-prompt', SYSTEM, '--mcp-config', config, '--strict-mcp-config', '--allowedTools', 'mcp__kuasa', '--output-format', 'stream-json', '--verbose', '--model', process.env.KUASA_AI_MODEL ?? 'sonnet'];
  return new Promise((resolve) => {
    const p = spawn('claude', args, { cwd: agentDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { onMessage(JSON.parse(line)); } catch { /* not JSON */ }
      }
    });
    const finish = (ok: boolean) => {
      if (!trace.running) return;
      if (!trace.events.some((e) => e.kind === 'done')) trace.events.push({ kind: 'done', ok });
      trace.running = false;
      rmSync(dir, { recursive: true, force: true });
      resolve({ ok, events: trace.events });
    };
    p.on('error', (e) => { trace.events.push({ kind: 'result', text: `could not start claude: ${e.message}`, error: true }); finish(false); });
    p.on('close', (code) => finish(code === 0));
  });
}

const kuasaCalls = new Set<string>();
type Block = { type: string; id?: string; tool_use_id?: string; name?: string; input?: unknown; text?: string; content?: unknown; is_error?: boolean };
function onMessage(m: { type: string; subtype?: string; message?: { content?: Block[] }; duration_ms?: number }) {
  if (m.type === 'assistant') {
    for (const c of m.message?.content ?? []) {
      if (c.type === 'tool_use' && c.name?.startsWith('mcp__kuasa__')) kuasaCalls.add(c.id ?? '');
      if (c.type === 'tool_use' && c.name?.startsWith('mcp__kuasa__')) trace.events.push({ kind: 'tool', name: c.name.replace('mcp__kuasa__', ''), input: c.input });
      if (c.type === 'text' && c.text?.trim()) trace.events.push({ kind: 'say', text: c.text.trim() });
    }
  }
  if (m.type === 'user') {
    for (const c of m.message?.content ?? []) {
      if (c.type !== 'tool_result' || !kuasaCalls.has(c.tool_use_id ?? '')) continue; // only Kuasa actions, not tool loading
      const raw = Array.isArray(c.content) ? (c.content as Block[]).map((x) => x.text ?? '').join('') : String(c.content ?? '');
      trace.events.push({ kind: 'result', text: raw.slice(0, 1500), error: c.is_error });
    }
  }
  if (m.type === 'result') trace.events.push({ kind: 'done', ok: m.subtype === 'success', ms: m.duration_ms });
}
