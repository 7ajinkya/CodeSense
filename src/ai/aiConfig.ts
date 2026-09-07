/**
 * AI Layer V1 configuration. Local-only, environment-driven.
 *
 *   CODESENSE_AI_API_KEY      Bearer token for the chat-completions endpoint.
 *   CODESENSE_AI_BASE_URL     Default: https://api.openai.com/v1
 *   CODESENSE_AI_MODEL        Default: gpt-4o-mini
 *   CODESENSE_AI_TIMEOUT_MS   Default: 60000
 *
 * Values may come from a project-root `.env` file (loaded once at extension
 * startup via `loadWorkspaceEnvFile`) or from the process environment
 * directly. Explicitly set environment variables always win over `.env`.
 *
 * Nothing secret is ever committed or stored in source. The extension reads
 * configuration at evaluation time so tests and harnesses can inject values
 * through process.env without touching product code.
 */

import * as path from 'path';
import * as dotenv from 'dotenv';

export const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_AI_MODEL = 'gpt-4o-mini';
export const DEFAULT_AI_TIMEOUT_MS = 60 * 1000;

export interface AiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /**
   * True when a provider call can plausibly succeed: either an API key is
   * present, or a custom (e.g. local) base URL was explicitly configured.
   */
  enabled: boolean;
}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

/**
 * Load `<workspaceRoot>/.env` into process.env, once, at extension startup.
 *
 * - No workspace root (or no `.env` file there) is a silent no-op: the
 *   existing environment-variable behavior remains the fallback.
 * - Variables already present in the environment are never overridden;
 *   explicit environment always wins over `.env` (dotenv default).
 * - Never throws: configuration loading must not be able to crash startup.
 */
export function loadWorkspaceEnvFile(workspaceRoot: string | undefined): void {
  if (!workspaceRoot) {
    return;
  }
  try {
    dotenv.config({ path: path.join(workspaceRoot, '.env') });
  } catch (err) {
    console.error(`CodeSense: failed to load .env (${String(err)})`);
  }
}

export function readAiConfig(): AiConfig {
  const apiKey = env('CODESENSE_AI_API_KEY');
  const customBaseUrl = env('CODESENSE_AI_BASE_URL');
  const baseUrl = customBaseUrl || DEFAULT_AI_BASE_URL;
  const model = env('CODESENSE_AI_MODEL') || DEFAULT_AI_MODEL;
  const timeoutRaw = Number(env('CODESENSE_AI_TIMEOUT_MS'));
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : DEFAULT_AI_TIMEOUT_MS;
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    timeoutMs,
    enabled: apiKey.length > 0 || customBaseUrl.length > 0,
  };
}
