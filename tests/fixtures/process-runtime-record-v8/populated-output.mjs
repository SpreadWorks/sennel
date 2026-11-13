import path from "node:path";
import { fileURLToPath } from "node:url";

export function expectedOutput() {
  return { stdout: Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256)),
    stderr: Buffer.from("literal stderr:€\0🙂") };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bytes = expectedOutput();
  process.stdout.write(bytes.stdout);
  process.stderr.write(bytes.stderr);
}
