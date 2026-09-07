/**
 * Language identification. The event layer is language-agnostic; this module
 * only recognizes and classifies languages for metadata purposes.
 */

export interface LanguageInfo {
  languageId: string;
  /** Canonical name used in reports/timelines. */
  name: string;
}

const KNOWN_LANGUAGES: Record<string, LanguageInfo> = {
  python: { languageId: 'python', name: 'Python' },
  java: { languageId: 'java', name: 'Java' },
};

/** Recognized first-class languages (extensible in future phases). */
export function identifyLanguage(languageId: string): LanguageInfo | undefined {
  return KNOWN_LANGUAGES[languageId];
}

export function isSupportedLanguage(languageId: string): boolean {
  return identifyLanguage(languageId) !== undefined;
}

/** Extract a safe display name from a document URI/path. */
export function baseName(pathOrUri: string): string {
  const parts = pathOrUri.split(/[\\/]/);
  return parts[parts.length - 1] || pathOrUri;
}
