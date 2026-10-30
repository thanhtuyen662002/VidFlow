import { createMcpServer } from './server.ts';
import type { McpSettingsStore } from './settings.ts';
import type { Services } from '../ipc.ts';

export function createMcpLifecycle(services: Services, store: McpSettingsStore) {
  const server = createMcpServer({ services, getSettings: () => store.getSettings() });
  let pending: Promise<unknown> = Promise.resolve();
  let closed = false;
  const refresh = () => {
    pending = pending.catch(() => {}).then(async () => {
      await server.stop();
      if (!closed) await server.start();
    });
    return pending;
  };
  const unsubscribe = store.subscribe(() => { void refresh().catch(() => {}); });
  return {
    start: refresh,
    settled: () => pending,
    isRunning: server.isRunning,
    async stop() { closed = true; unsubscribe(); await pending.catch(() => {}); await server.stop(); },
  };
}
