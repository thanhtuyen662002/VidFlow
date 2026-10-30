import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Services } from '../ipc.ts';
import type { McpSettings } from './settings.ts';
import { sanitize } from '../../service/sanitize.ts';
import { createMcpTools } from './tools.ts';

export const MCP_HOST = '127.0.0.1';
const LIMIT = 1024 * 1024;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function createMcpServer({ services, getSettings, logger }: {
  services: Services; getSettings: () => McpSettings;
  logger?: { error(message: string): void };
}) {
  const tools = createMcpTools(services);
  let port = 0;
  let activeToken = '';
  let operations: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = operations.then(operation); operations = next.catch(() => {}); return next;
  };
  const server = createServer(async (req, res) => {
    const send = (status: number, value?: unknown) => {
      res.statusCode = status;
      if (value === undefined) { res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(sanitize(value, [activeToken, getSettings().mcp?.token ?? ''])));
    };
    const rpcError = (code: number, message: string, id: unknown = null) => send(200, { jsonrpc: '2.0', id, error: { code, message } });
    // These checks deliberately precede any body consumption.
    if (Object.hasOwn(req.headers, 'origin')) { send(403); return; }
    if (![`${MCP_HOST}:${port}`, `localhost:${port}`].includes(req.headers.host ?? '')) { send(403); return; }
    const expected = Buffer.from(`Bearer ${activeToken}`);
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (!activeToken || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer'); send(401); return;
    }
    if (!getSettings().mcp?.enabled) { send(503); return; }
    if (req.url !== '/mcp') { send(404); return; }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); send(405); return; }
    if (Number(req.headers['content-length']) > LIMIT) { send(413); return; }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') { send(415); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > LIMIT) { send(413); return; }
        chunks.push(chunk);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { rpcError(-32700, 'Parse error'); return; }
      if (!record(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string'
        || (Object.hasOwn(body, 'id') && body.id !== null && typeof body.id !== 'string' && !(typeof body.id === 'number' && Number.isFinite(body.id)))) {
        rpcError(-32600, 'Invalid request'); return;
      }
      const { method, params } = body;
      const id = body.id ?? null;
      if (params !== undefined && !record(params)) { rpcError(-32602, 'Invalid params', id); return; }
      if (method === 'notifications/initialized' && !Object.hasOwn(body, 'id')) { send(202); return; }
      let result: unknown;
      switch (method) {
        case 'initialize':
          if (!record(params) || typeof params.protocolVersion !== 'string' || !record(params.capabilities) || !record(params.clientInfo)) {
            rpcError(-32602, 'Invalid params', id); return;
          }
          result = { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(params.protocolVersion) ? params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'vidflow', version: '1.0.0' } }; break;
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: tools.list() }; break;
        case 'tools/call':
          if (!record(params) || typeof params.name !== 'string') { rpcError(-32602, 'Invalid params', id); return; }
          result = await tools.call(params.name, params.arguments === undefined ? {} : params.arguments);
          if (!result) { rpcError(-32602, 'Invalid tool or arguments', id); return; }
          break;
        default: rpcError(-32601, 'Method not found', id); return;
      }
      if (!Object.hasOwn(body, 'id')) { send(202); return; }
      send(200, { jsonrpc: '2.0', id, result });
    } catch {
      logger?.error('MCP request failed');
      if (!res.headersSent) send(500);
      else res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return {
    start: () => serialize(async () => {
      if (server.listening) return { port };
      const settings = getSettings().mcp;
      if (!settings?.enabled) return { port: 0 };
      if (!settings.token || !Number.isInteger(settings.port ?? 0) || (settings.port ?? 0) < 0 || (settings.port ?? 0) > 65535) throw new Error('Invalid MCP configuration');
      activeToken = settings.token;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(settings.port ?? 0, MCP_HOST, () => { server.removeListener('error', reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== MCP_HOST) throw new Error('Invalid MCP binding');
      port = address.port; return { port };
    }),
    stop: () => serialize(async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
      activeToken = '';
    }),
    isRunning: () => server.listening,
  };
}
