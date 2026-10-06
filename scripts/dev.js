// `npm run dev`: the API and the Vite site together, with the site proxying
// /api to the API so the browser sees one origin.
//
//   npm run dev                                                  site :5173, API :3001
//   PORT=5901 HOST=0.0.0.0 npm run dev -- --host 0.0.0.0 --port 5901
//
// PORT / HOST (and Vite's own --port / --host, passed through untouched) pick
// where the site answers; HOST=0.0.0.0 is what a phone on the studio's
// http://<mac>.local:<port> link needs. The API listens on DM_API_PORT, else
// 3001 — or, when another process already holds 3001, on a free port, so the
// site's /api never reaches some other server by accident. DM_API_PROXY still
// overrides where the site sends /api.
import net from 'node:net';
import process from 'node:process';
import concurrently from 'concurrently';

const DEFAULT_API_PORT = 3001;

function portIsFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function chooseApiPort() {
  if (process.env.DM_API_PORT) return Number(process.env.DM_API_PORT);
  if (process.env.DM_API_PROXY || await portIsFree(DEFAULT_API_PORT)) return DEFAULT_API_PORT;
  const port = await freePort();
  console.log(`[dev] Port ${DEFAULT_API_PORT} is held by another process; this API runs on ${port} instead.`);
  return port;
}

const shellQuote = arg => `'${String(arg).replace(/'/g, `'\\''`)}'`;

const apiPort = await chooseApiPort();
const apiProxy = process.env.DM_API_PROXY || `http://localhost:${apiPort}`;
const viteArgs = process.argv.slice(2).map(shellQuote).join(' ');

const { result } = concurrently([
  // PORT belongs to the site; the API reads DM_API_PORT (server/index.js).
  { command: 'npm run server', name: 'api', prefixColor: 'blue', env: { PORT: '', DM_API_PORT: String(apiPort) } },
  { command: `vite ${viteArgs}`.trim(), name: 'web', prefixColor: 'green', env: { DM_API_PROXY: apiProxy } },
], { prefix: 'name', killOthersOn: ['failure'] });

result.then(() => process.exit(0), () => process.exit(1));
