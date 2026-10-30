import { validateSchema } from '../script/llm/schema.ts';
import type { createCoreService } from '../service/index.ts';

export type Services = Pick<ReturnType<typeof createCoreService>, 'listCommands' | 'execute'>;
/** Schemas come from M8.1: there is only one command/schema registry. */
export function createIpcHandlers(services: Services) {
  const registry = new Map(services.listCommands().map(c => [c.name.replace('.', ':'), c]));
  return {
    channels: [...registry.keys()],
    async handleInvoke(channel: string, payload: unknown) {
      const command = registry.get(channel);
      if (!command) return { ok: false, error: { code: 'UNKNOWN_COMMAND', message: 'Unknown channel' } };
      try {
        const input = structuredClone(payload);
        const validation = validateSchema(input, command.inputSchema);
        if (!validation.valid) return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid command input', issues: validation.errors.map(i => ({ path: i.path.replace(/cookie|token|password|secret/gi, '[REDACTED]'), message: i.message })) } };
        const result = await services.execute(command.name, input);
        if (result.ok) return { ok: true, data: result.data };
        return { ok: false, error: { code: result.error.code, message: result.error.message, issues: result.error.details } };
      } catch {
        return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Command could not be completed' } };
      }
    },
  };
}

export function registerIpc(ipcMain: {
  handle(channel: string, handler: (event: unknown, payload: unknown) => unknown): void;
  removeHandler(channel: string): void;
}, services: Services, authorize: (event: unknown) => boolean) {
  const handlers = createIpcHandlers(services);
  for (const channel of handlers.channels) ipcMain.handle(channel, (event, payload) => {
    if (!authorize(event)) return { ok: false, error: { code: 'FORBIDDEN', message: 'Untrusted sender' } };
    return handlers.handleInvoke(channel, payload);
  });
  return () => handlers.channels.forEach(channel => ipcMain.removeHandler(channel));
}
