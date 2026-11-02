import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `metaUrl` is the script Node was asked to run, so
 * `main()` should execute; false when it was imported (e.g. by a test).
 *
 * Both sides are realpath'd: Node's ESM loader resolves symlinks in
 * `import.meta.url` but never in `process.argv[1]`, so a plain string
 * comparison is false whenever the script is invoked by an absolute path
 * that crosses a symlink, and `main()` silently doesn't run (#194).
 *
 * Returns false, without throwing, when `argv1` is missing or either path
 * can't be resolved.
 */
export function isInvokedAsCli(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argv1));
  } catch {
    return false;
  }
}
