// Writes release/vidflow-update.json, the file installed copies of VidFlow read to find a newer version
// (DEFAULT_UPDATE_SOURCE in src/app/updater.ts). Upload it together with the installer to the GitHub
// release v<version>. An optional first argument becomes the release notes shown in the install dialog.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `VidFlow-Setup-${version}.exe`;
const installer = join(root, 'release', name);
if (!existsSync(installer)) {
  console.error(`update-manifest: ${installer} not found; run npm run package:win first`);
  process.exit(1);
}
const hash = createHash('sha256');
for await (const chunk of createReadStream(installer)) hash.update(chunk);
const manifest = {
  version,
  url: `https://github.com/thanhtuyen662002/VidFlow/releases/download/v${version}/${name}`,
  sha256: hash.digest('hex'),
  size: statSync(installer).size,
  ...(process.argv[2] ? { releaseNotes: process.argv[2] } : {}),
};
writeFileSync(join(root, 'release', 'vidflow-update.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`update-manifest: wrote release/vidflow-update.json for ${version}`);
