#!/usr/bin/env node
// Tiny stdio MCP server for the acceptance bench: `node fake-mcp.mjs <server-name>`.
// Answers initialize, tools/list (tools from catalog.json) and tools/call ("stub result").
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const name = process.argv[2] || 'fake';
const catalog = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'catalog.json'), 'utf8'));
const spec = (catalog.mcp || []).find((m) => m.name === name);
const tools = ((spec && spec.tools) || []).map((t) => ({
  name: t.name,
  description: t.description || '',
  inputSchema: { type: 'object', properties: {}, additionalProperties: true },
}));

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined || m.id === null) return; // notifications need no answer
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return ok({ protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name, version: '0.0.0' } });
    case 'tools/list': return ok({ tools });
    case 'tools/call': return ok({ content: [{ type: 'text', text: 'stub result' }] });
    case 'ping': return ok({});
    default: return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
  }
});
rl.on('close', () => process.exit(0));
