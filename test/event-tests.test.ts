import { expect } from 'chai';
import { ActivityEvent, SCHEMA_VERSION } from 'codesense/events/activityEvent';
import { createEvent } from 'codesense/events/eventFactory';
import { createCodingSession, appendEvent, finalizeSession } from 'codesense/session/codingSession';
import { LocalSessionStore } from 'codesense/persistence/localStore';
import { identifyLanguage, isSupportedLanguage } from 'codesense/util/languages';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_STORAGE = path.join(os.tmpdir(), 'codesense-test-store');

beforeEach(() => {
	if (fs.existsSync(TEST_STORAGE)) {
		fs.rmSync(TEST_STORAGE, { recursive: true });
	}
});

afterEach(() => {
	if (fs.existsSync(TEST_STORAGE)) {
		fs.rmSync(TEST_STORAGE, { recursive: true });
	}
});

function testStore(): LocalSessionStore {
	return new LocalSessionStore(TEST_STORAGE);
}

describe('ActivityEvent', () => {
	it('has required fields', () => {
		const event: ActivityEvent = {
			eventId: 'evt_test',
			sessionId: 'ses_test',
			timestamp: new Date().toISOString(),
			eventType: 'document.opened',
			source: 'document',
			schemaVersion: SCHEMA_VERSION,
			payload: {},
		};
		expect(event.eventId).to.exist;
		expect(event.sessionId).to.exist;
		expect(event.timestamp).to.exist;
		expect(event.eventType).to.exist;
		expect(event.source).to.exist;
		expect(event.schemaVersion).to.exist;
		expect(event.payload).to.exist;
	});

	it('has stable schemaVersion', () => {
		const event: ActivityEvent = {
			eventId: 'evt_ver',
			sessionId: 'ses_ver',
			timestamp: new Date().toISOString(),
			eventType: 'document.opened',
			source: 'document',
			schemaVersion: SCHEMA_VERSION,
			payload: {},
		};
		expect(event.schemaVersion).to.equal(1);
	});
});

describe('EventFactory', () => {
	it('creates event with generated ID', () => {
		const event = createEvent({
			sessionId: 'ses_test',
			eventType: 'document.opened',
			source: 'document',
			payload: { filePath: '/test.py', uri: 'file:///test.py', languageId: 'python' },
		});
		expect(event.eventId).to.match(/^evt_/);
		expect(event.sessionId).to.equal('ses_test');
		expect(event.eventType).to.equal('document.opened');
		expect(event.source).to.equal('document');
		expect(event.schemaVersion).to.equal(1);
	});

	it('uses provided timestamp', () => {
		const event = createEvent({
			sessionId: 'ses_test',
			eventType: 'document.opened',
			source: 'document',
			payload: {},
			timestamp: '2024-01-01T00:00:00.000Z',
		});
		expect(event.timestamp).to.equal('2024-01-01T00:00:00.000Z');
	});

	it('parses event from serialized form', () => {
		const parsed = createEvent({
			sessionId: 'ses_123',
			eventType: 'document.opened',
			source: 'document',
			payload: { filePath: '/test.py', uri: 'file:///test.py', languageId: 'python' },
			eventId: 'evt_123',
			timestamp: '2024-01-01T00:00:00.000Z',
		});
		expect(parsed).to.not.be.null;
		expect(parsed!.eventId).to.equal('evt_123');
	});
});

