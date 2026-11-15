import 'dotenv/config';
import { assertEnv, config, ensureDbDir } from './config.js';
import { buildServer } from './server/app.js';

assertEnv();
ensureDbDir();
const app = await buildServer();
await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`Since running at http://127.0.0.1:${config.port}`);
