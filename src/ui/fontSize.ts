/**
 * Canonical CodeSense UI font size (presentation only).
 *
 * Single source of truth for the CodeSense-wide text-size preference shared
 * by every CodeSense-owned webview (AI sidebar, Start Problem panel). The
 * extension host owns the selected value and persists it in extension
 * global state; each webview applies the scale to its own UI only — global
 * VS Code, editor, and terminal sizing are never touched.
 *
 * Webview scripts cannot import from `src/`, so they carry a tiny mirrored
 * resolver plus matching `data-cs-font` CSS rules; tests pin both surfaces
 * to this list so the mirrors cannot drift.
 */

export interface UiFontSizeOption {
  id: string;
  label: string;
  /** Base body font size in px; all component type scales em-relative. */
  px: number;
}

export const UI_FONT_SIZES: readonly UiFontSizeOption[] = [
  { id: 'small', label: 'Small', px: 12 },
  { id: 'medium', label: 'Medium', px: 13 },
  { id: 'large', label: 'Large', px: 15 },
  { id: 'xlarge', label: 'Extra Large', px: 17 },
  { id: 'huge', label: 'Huge', px: 20 },
  { id: 'xhuge', label: 'Extra Huge', px: 23 },
];

export const DEFAULT_UI_FONT_SIZE_ID = 'medium';

/** Validate a stored/posted value; anything unknown falls back to Medium. */
export function resolveUIFontSize(value: unknown): string {
  if (typeof value === 'string' && UI_FONT_SIZES.some((option) => option.id === value)) {
    return value;
  }
  return DEFAULT_UI_FONT_SIZE_ID;
}

/** Base px for a size id; unknown ids fall back to the Medium scale. */
export function uiFontSizePx(id: string): number {
  return UI_FONT_SIZES.find((option) => option.id === id)?.px ?? 13;
}

/**
 * Shared `<option>` markup for the CodeSense text-size selector, used by
 * every CodeSense-owned webview so the six levels can never drift between
 * surfaces. Host-side only; webview scripts keep a tiny mirrored resolver.
 */
export function fontSizeSelectOptionsHtml(selectedId: string): string {
  return UI_FONT_SIZES.map(
    (option) =>
      `<option value="${option.id}"${option.id === selectedId ? ' selected' : ''}>${option.label}</option>`,
  ).join('');
}