describe('CodingSession', () => {
	it('creates a new session', () => {
		const session = createCodingSession({
			sessionId: 'ses_001',
			workspaceId: 'ws_test',
		});
		expect(session.sessionId).to.equal('ses_001');
		expect(session.startedAt).to.exist;
		expect(session.endedAt).to.be.null;
		expect(session.events).to.be.empty;
		expect(session.workspaceId).to.equal('ws_test');
	});

	it('appends events to session', () => {
		const session = createCodingSession({ sessionId: 'ses_001', workspaceId: 'ws_test' });
		const event = createEvent({
			sessionId: 'ses_001',
			eventType: 'document.opened',
			source: 'document',
			payload: { filePath: '/test.py', uri: 'file:///test.py', languageId: 'python' },
		});
		appendEvent(session, event);
		expect(session.events.length).to.equal(1);
		expect(session.events[0].eventId).to.exist;
	});

	it('updates primary language based on events', () => {
		const session = createCodingSession({ sessionId: 'ses_001', workspaceId: 'ws_test' });
		appendEvent(session, createEvent({
			sessionId: 'ses_001',
			eventType: 'document.opened',
			source: 'document',
			payload: { filePath: '/test.py', uri: 'file:///test.py', languageId: 'python' },
		}));
		appendEvent(session, createEvent({
			sessionId: 'ses_001',
			eventType: 'document.opened',
			source: 'document',
			payload: { filePath: '/test2.py', uri: 'file:///test2.py', languageId: 'python' },
		}));
		appendEvent(session, createEvent({
			sessionId: 'ses_001',
			eventType: 'document.opened',
			source: 'document',
			payload: { filePath: '/test.java', uri: 'file:///test.java', languageId: 'java' },
		}));
		expect(session.primaryLanguage).to.equal('python');
	});

	it('finalizes a session', () => {
		const session = createCodingSession({ sessionId: 'ses_001', workspaceId: 'ws_test' });
		appendEvent(session, createEvent({
			sessionId: 'ses_001',
			eventType: 'document.opened',
			source: 'document',
			payload: { filePath: '/test.py', uri: 'file:///test.py', languageId: 'python' },
		}));
		finalizeSession(session);
		expect(session.endedAt).to.exist;
	});

	it('does not require a problemId', () => {
		const session = createCodingSession({ sessionId: 'ses_001', workspaceId: 'ws_test' });
		expect(session.problemId).to.be.null;
	});
});

describe('LocalSessionStore', () => {
	it('creates and appends events to a session', async () => {
		const store = testStore();
		const session = createCodingSession({ sessionId: 'ses_001', workspaceId: 'ws_test' });
		await store.createSession(session);

		const event = createEvent({
			sessionId: 'ses_001',
			eventType: 'document.opened',
			source: 'document',
			payload: { filePath: '/test.py', uri: 'file:///test.py', languageId: 'python' },
		});
		await store.appendEvent('ses_001', event);

		const loaded = await store.getSession('ses_001');
		expect(loaded).to.not.be.null;
		expect(loaded!.events.length).to.equal(1);
	});

	it('finalizes a session', async () => {
		const store = testStore();
		const session = createCodingSession({ sessionId: 'ses_001', workspaceId: 'ws_test' });
		await store.createSession(session);

		// First finalize the session object (sets endedAt)
		finalizeSession(session);
		await store.finalizeSession(session);

		const loaded = await store.getSession('ses_001');
		expect(loaded!.endedAt).to.exist;
	});

	it('lists session ids', async () => {
		const store = testStore();
		await store.createSession(createCodingSession({ sessionId: 'ses_001', workspaceId: 'ws_test' }));
		await store.createSession(createCodingSession({ sessionId: 'ses_002', workspaceId: 'ws_test' }));

		const ids = await store.listSessionIds();
		expect(ids).to.include('ses_001');
		expect(ids).to.include('ses_002');
	});

	it('deletes a session', async () => {
		const store = testStore();
		await store.createSession(createCodingSession({ sessionId: 'ses_001', workspaceId: 'ws_test' }));
		const result = await store.deleteSession('ses_001');
		expect(result).to.be.true;

		const loaded = await store.getSession('ses_001');
		expect(loaded).to.be.null;
	});

	it('returns false for deleting non-existent session', async () => {
		const store = testStore();
		const result = await store.deleteSession('nonexistent');
		expect(result).to.be.false;
	});
});

describe('Language identification', () => {
	it('identifies Python', () => {
		const info = identifyLanguage('python');
		expect(info?.languageId).to.equal('python');
		expect(info?.name).to.equal('Python');
	});

	it('identifies Java', () => {
		const info = identifyLanguage('java');
		expect(info?.languageId).to.equal('java');
		expect(info?.name).to.equal('Java');
	});

	it('returns undefined for unknown language', () => {
		const info = identifyLanguage('javascript');
		expect(info).to.be.undefined;
	});

	it('checks supported language', () => {
		expect(isSupportedLanguage('python')).to.be.true;
		expect(isSupportedLanguage('java')).to.be.true;
		expect(isSupportedLanguage('javascript')).to.be.false;
	});
});

describe('Event deserialization tolerance', () => {
	it('tolerates unknown optional fields', () => {
		const parsed = createEvent({
			sessionId: 'ses_tol',
			eventType: 'document.opened',
			source: 'document',
			payload: { unknownField: 'should be ignored' },
		});
		expect(parsed).to.not.be.null;
	});
});
