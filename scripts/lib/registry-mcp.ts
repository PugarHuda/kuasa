/**
 * Minimal client for Concordium's hosted Agent Registry MCP server (JSON-RPC over HTTP).
 * Used for the Verified-by-Concordium badge: build_agent_badge, token_address, check_badge.
 */
const URL_ = process.env.AGENT_REGISTRY_MCP ?? 'https://agent-registry-mcp.concordium.com/mcp';
let id = 0;

export async function mcp<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const body = JSON.parse(raw.slice(raw.indexOf('{')));
  if (body.error) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
  const text: string = body.result?.content?.[0]?.text ?? '';
  if (body.result?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text) as T; } catch { return text as T; }
}
