// Capture dependencies stay in this isolated thread, outside the application
// module cache. Both hook backends reuse the loader's selection and snapshot.
import { parentPort, workerData } from "node:worker_threads";
import { initialize } from "./runtime-loader.js";

initialize({ ...workerData, port: parentPort, includeDelivery: true });
