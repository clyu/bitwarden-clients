/**
 * The vault folder could not be read or written. It surfaces to the app as a failed network call.
 */
export class LocalVaultIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalVaultIoError";
  }
}

/**
 * A minimal hierarchical file store that holds the local vault.
 *
 * Every path is a list of name segments relative to the root of the vault, so an empty list
 * refers to the root itself. Every operation fails with a {@link LocalVaultIoError} if the vault
 * folder cannot be reached.
 */
export interface LocalVaultFileSystem {
  /**
   * Returns the names of the entries directly inside the directory, or an empty list if the
   * directory does not exist.
   */
  list(directory: string[]): Promise<string[]>;

  /**
   * Returns `true` if a file or a directory exists at the given path.
   */
  exists(path: string[]): Promise<boolean>;

  /**
   * Returns the content of the file at the given path, or `null` if there is no file at that path.
   */
  read(path: string[]): Promise<Uint8Array | null>;

  /**
   * Writes the file at the given path. Any existing content is replaced and any missing parent
   * directories are created.
   */
  write(path: string[], content: Uint8Array): Promise<void>;

  /**
   * Renames the entry at the given path to the new name, keeping it in the same directory.
   * Returns `true` if the entry was renamed.
   */
  rename(path: string[], newName: string): Promise<boolean>;

  /**
   * Deletes the entry at the given path, including everything inside it if it is a directory.
   * Returns `true` if nothing remains at that path.
   */
  delete(path: string[]): Promise<boolean>;
}
