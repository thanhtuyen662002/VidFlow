# M8.6 Windows packaging

The owner manifest was read and matches the declared main and all four build
scripts. Neither manifest nor lockfile was edited. The only builder configuration
is `config/electron-builder.yml`; there was no root builder file to remove.

Build paths:

- `vite.config.ts`: `renderer/index.html` to `renderer/dist/` (unchanged).
- `config/vite.main.config.ts`: `src/app/entry.ts` to `dist-electron/main.mjs`,
  ESM, Node 24. Electron, Node built-ins and every production dependency,
  including dependency subpaths, stay external. electron-builder collects the
  production dependencies required at runtime.
- The entry only calls the existing `startElectron` and exits on failure. Main
  can now compose the existing core service when no service is injected. The
  existing IPC/MCP/window lifecycle remains shared. LLM configuration is read
  lazily when a completion is requested, using the existing environment contract.
- The closeBundle hook copies `src/app/preload.cjs` to
  `dist-electron/preload.cjs`, matching the existing relative preload URL.
  It also copies Flow selectors and, when present, the repository prompts folder
  into `dist-electron/assets/`; its transform adjusts their relative runtime URLs.
- `npm run package:win` builds both outputs, then creates an unsigned x64 NSIS
  installer in `release/`. NSIS uses a per-user wizard with directory selection.

The positive whitelist is package.json, renderer/dist/**/* and dist-electron/**/*.
Explicit exclusions cover profiles/** and nested profiles, test/**, tests/** and
nested test folders, *.test.*, *.spec.*, data/**, userData/** and nested data
folders, *.sqlite*, *.db, .env* and nested .env files, docs/** and src/**.
There is no certificate configuration or publishing token. Signing and executable
editing are disabled. No build/ or icon exists, so neither is referenced.

Electron defaults VIDFLOW_HOME to app.getPath('userData') before opening its DB;
an explicit VIDFLOW_HOME still takes precedence. Profiles already use the shared
data directory rather than the repository or installation directory.

Two node:test cases in src/app/__tests__/packaging.test.ts inspect the builder,
bundle/preload paths and manifest contract without importing Electron or Vite.
Tests and electron-builder were not run, as instructed. No node_modules or
tsconfig.json is supplied in this workspace, so a TypeScript compile could not
be performed. Static import and path review was performed instead.

The supplied context does not contain prompts/. The build copies it when present
in the full checkout; script generation still requires those existing runtime
prompts. Playwright browser provisioning remains the existing external
PLAYWRIGHT_BROWSERS_PATH / Playwright installation contract. ffmpeg/ffprobe remain
external tools resolved by existing environment/PATH logic.
