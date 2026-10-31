import { startElectron } from './main.ts';

void startElectron().catch(error => {
  console.error(error);
  process.exit(1);
});
