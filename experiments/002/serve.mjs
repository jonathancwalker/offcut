import { startServer } from '../../server.mjs';
import { fileURLToPath } from 'node:url';

const app = await startServer({
  port: 4318,
  dataDir: fileURLToPath(new URL('../../.data/experiment-002/', import.meta.url)),
});
console.log(`Independent worktable ready at http://127.0.0.1:${app.server.address().port}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => app.server.close(() => process.exit(0)));
}
