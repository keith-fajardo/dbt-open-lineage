import * as fs from "fs";

export interface StableArtifactOptions {
  attempts?: number;
  delayMs?: number;
  readText?: (filePath: string) => Promise<string>;
  wait?: (delayMs: number) => Promise<void>;
}

const defaultReadText = (filePath: string) => fs.promises.readFile(filePath, "utf8");
const defaultWait = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

/** Read and parse a dbt artifact while tolerating dbt's non-atomic rewrite.
 *
 * File-system watchers can fire after the truncate/write starts but before a
 * multi-megabyte manifest is complete. Retrying the complete read+parse keeps
 * that transient half-JSON state out of the webview. The parser is deliberately
 * supplied by the caller so this works for both raw JSON snapshots and the
 * Graph projection built from manifest.json. */
export async function readStableArtifact<T>(
  filePath: string,
  parse: (text: string) => T,
  opts: StableArtifactOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 12);
  const delayMs = Math.max(0, opts.delayMs ?? 125);
  const readText = opts.readText ?? defaultReadText;
  const wait = opts.wait ?? defaultWait;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return parse(await readText(filePath));
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(delayMs);
    }
  }

  throw lastError;
}

/** Return a validated JSON snapshot without changing its original text. */
export function readStableJsonText(filePath: string, opts?: StableArtifactOptions): Promise<string> {
  return readStableArtifact(filePath, (text) => {
    JSON.parse(text);
    return text;
  }, opts);
}
