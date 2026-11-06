import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

// Volcengine Ark rejects the whole completion request when any advertised tool
// schema carries a `type` keyword that is not a JSON Schema type (`json`, `any`).
// A single MCP server therefore took down every tool-bearing turn of the session.
const serverSource = String.raw`
import { createInterface } from 'node:readline';
const tools = [
  // The offending shape reported by Ark as
  // "parameters/properties/actions/items: invalid JSON Schema".
  { name: 'batch', description: 'array with a non-JSON-Schema item type', inputSchema: {
    type: 'object',
    properties: {
      actions: { type: 'array', items: { type: 'json' }, description: 'ordered actions' },
      nested: { type: 'object', properties: { deep: { type: 'any' } } },
      union: { type: ['string', 'json'] },
      valid: { type: 'string' }
    }
  } },
  // Untouched control: a schema that is already valid must keep its exact shape.
  { name: 'plain', description: 'valid schema', inputSchema: { type: 'object', properties: { ping: { type: 'string' } } } }
];
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  if (request.method === 'server/discover') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Legacy fixture' } }) + '\n');
  }
  if (request.method === 'initialize') reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
  if (request.method === 'tools/list') reply({ tools });
});
process.stdin.on('end', () => process.exit(0));
`

const VALID_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/** Every `type` keyword reachable from a schema node, with its location. */
function collectTypes(node: unknown, path = ''): { path: string, type: unknown }[] {
  if (Array.isArray(node)) return node.flatMap((entry, index) => collectTypes(entry, `${path}/${index}`))
  if (node === null || typeof node !== 'object') return []
  const found: { path: string, type: unknown }[] = []
  const record = node as Record<string, unknown>
  if ('type' in record) found.push({ path, type: record.type })
  for (const [key, value] of Object.entries(record)) found.push(...collectTypes(value, `${path}/${key}`))
  return found
}

async function runProfile() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-mcp-schema-'))
  try {
    const profile = join(home, 'profiles', 'fixture')
    await mkdir(profile, { recursive: true })
    const server = join(home, 'server.mjs')
    await writeFile(server, serverSource)
    const mcpUrl = pathToFileURL(resolve('node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js')).href
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'mcp-schema-fixture', dsh: { profile: { bundles: [] } } }))
    await writeFile(join(profile, 'cordis.yml'), JSON.stringify([{
      id: 'loose',
      name: mcpUrl,
      config: {
        transport: 'stdio', serverName: 'loose', command: process.execPath, args: [server],
        startupTimeoutMs: 4000, reconnect: { enabled: false }
      }
    }]))
    const entry = join(home, 'entry.mjs')
    const bootUrl = pathToFileURL(resolve('node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href
    await writeFile(entry, `
      import { boot, loadProfile } from ${JSON.stringify(bootUrl)};
      const registered = {};
      const profile = loadProfile('fixture', 'fixture', ${JSON.stringify(resolve('node_modules/@deepseek-ai/dsh/package.json'))}, ${JSON.stringify(home)});
      const ctx = await boot('fixture', ${JSON.stringify(join(profile, 'cordis.yml'))}, profile.layers.flatMap(layer => layer.patches), ctx => {
        ctx.provide('tools', { register(definition) {
          registered[definition.name] = definition.parameters;
          return () => { delete registered[definition.name] };
        } });
      });
      console.log('REGISTERED:' + JSON.stringify(registered));
      await ctx.fiber.dispose();
    `)
    const result = spawnSync(process.execPath, [resolve('build/harness-node-entry.mjs'), entry], {
      encoding: 'utf8', timeout: 12_000,
      env: { ...process.env, DSH_HOME: home }
    })
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const line = result.stdout.split('\n').find(candidate => candidate.startsWith('REGISTERED:'))
    expect(line, result.stdout).toBeDefined()
    return JSON.parse(line!.slice('REGISTERED:'.length)) as Record<string, unknown>
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('MCP input schema sanitation for strict providers', () => {
  it('registers both tools and leaves no non-JSON-Schema type keyword', async () => {
    const registered = await runProfile()
    expect(Object.keys(registered).sort()).toEqual(['mcp__loose__batch', 'mcp__loose__plain'])

    // Ark accepts a schema only when every `type` is a real JSON Schema type.
    for (const [name, schema] of Object.entries(registered)) {
      for (const entry of collectTypes(schema)) {
        const types = Array.isArray(entry.type) ? entry.type : [entry.type]
        expect(types.every(candidate => typeof candidate === 'string' && VALID_TYPES.has(candidate)), `${name}${entry.path}: ${JSON.stringify(entry.type)}`).toBe(true)
      }
    }
  }, 20_000)

  it('drops only the invalid keyword and preserves the rest of the schema', async () => {
    const registered = await runProfile()
    const batch = registered['mcp__loose__batch'] as { properties: Record<string, any> }
    // The offending `items` loses its type but keeps its array parent and description.
    expect(batch.properties.actions).toMatchObject({ type: 'array', items: {}, description: 'ordered actions' })
    expect(batch.properties.nested.properties.deep).toEqual({})
    // An invalid union member is dropped; the valid member and the parent type survive.
    expect(batch.properties.union).toEqual({ type: 'string' })
    expect(batch.properties.valid).toEqual({ type: 'string' })
    // A schema that was already valid must be registered byte-identical.
    expect(registered['mcp__loose__plain']).toEqual({ type: 'object', properties: { ping: { type: 'string' } } })
  }, 20_000)

  it('does not mutate the raw tool schema advertised by the server', async () => {
    // Sanitation must copy, not edit in place: the raw schema still feeds
    // callTool validation and the cached tool definition.
    const registered = await runProfile()
    const batch = registered['mcp__loose__batch'] as { properties: Record<string, any> }
    expect(Object.keys(batch.properties.actions.items)).toEqual([])
    expect(batch.properties.nested.properties.deep).toEqual({})
  }, 20_000)
})
