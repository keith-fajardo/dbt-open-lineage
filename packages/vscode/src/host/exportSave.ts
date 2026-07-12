export interface SaveIo {
  /** Show a save dialog; resolve the chosen absolute path or undefined (cancel). */
  pick(defaultName: string): Promise<string | undefined>;
  /** Write raw bytes to a path. */
  write(path: string, bytes: Uint8Array): Promise<void>;
}

/** Decode a base64 payload and write it to a user-picked path. Returns false on
 * cancel. `io` is injected so this is pure/testable; extension.ts supplies the
 * vscode-backed implementation. */
export async function saveExport(filename: string, dataB64: string, io: SaveIo): Promise<boolean> {
  const dest = await io.pick(filename);
  if (!dest) return false;
  const bytes = Uint8Array.from(Buffer.from(dataB64, "base64"));
  await io.write(dest, bytes);
  return true;
}
