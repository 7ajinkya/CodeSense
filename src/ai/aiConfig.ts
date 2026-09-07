/**
 * AI Layer V1 configuration. Local-only, environment-driven.
 *
 *   CODESENSE_AI_API_KEY      Bearer token for the chat-completions endpoint.
 *   CODESENSE_AI_BASE_URL     Default: https://api.openai.com/v1
 *   CODESENSE_AI_MODEL        Default: gpt-4o-mini
 *   CODESENSE_AI_TIMEOUT_MS   Default: 60000
 *
 * Nothing secret is ever committed or stored in source. The extension reads
 * configuration at evaluation time so tests and harnesses can inject values
 * through process.env without touching product code.
 */

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
