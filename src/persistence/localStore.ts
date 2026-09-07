import * as fs from 'fs';
import * as path from 'path';
import { ActivityEvent } from '../events/activityEvent';
import { CodingSession, updatePrimaryLanguage } from '../session/codingSession';
import { SessionStore } from './sessionStore';

const STORAGE_DIR = '.codesense';
const SESSIONS_FILE = 'sessions.json';

export function getStoragePath(workspacePath?: string): string {
	if (workspacePath) {
		return path.join(workspacePath, STORAGE_DIR, SESSIONS_FILE);
	}
	return path.join(STORAGE_DIR, SESSIONS_FILE);
}

export function ensureStorageDir(workspacePath?: string): string {
	const base = path.dirname(getStoragePath(workspacePath));
	if (!fs.existsSync(base)) {
		fs.mkdirSync(base, { recursive: true });
	}
	return base;
}

function parseStoredEvent(rawEvent: unknown): ActivityEvent | null {
	if (typeof rawEvent !== 'object' || rawEvent === null) {
		return null;
	}
	const e = rawEvent as Record<string, unknown>;
	if (
		typeof e.eventId !== 'string' ||
		typeof e.sessionId !== 'string' ||
		typeof e.timestamp !== 'string' ||
		typeof e.eventType !== 'string' ||
		typeof e.source !== 'string' ||
		typeof e.schemaVersion !== 'number' ||
		typeof e.payload !== 'object' ||
		e.payload === null
	) {
		return null;
	}
	const event: ActivityEvent = {
		eventId: e.eventId,
		sessionId: e.sessionId,
		timestamp: e.timestamp,
		eventType: e.eventType as ActivityEvent['eventType'],
		source: e.source as ActivityEvent['source'],
		schemaVersion: e.schemaVersion,
		payload: e.payload,
	};
	// Phase 1: preserve the attempt linkage when present; Phase 0 history
	// simply has no such field.
	if (typeof e.attemptId === 'string') {
		event.attemptId = e.attemptId;
	}
	return event;
}

export function loadSessionsFromDisk(workspacePath?: string): CodingSession[] {
	const file = getStoragePath(workspacePath);
	if (!fs.existsSync(file)) {
		return [];
	}
	try {
		const data = fs.readFileSync(file, 'utf-8');
		const json: unknown = JSON.parse(data);
		if (!Array.isArray(json)) {
			return [];
		}
		const sessions: CodingSession[] = [];
		for (const item of json) {
			if (typeof item !== 'object' || item === null) {
				continue;
			}
			const s = item as Record<string, unknown>;
			if (typeof s.sessionId !== 'string' || typeof s.startedAt !== 'string') {
				continue;
			}
			const rawEvents: unknown = s.events;
			const events: ActivityEvent[] = [];
			if (Array.isArray(rawEvents)) {
				for (const rawEvent of rawEvents) {
					const parsed = parseStoredEvent(rawEvent);
					if (parsed !== null) {
						events.push(parsed);
					}
				}
			}
			sessions.push({
				sessionId: s.sessionId,
				startedAt: s.startedAt,
				endedAt: typeof s.endedAt === 'string' ? s.endedAt : null,
				workspaceId: typeof s.workspaceId === 'string' ? s.workspaceId : 'ws_unknown',
				workspacePath: typeof s.workspacePath === 'string' ? s.workspacePath : undefined,
				primaryLanguage: typeof s.primaryLanguage === 'string' ? s.primaryLanguage : undefined,
				problemId: typeof s.problemId === 'string' ? s.problemId : null,
				events,
			});
		}
		return sessions;
	} catch {
		return [];
	}
}

export function saveSessionsToDisk(sessions: CodingSession[], workspacePath?: string): void {
	const file = getStoragePath(workspacePath);
	const dir = ensureStorageDir(workspacePath);
	const json = sessions.map((s) => ({
		sessionId: s.sessionId,
		startedAt: s.startedAt,
		endedAt: s.endedAt,
		workspaceId: s.workspaceId,
		workspacePath: s.workspacePath,
		primaryLanguage: s.primaryLanguage,
		problemId: s.problemId,
		events: s.events.map((e) => ({
			eventId: e.eventId,
			sessionId: e.sessionId,
			// Phase 1: persist the attempt linkage when present so
			// Activity -> Attempt -> Problem survives reloads.
			...(e.attemptId !== undefined && e.attemptId !== null ? { attemptId: e.attemptId } : {}),
			timestamp: e.timestamp,
			eventType: e.eventType,
			source: e.source,
			schemaVersion: e.schemaVersion,
			payload: e.payload,
		})),
	}));
	fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

export class LocalSessionStore implements SessionStore {
	 constructor(private workspacePath?: string) {
	 }

	 async createSession(session: CodingSession): Promise<void> {
		let sessions = loadSessionsFromDisk(this.workspacePath);
		// Ensure the session doesn't already exist
		sessions = sessions.filter((s) => s.sessionId !== session.sessionId);
		sessions.push(session);
		await saveSessionsToDisk(sessions, this.workspacePath);
	 }

	 async appendEvent(sessionId: string, event: ActivityEvent): Promise<void> {
		let sessions = loadSessionsFromDisk(this.workspacePath);
		const sessionIndex = sessions.findIndex((s) => s.sessionId === sessionId);
		if (sessionIndex === -1) {
			throw new Error(`Session ${sessionId} not found`);
		}
		sessions[sessionIndex].events.push(event);
		updatePrimaryLanguage(sessions[sessionIndex]);
		await saveSessionsToDisk(sessions, this.workspacePath);
	 }

	 async finalizeSession(session: CodingSession): Promise<void> {
		let sessions = loadSessionsFromDisk(this.workspacePath);
		const sessionIndex = sessions.findIndex((s) => s.sessionId === session.sessionId);
		if (sessionIndex === -1) {
			throw new Error(`Session ${session.sessionId} not found`);
		}
		sessions[sessionIndex].endedAt = session.endedAt;
		await saveSessionsToDisk(sessions, this.workspacePath);
	 }

	 async getSession(sessionId: string): Promise<CodingSession | null> {
		const sessions = loadSessionsFromDisk(this.workspacePath);
		const session = sessions.find((s) => s.sessionId === sessionId);
		return session || null;
	 }

	 async listSessionIds(): Promise<string[]> {
		const sessions = loadSessionsFromDisk(this.workspacePath);
		return sessions.map((s) => s.sessionId).sort((a, b) => b.localeCompare(a));
	 }

	 async deleteSession(sessionId: string): Promise<boolean> {
		let sessions = loadSessionsFromDisk(this.workspacePath);
		const initialCount = sessions.length;
		sessions = sessions.filter((s) => s.sessionId !== sessionId);
		if (sessions.length < initialCount) {
			await saveSessionsToDisk(sessions, this.workspacePath);
			return true;
		}
		return false;
	 }
}
