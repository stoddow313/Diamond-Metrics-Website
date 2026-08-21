// Dedicated media worker entry point.
//
// TOPOLOGY NOTE: a Render persistent disk attaches to exactly one service,
// so this worker cannot share the API's SQLite file on Render today. It is
// supported for (a) local/single-host runs where the DB path is shared, and
// (b) after the documented Postgres migration, when both services talk to a
// managed database. Until then production runs the inline worker inside the
// API service (DM_INLINE_WORKER unset). See docs/COMMAND_OPS.md.
import { db } from './db.js';
import { processNextMediaJob } from './mediaWorker.js';
import { log, captureError, installProcessHandlers } from './observability.js';

installProcessHandlers();
log('info', 'worker_started', { component: 'media_worker' });

const loop = async () => {
  try {
    const worked = await processNextMediaJob(db);
    setTimeout(loop, worked ? 50 : 3000);
  } catch (err) {
    captureError(err, { event: 'worker_loop_failed', component: 'media_worker' });
    setTimeout(loop, 5000);
  }
};
loop();
