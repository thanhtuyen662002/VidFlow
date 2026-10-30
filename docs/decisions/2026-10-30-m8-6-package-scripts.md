# M8.6: package manifest decided by the owner

Coders may not edit `package.json` (AGENTS.md). The owner therefore declared the manifest entries that M8.6 needs.

- `"main": "dist-electron/main.mjs"`. This is the bundled Electron main process. Electron does not run the TypeScript sources directly.
- `build:renderer` runs `vite build`, which builds `renderer/` into `renderer/dist` (`vite.config.ts`).
- `build:main` runs `vite build --config vite.main.config.ts`. M8.6 creates that file. It bundles the Electron composition root, for example `src/app/entry.ts`, which calls `startElectron` with the same services as MCP. The output goes to `dist-electron/main.mjs`, with `electron` and Node built-ins external. `src/app/preload.cjs` is copied next to it, because `getSecureWebPreferences` resolves the preload relative to the bundled main file.
- `build` runs both builds.
- `package:win` runs `npm run build && electron-builder --win nsis --x64 --config electron-builder.yml`. M8.6 creates `electron-builder.yml`.

No new dependency is added: Vite, Electron and electron-builder are already locked.
