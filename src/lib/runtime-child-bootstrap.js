// This source is supplied by the active parent's fixed runtime as a data URL.
// It must import only Node builtins: even the on-disk bootstrap may have changed.
import { register } from "node:module";
import { MessageChannel } from "node:worker_threads";
import { readFileSync, closeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
const delivery = JSON.parse(readFileSync(3, "utf8"));
closeSync(3);
const flag = `--import=${import.meta.url}`;
process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || "").replace(flag, "").trim();
const transportSource = new Map(delivery.resources).get("src/lib/runtime-bootstrap-loader.js");
if (!transportSource) throw new Error("RUNTIME_UNPROVEN: child transport loader is unavailable");
register(`data:text/javascript;base64,${transportSource}`, { parentURL: import.meta.url, data: delivery });
const { port1, port2 } = new MessageChannel();
const acknowledged = new Promise((resolve, reject) => {
  port1.once("message", (message) => {
    port1.close();
    if (message.error) reject(new Error(message.error));
    else resolve(message);
  });
});
register(pathToFileURL(path.join(delivery.root, "src/lib/runtime-loader.js")), {
  parentURL: import.meta.url,
  data: { delivery, expectedRevision: delivery.identity.revision, bootstrapUrl: import.meta.url, port: port2 }, transferList: [port2],
});
await acknowledged;
