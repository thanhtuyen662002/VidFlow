import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface McpSettings { mcp?: { enabled?: boolean; port?: number; token?: string } }
/** The application supplies its persistent, private settings backend. No credentials in IPC. */
export interface McpSettingsStore {
  getSettings(): McpSettings;
  saveSettings(settings: McpSettings): void | Promise<void>;
  subscribe(listener: () => void): () => void;
}
/** This checkout has no application settings store; reuse the private application DB. */
export function createMcpSettingsStore(db: DatabaseSync): McpSettingsStore {
  db.exec('CREATE TABLE IF NOT EXISTS app_mcp_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
  const listeners = new Set<() => void>();
  return {
    getSettings() {
      const row = db.prepare('SELECT value FROM app_mcp_settings WHERE id=1').get() as { value: string } | undefined;
      return row ? JSON.parse(row.value) as McpSettings : { mcp: { enabled: false, port: 0 } };
    },
    saveSettings(settings) {
      db.prepare('INSERT INTO app_mcp_settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(settings));
      listeners.forEach(listener => listener());
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export async function configureMcp(store: McpSettingsStore, enabled: boolean, port = 0, rotate = false) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid MCP port');
  const settings = store.getSettings();
  const previous = settings.mcp;
  await store.saveSettings({ ...settings, mcp: { enabled, port,
    token: enabled && (rotate || !previous?.enabled || !previous.token)
      ? randomBytes(32).toString('base64url') : previous?.token } });
}
