export const portableInvocationSource = `
import { spawn as start } from 'node:child_process';
class PortableInvocation {
  constructor(executable, args) {
    if (typeof executable !== 'string' || executable.length === 0) throw new TypeError('program');
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) throw new TypeError('argv');
    this.executable = executable;
    this.args = Object.freeze([...args]);
    Object.freeze(this);
  }
}
export function launch(invocation) {
  if (!(invocation instanceof PortableInvocation)) throw new TypeError('typed input required');
  return start(invocation.executable, invocation.args, { shell: false });
}
launch(new PortableInvocation(process.execPath, ['worker.js']));
`;
