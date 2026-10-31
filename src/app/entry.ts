import { startElectron } from './main.ts';
import { useBundledTools } from './bundled-tools.ts';

useBundledTools(process.resourcesPath);

void startElectron().catch(error => {
  console.error(error);
  process.exit(1);
});
