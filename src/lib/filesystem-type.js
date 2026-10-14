import { statfsSync } from "node:fs";

const TMPFS_TYPE = 0x01021994n;

/** Identify the actual filesystem, independently of selection/cleanup policy. */
export function isTmpfsDirectory(directory, { statfs = statfsSync } = {}) {
  return BigInt(statfs(directory, { bigint: true }).type) === TMPFS_TYPE;
}
