import * as fs from 'fs';
import * as path from 'path';

/**
 * Shared local-first file helpers for Phase 1 stores (problems, attempts,
 * checkpoints). Phase 0's `localStore.ts` is left untouched; new stores use
 * these helpers so path conventions stay consistent (`<workspace>/.codesense/<file>`).
 */

export const STORE_DIR_NAME = '.codesense';

export function storeFilePath(fileName: string, workspacePath?: string): string {
  if (workspacePath) {
    return path.join(workspacePath, STORE_DIR_NAME, fileName);
  }
  return path.join(STORE_DIR_NAME, fileName);
}

export function ensureStoreDir(fileName: string, workspacePath?: string): string {
  const base = path.dirname(storeFilePath(fileName, workspacePath));
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true });
  }
  return base;
}

/** Load a JSON array from disk; returns [] when missing/corrupt (never throws). */
export function loadJsonArray<T>(fileName: string, workspacePath?: string): T[] {
  const file = storeFilePath(fileName, workspacePath);
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    const data = fs.readFileSync(file, 'utf-8');
    const json: unknown = JSON.parse(data);
    if (!Array.isArray(json)) {
      return [];
    }
    return json as T[];
  } catch {
    return [];
  }
}

/** Persist records as pretty-printed JSON (synchronous, local-first). */
export function saveJsonArray(fileName: string, records: unknown, workspacePath?: string): void {
  ensureStoreDir(fileName, workspacePath);
  const file = storeFilePath(fileName, workspacePath);
  fs.writeFileSync(file, JSON.stringify(records, null, 2));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
