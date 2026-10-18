// Builtins-only inherited entry: authenticate before importing any implementation.
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';

try {
  const context = JSON.parse(process.env.SENNEL_PROCESS_PROTOTYPE_CONTEXT ?? 'null');
  if (!context) throw new Error('EXECUTION_CONTEXT_REQUIRED');
  const snapshot = context.transport === 'mailbox'
    ? { bytes: fs.readFileSync(context.snapshotFile).toString('base64'), revision: context.revision }
    : await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: context.port });
    let pending = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('SNAPSHOT_UNAVAILABLE')); }, 5000);
    const fail = (error) => { clearTimeout(timer); socket.destroy(); reject(error); };
    socket.once('connect', () => socket.write(JSON.stringify({ context, operation: 'snapshot', payload: {} }) + '\n'));
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      if (pending.length > 1024 * 1024) return fail(new Error('SNAPSHOT_TOO_LARGE'));
      if (!pending.includes('\n')) return;
      try {
        const frame = JSON.parse(pending.slice(0, pending.indexOf('\n')));
        clearTimeout(timer); socket.destroy();
        if (frame.type !== 'result') reject(new Error(frame.code)); else resolve(frame.value);
      } catch (error) { fail(error); }
    });
    socket.once('error', fail);
    socket.once('close', () => { clearTimeout(timer); if (!pending.includes('\n')) reject(new Error('SNAPSHOT_UNAVAILABLE')); });
  });
  const bytes = Buffer.from(snapshot.bytes, 'base64');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== snapshot.revision || digest !== context.revision) throw new Error('SNAPSHOT_REVISION_MISMATCH');
  const implementation = await import('data:text/javascript;base64,' + snapshot.bytes);
  await implementation.main(context, process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.code ?? error.message}\n`);
  process.exitCode = 125;
}
