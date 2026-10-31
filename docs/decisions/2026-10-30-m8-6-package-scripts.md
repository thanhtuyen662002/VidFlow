# M8.6: package manifest decided by the owner

Coders may not edit `package.json` (AGENTS.md). The owner therefore declared the manifest entries that M8.6 needs.

- `"main": "dist-electron/main.mjs"`. This is the bundled Electron main process. Electron does not run the TypeScript sources directly.
- `build:renderer` runs `vite build`, which builds `renderer/` into `renderer/dist` (`vite.config.ts`).
- `build:main` runs `vite build --config config/vite.main.config.ts`. M8.6 creates that file. It bundles the Electron composition root, for example `src/app/entry.ts`, which calls `startElectron` with the same services as MCP. The output goes to `dist-electron/main.mjs`, with `electron` and Node built-ins external. `src/app/preload.cjs` is copied next to it, because `getSecureWebPreferences` resolves the preload relative to the bundled main file.
- `build` runs both builds.
- `package:win` runs `npm run build && electron-builder --win nsis --x64 --config config/electron-builder.yml`. M8.6 creates `config/electron-builder.yml`.

No new dependency is added: Vite, Electron and electron-builder are already locked.

## 2026-10-31: one-click installer with bundled tools

The owner asked for an installer that a user runs once to get everything VidFlow needs.

- `package:win` now runs `node config/vendor-tools.mjs` between the build and electron-builder. The script copies two things into `vendor/` (not in Git):
  - `ffmpeg.exe` and `ffprobe.exe`, taken from `VIDFLOW_FFMPEG`/`VIDFLOW_FFPROBE`, else PATH, together with the ffmpeg license;
  - the Chromium and Chromium headless shell revisions that the locked `playwright-core` expects, taken from `PLAYWRIGHT_BROWSERS_PATH`, else `%LOCALAPPDATA%\ms-playwright`.
- `config/electron-builder.yml` ships `vendor/ffmpeg` and `vendor/ms-playwright` as `extraResources`. The NSIS installer is one-click, per user (no admin prompt), creates desktop and Start menu shortcuts, and starts VidFlow.
- At startup, `src/app/entry.ts` calls `useBundledTools(process.resourcesPath)`. It sets `VIDFLOW_FFMPEG`, `VIDFLOW_FFPROBE` and `PLAYWRIGHT_BROWSERS_PATH` to the bundled copies, but only when the user has not set them and the files exist. A development run therefore keeps PATH.
- `config/vite.main.config.ts` rewrites the preload, Flow selectors and prompts URLs before Vite's asset handling (`enforce: 'pre'`, `@vite-ignore`). Without that, Vite turned them into root-relative `/assets/…` URLs. The packaged window then had no preload, so `window.vidflow` was missing, and Flow selectors and prompts could not be found.
- `config/vite.main.config.ts` defines `process.env` as itself. A client-mode Vite build replaced it with `{}`, so the packaged app ignored `VIDFLOW_HOME`, `APPDATA` and `PATH`: data went to `~/.vidflow` and ffmpeg was never found. `test/bundled-tools.test.ts` guards this.
