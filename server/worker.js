// Dedicated media worker entry point (Render background worker service).
// Shares the SQLite database in WAL mode with the web service.
import { db } from './db.js';
import { processNextMediaJob } from './mediaWorker.js';

console.log('[worker] Diamond Metrics media worker started');
const loop = async () => {
  try {
    const worked = await processNextMediaJob(db);
    setTimeout(loop, worked ? 50 : 3000);
  } catch (err) {
    console.error('[worker]', err.message);
    setTimeout(loop, 5000);
  }
};
loop();
