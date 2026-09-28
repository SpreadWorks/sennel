import fs from "node:fs";
import path from "node:path";

/** Filesystem boundary for source discovery, reads, and relative resolution. */
export class SourceRepository {
  constructor(root) { this.root = path.resolve(root); }
  #inside(absolute) {
    const relative = path.relative(this.root, absolute);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }
  #relative(absolute) { return path.relative(this.root, absolute).split(path.sep).join("/"); }
  list(relative) {
    const absolute = path.resolve(this.root, relative);
    if (!this.#inside(absolute) || !fs.existsSync(absolute)) return [];
    const files = [];
    const walk = (directory) => {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, item.name);
        if (item.isDirectory()) walk(full);
        else if (item.isFile() && item.name.endsWith(".js")) files.push(this.#relative(full));
      }
    };
    if (fs.statSync(absolute).isDirectory()) walk(absolute);
    else if (absolute.endsWith(".js")) files.push(this.#relative(absolute));
    return files.sort();
  }
  read(file) { return fs.readFileSync(path.join(this.root, file), "utf8"); }
  resolve(from, specifier) {
    const absolute = path.resolve(this.root, path.dirname(from), specifier);
    if (!this.#inside(absolute)) throw new Error(`dependency escapes repository: ${specifier}`);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`missing dependency: ${specifier}`);
    const real = fs.realpathSync(absolute);
    if (!this.#inside(real) || !absolute.endsWith(".js")) throw new Error(`unsupported dependency: ${specifier}`);
    return this.#relative(real);
  }
}

/** A non-I/O source repository for graph/rule unit tests. */
export class MemorySourceRepository {
  constructor(files) { this.files = new Map(files); }
  list(relative) { return [...this.files.keys()].filter((file) => file === relative || file.startsWith(`${relative}/`)).sort(); }
  read(file) {
    if (!this.files.has(file)) throw new Error(`missing source: ${file}`);
    return this.files.get(file);
  }
  resolve(from, specifier) {
    const result = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
    if (result === ".." || result.startsWith("../") || path.posix.isAbsolute(result)) throw new Error(`dependency escapes repository: ${specifier}`);
    if (!result.endsWith(".js")) throw new Error(`unsupported dependency: ${specifier}`);
    if (!this.files.has(result)) throw new Error(`missing dependency: ${specifier}`);
    return result;
  }
}
