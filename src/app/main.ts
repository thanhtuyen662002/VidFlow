import { fileURLToPath } from 'node:url';
import type { Services } from './ipc.ts';
import type { ProgressSource } from '../service/progress.ts';
import { registerIpc } from './ipc.ts';
import { createProgressForwarder } from './progress.ts';

export function getSecureWebPreferences() {
  return { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)) } as const;
}

/** Called by the application composition root with the same service instance as MCP. */
export async function startElectron(services: Services & ProgressSource, rendererUrl: string) {
  const { app, BrowserWindow, ipcMain } = await import('electron');
  const target = new URL(rendererUrl);
  if (target.protocol !== 'file:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname))) throw new Error('Untrusted renderer URL');
  const trusted = (url: string) => {
    try { const candidate = new URL(url); return target.protocol === 'file:' ? candidate.protocol === 'file:' && candidate.pathname === target.pathname && candidate.host === target.host : candidate.origin === target.origin; } catch { return false; }
  };
  await app.whenReady();
  const windows = new Set<InstanceType<typeof BrowserWindow>>();
  const unregister = registerIpc(ipcMain, services, event => {
    const e = event as Electron.IpcMainInvokeEvent;
    return [...windows].some(w => !w.isDestroyed() && e.sender === w.webContents && e.senderFrame === w.webContents.mainFrame && trusted(e.senderFrame.url));
  });
  function createWindow() {
    const window = new BrowserWindow({ width: 1280, height: 800, webPreferences: getSecureWebPreferences() });
    windows.add(window);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault(); });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    const unsubscribe = createProgressForwarder(services, (channel, payload) => {
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
