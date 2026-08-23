// Every tool handler in this package returns through one of these two
// helpers, never a bare throw — MCP tool errors are data in the response
// (isError: true), not a transport-level exception. This mirrors
// src/main/nativeAddon.ts's own tryReadValue/tryReadBytes convention:
// a "not found"/"unreadable" outcome during exploration is routine, not
// exceptional, and the caller (an LLM driving this server) needs to see
// it as a normal, readable result rather than a crash.
export function ok(data: unknown): { content: { type: 'text'; text: string }[] } {
  const text = typeof data === 'string' ? data : JSON.stringify(data)
  return { content: [{ type: 'text', text }] }
}

export function err(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true }
}
