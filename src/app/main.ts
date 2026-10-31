import { fileURLToPath } from 'node:url';
import type { Services } from './ipc.ts';
import type { ProgressSource } from '../service/progress.ts';
import { registerIpc } from './ipc.ts';
import { createProgressForwarder } from './progress.ts';
import { createMcpLifecycle } from './mcp/lifecycle.ts';
import type { McpSettingsStore } from './mcp/settings.ts';
import { createMcpSettingsStore } from './mcp/settings.ts';
import { openDatabase } from '../db.ts';
import { createUpdater, DEFAULT_UPDATE_SOURCE } from './updater.ts';
import { withUpdates } from './update-service.ts';
import { dataDirectory, resolveInside } from '../paths.ts';
import { spawn } from 'node:child_process';
import { browserMotion } from '../motion/runtime.ts';

export function getSecureWebPreferences() {
  return { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)) } as const;
}

/** Called by the application composition root with the same service instance as MCP. */
export async function startElectron(services?: Services & ProgressSource & { mcpSettingsStore?: McpSettingsStore; useMcpSettingsStore?: (store: McpSettingsStore) => void }, rendererUrl = new URL('../renderer/dist/index.html', import.meta.url).href, settings?: McpSettingsStore) {
  const { app, BrowserWindow, ipcMain, dialog } = await import('electron');
  if (!services) {
    process.env.VIDFLOW_HOME ||= app.getPath('userData');
    const [{ createCoreService }, { configuredLlm }, { createPageDriver }, { launchFlowContext }] = await Promise.all([
      import('../service/index.ts'), import('../script/config.ts'), import('../flow/pageDriver.ts'), import('../flow/driver.ts'),
    ]);
    const db = openDatabase();
    app.once('will-quit', () => db.close());
    services = createCoreService({ db, motion: browserMotion(db),
      llm: { complete: request => configuredLlm().complete(request) },
      flowDriver: createPageDriver(async accountId => ({ db, browser: await launchFlowContext(accountId),
        url: 'https://labs.google/fx/tools/flow', timeoutMs: 30000 })),
    });
  }
  const activeServices = services;
  const target = new URL(rendererUrl);
  if (target.protocol !== 'file:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname))) throw new Error('Untrusted renderer URL');
  const trusted = (url: string) => {
    try { const candidate = new URL(url); return target.protocol === 'file:' ? candidate.protocol === 'file:' && candidate.pathname === target.pathname && candidate.host === target.host : candidate.origin === target.origin; } catch { return false; }
  };
  await app.whenReady();
  if (settings) services.useMcpSettingsStore?.(settings);
  const sharedSettings = settings ?? services.mcpSettingsStore;
  const settingsDb = sharedSettings ? undefined : openDatabase();
  const store = sharedSettings ?? createMcpSettingsStore(settingsDb!);
  let commands: Services = services;
  if (app.isPackaged || process.env.VIDFLOW_ENABLE_UPDATES === '1') {
    const updater = createUpdater({
      config: () => ({ channel: store.getSettings().updates?.channel ?? 'dev', sourceUrl: store.getSettings().updates?.sourceUrl || DEFAULT_UPDATE_SOURCE }),
      currentVersion: app.getVersion(), directory: resolveInside(dataDirectory(), 'updates'),
      confirm: async manifest => (await dialog.showMessageBox({ type: 'question',
        title: 'Cập nhật VidFlow', message: `Cài phiên bản ${manifest.version}?`, detail: manifest.releaseNotes ?? '',
        buttons: ['Cài và khởi động lại', 'Để sau'], defaultId: 1, cancelId: 1, noLink: true })).response === 0,
      install: async file => {
        if (process.platform !== 'win32') throw Object.assign(new Error('Windows only'), { code: 'UNSUPPORTED_PLATFORM' });
        await new Promise<void>((resolve, reject) => {
          const child = spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: true, timeout: 120000 });
          child.once('error', reject);
          child.once('spawn', () => { child.unref(); resolve(); });
        });
        app.quit();
      },
    });
    // The renderer checks on start and offers the update; see renderer/src/Update.tsx.
    commands = withUpdates(services, updater);
  }
  const mcp = createMcpLifecycle(commands, store);
  try { await mcp.start(); } catch (error) { await mcp.stop(); settingsDb?.close(); throw error; }
  let quitting = false;
  app.on('before-quit', event => {
    if (!mcp || quitting) return;
    event.preventDefault();
    void mcp.stop().finally(() => { settingsDb?.close(); quitting = true; app.quit(); });
  });
  const windows = new Set<InstanceType<typeof BrowserWindow>>();
  const unregister = registerIpc(ipcMain, commands, event => {
    const e = event as Electron.IpcMainInvokeEvent;
    return [...windows].some(w => !w.isDestroyed() && e.sender === w.webContents && e.senderFrame === w.webContents.mainFrame && trusted(e.senderFrame.url));
  });
  function createWindow() {
    // The app header is the title bar: no native frame or menu. On Windows and Linux the system draws
    // minimize/maximize/close over the header's right end (renderer .topbar reserves that area).
    const window = new BrowserWindow({ width: 1360, height: 860, minWidth: 980, minHeight: 640, backgroundColor: '#f4f5f9',
      ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#f4f5f9', symbolColor: '#5e6578', height: 44 } }),
      webPreferences: getSecureWebPreferences() });
    window.removeMenu();
    windows.add(window);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault(); });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    const unsubscribe = createProgressForwarder(activeServices, (channel, payload) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
    });
    window.once('closed', () => { unsubscribe(); windows.delete(window); });
    void window.loadURL(target.href).catch(() => window.close());
    return window;
  }
  app.on('activate', () => { if (!windows.size) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.once('will-quit', unregister);
  return createWindow();
}
