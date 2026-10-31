// Copies the external tools VidFlow needs into vendor/ so electron-builder ships them in the installer:
// ffmpeg/ffprobe (VIDFLOW_FFMPEG/VIDFLOW_FFPROBE, else PATH) and the Chromium builds the locked Playwright uses
// (PLAYWRIGHT_BROWSERS_PATH, else %LOCALAPPDATA%\ms-playwright, which `npm ci` fills through postinstall).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = join(root, 'vendor');

function fail(message) {
  console.error(`vendor-tools: ${message}`);
  process.exit(1);
}
function findTool(tool) {
  const override = process.env[`VIDFLOW_${tool.toUpperCase()}`];
  if (override) return existsSync(override) ? override : fail(`VIDFLOW_${tool.toUpperCase()} does not exist: ${override}`);
  for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory.replace(/^"|"$/g, ''), `${tool}.exe`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return fail(`${tool}.exe not found; set VIDFLOW_${tool.toUpperCase()} or put it on PATH`);
}

rmSync(vendor, { recursive: true, force: true });

const ffmpegDir = join(vendor, 'ffmpeg');
mkdirSync(ffmpegDir, { recursive: true });
for (const tool of ['ffmpeg', 'ffprobe']) {
  const source = findTool(tool);
  cpSync(source, join(ffmpegDir, `${tool}.exe`));
  console.log(`vendor-tools: ${tool} <- ${source}`);
  // Builds such as gyan.dev keep their license one level above bin/.
  const license = join(dirname(dirname(source)), 'LICENSE');
  if (existsSync(license) && !existsSync(join(ffmpegDir, 'LICENSE'))) cpSync(license, join(ffmpegDir, 'LICENSE'));
}

const require = createRequire(import.meta.url);
const { browsers } = JSON.parse(readFileSync(join(dirname(require.resolve('playwright-core')), 'browsers.json'), 'utf8'));
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.env.LOCALAPPDATA || '', 'ms-playwright');
for (const name of ['chromium', 'chromium-headless-shell']) {
  const browser = browsers.find(entry => entry.name === name);
  if (!browser) fail(`playwright-core does not list ${name}`);
  const folder = `${name.replaceAll('-', '_')}-${browser.revision}`;
  const source = join(browsersPath, folder);
  if (!existsSync(join(source, 'INSTALLATION_COMPLETE'))) fail(`${source} is missing; run \`npx playwright install chromium\``);
  cpSync(source, join(vendor, 'ms-playwright', folder), { recursive: true });
  console.log(`vendor-tools: ${folder} <- ${source}`);
}
