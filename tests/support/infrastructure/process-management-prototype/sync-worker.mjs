// One persistent control thread, shared by synchronous calls in one client.
import { parentPort, workerData } from 'node:worker_threads';
import crypto from 'node:crypto';
const bytes = Buffer.from(workerData.snapshot, 'base64');
if (crypto.createHash('sha256').update(bytes).digest('hex') !== workerData.context.revision) throw new Error('SNAPSHOT_REVISION_MISMATCH');
const { execute } = await import('data:text/javascript;base64,' + workerData.snapshot);
parentPort.on('message', async ({ spec, memory, state }) => {
  const status = new Int32Array(state);
  let result;
  try { result = { value: await execute(workerData.context, spec.executable, spec.args, spec.options) }; }
  catch (error) { result = { error: { code: error.code, message: error.message } }; }
  let bytes = Buffer.from(JSON.stringify(result));
  if (bytes.length > memory.byteLength) bytes = Buffer.from(JSON.stringify({ error: { code: 'BRIDGE_OUTPUT_LIMIT' } }));
  new Uint8Array(memory).set(bytes);
  Atomics.store(status, 1, bytes.length); Atomics.store(status, 0, 1); Atomics.notify(status, 0);
});
