import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class EsmModule {
  constructor(filePath, { cacheKey = null } = {}) {
    if (!path.isAbsolute(filePath)) throw new Error("ES module path must be absolute");
    this.filePath = filePath;
    this.cacheKey = cacheKey;
  }

  async import() {
    if (await this.#hasModulePackageScope()) {
      const url = pathToFileURL(this.filePath);
      if (this.cacheKey != null) url.searchParams.set("cache", String(this.cacheKey));
      return import(url.href);
    }
    const source = await fs.promises.readFile(this.filePath, "utf8");
    const rewritten = this.#rewriteRelativeImports(source);
    const encoded = Buffer.from(`${rewritten}\n//# sourceURL=${pathToFileURL(this.filePath).href}\n`)
      .toString("base64");
    const cacheFragment = this.cacheKey == null ? "" : `#cache=${encodeURIComponent(this.cacheKey)}`;
    return import(`data:text/javascript;base64,${encoded}${cacheFragment}`);
  }

  async #hasModulePackageScope() {
    let current = path.dirname(this.filePath);
    while (true) {
      const packagePath = path.join(current, "package.json");
      try {
        const pkg = JSON.parse(await fs.promises.readFile(packagePath, "utf8"));
        return pkg.type === "module";
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }

  #rewriteRelativeImports(source) {
    const resolveSpecifier = (_match, prefix, quote, specifier) => {
      const resolved = path.resolve(path.dirname(this.filePath), specifier);
      return `${prefix}${quote}${pathToFileURL(resolved).href}${quote}`;
    };
    return source.replace(
      /(\b(?:from|import)\s*\(?\s*)(["'])(\.\.?\/[^"']+)\2/g,
      resolveSpecifier,
    );
  }
}
