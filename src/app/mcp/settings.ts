import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface McpSettings { mcp?: { enabled?: boolean; port?: number; token?: string }; updates?: { channel?: 'dev'; sourceUrl?: string } }
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
      return row ? JSON.parse(row.value) as McpSettings : { mcp: { enabled: false, port: 0 }, updates: { channel: 'dev', sourceUrl: '' } };
    },
    saveSettings(settings) {
      db.prepare('INSERT INTO app_mcp_settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(settings));
      listeners.forEach(listener => listener());
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
/** Owner-managed source; no bundled production endpoint. Preserve private MCP settings. */
export async function configureUpdates(store: McpSettingsStore, sourceUrl: string) {
  if (sourceUrl) {
    const url = new URL(sourceUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid update source URL');
  }
  await store.saveSettings({ ...store.getSettings(), updates: { channel: 'dev', sourceUrl } });
}
export async function configureMcp(store: McpSettingsStore, enabled: boolean, port = 0, rotate = false) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid MCP port');
  const settings = store.getSettings();
  const previous = settings.mcp;
  await store.saveSettings({ ...settings, mcp: { enabled, port,
    token: enabled && (rotate || !previous?.enabled || !previous.token)
      ? randomBytes(32).toString('base64url') : previous?.token } });
}

export async function revokeMcp(store: McpSettingsStore) {
  const settings = store.getSettings();
  await store.saveSettings({ ...settings, mcp: { enabled: false, port: settings.mcp?.port ?? 0 } });
}
