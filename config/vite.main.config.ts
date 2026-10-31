import { builtinModules } from 'node:module';
import { copyFileSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const dependencies = Object.keys(manifest.dependencies ?? {});
const builtins = new Set(builtinModules);

export default defineConfig({
  // Do not inherit the renderer root or its React plugin.
  root: fileURLToPath(root),
  publicDir: false,
  build: {
    target: 'node24',
    outDir: 'dist-electron',
    emptyOutDir: true, // Separate from renderer/dist.
    rollupOptions: {
      input: fileURLToPath(new URL('src/app/entry.ts', root)),
      external: (id: string) => id === 'electron' || id.startsWith('node:') || builtins.has(id)
        || dependencies.some(name => id === name || id.startsWith(`${name}/`)),
      output: { format: 'es', entryFileNames: 'main.mjs', inlineDynamicImports: true },
    },
  },
  plugins: [{
    name: 'copy-sandbox-preload',
    transform(code, id) {
      // Preserve the two runtime resource URLs after their modules are bundled.
      const path = id.replaceAll('\\', '/');
      if (path.endsWith('/src/flow/selectors.ts'))
        return code.replace("'../../config/flow-selectors.json'", "'./assets/flow-selectors.json'");
      if (path.endsWith('/src/script/prompts.ts'))
        return code.replace("'../../prompts/'", "'./assets/prompts/'");
    },
    closeBundle() {
      copyFileSync(new URL('src/app/preload.cjs', root), new URL('dist-electron/preload.cjs', root));
      cpSync(new URL('config/flow-selectors.json', root), new URL('dist-electron/assets/flow-selectors.json', root));
      const prompts = new URL('prompts/', root);
      if (existsSync(prompts)) cpSync(prompts, new URL('dist-electron/assets/prompts/', root), { recursive: true });
    },
  }],
});
