import type { Services } from './ipc.ts';
import type { createUpdater } from './updater.ts';

/** The shared command registry exposes the same guarded operations to IPC and MCP. */
export function withUpdates(services: Services, updater: ReturnType<typeof createUpdater>): Services {
  const actions = ['check', 'download', 'install', 'status'] as const;
  return {
    listCommands: () => [...services.listCommands(), ...actions.map(action => ({
      name: `update.${action}`, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object' },
    }))] as ReturnType<Services['listCommands']>,
    async execute(name, input) {
      const action = actions.find(action => name === `update.${action}`);
      if (!action) return services.execute(name, input);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Lệnh cập nhật không nhận tham số', details: [] } };
      }
      try { return { ok: true, data: await updater[action]() }; }
      catch (error) { return { ok: false, error: { code: 'PRECONDITION_FAILED', message: `Không thể cập nhật: ${(error as { code?: string }).code ?? 'UPDATE_ERROR'}`, details: [] } }; }
    },
  };
}
