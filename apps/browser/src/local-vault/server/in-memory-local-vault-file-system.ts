import { LocalVaultFileSystem } from "./local-vault-file-system";

const SEPARATOR = "/";

/**
 * A {@link LocalVaultFileSystem} that keeps its files in memory, for tests.
 */
export class InMemoryLocalVaultFileSystem implements LocalVaultFileSystem {
  readonly files = new Map<string, Uint8Array>();

  async list(directory: string[]): Promise<string[]> {
    const prefix = directory.length === 0 ? "" : directory.join(SEPARATOR) + SEPARATOR;
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      if (path.startsWith(prefix)) {
        names.add(path.substring(prefix.length).split(SEPARATOR)[0]);
      }
    }
    return [...names];
  }

  async exists(path: string[]): Promise<boolean> {
    const key = path.join(SEPARATOR);
    return this.files.has(key) || [...this.files.keys()].some((p) => p.startsWith(key + SEPARATOR));
  }

  async read(path: string[]): Promise<Uint8Array | null> {
    return this.files.get(path.join(SEPARATOR)) ?? null;
  }

  async write(path: string[], content: Uint8Array): Promise<void> {
    this.files.set(path.join(SEPARATOR), content.slice());
  }

  async rename(path: string[], newName: string): Promise<boolean> {
    const from = path.join(SEPARATOR);
    const content = this.files.get(from);
    if (content == null) {
      return false;
    }
    this.files.delete(from);
    this.files.set([...path.slice(0, -1), newName].join(SEPARATOR), content);
    return true;
  }

  async delete(path: string[]): Promise<boolean> {
    const key = path.join(SEPARATOR);
    for (const p of [...this.files.keys()]) {
      if (p === key || p.startsWith(key + SEPARATOR)) {
        this.files.delete(p);
      }
    }
    return true;
  }
}
