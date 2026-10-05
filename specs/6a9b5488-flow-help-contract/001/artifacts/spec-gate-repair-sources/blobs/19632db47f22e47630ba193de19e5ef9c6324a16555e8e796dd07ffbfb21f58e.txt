import { PRODUCT } from "./product.js";

function officialPluginRoot(envName) {
  return process.env[envName] || null;
}

export function officialPresetPluginRoot() {
  return officialPluginRoot(PRODUCT.env("OFFICIAL_PRESETS_REPO"));
}
