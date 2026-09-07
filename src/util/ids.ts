import { randomUUID } from 'crypto';

export function generateEventId(): string {
  return 'evt_' + randomUUID();
}

export function generateSessionId(): string {
  return 'ses_' + randomUUID();
}

export function generateWorkspaceId(workspacePath: string): string {
  // Stable, non-reversible-looking identifier derived from the workspace path.
  return 'ws_' + hashString(workspacePath);
}

function hashString(s: string): string {
  // FNV-1a — small, dependency-free, stable across sessions.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
