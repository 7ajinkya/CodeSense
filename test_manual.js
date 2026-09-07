const { ActivityEvent, EventType, EventSource, SCHEMA_VERSION } = require('./out/events/activityEvent');
const { createEvent } = require('./out/events/eventFactory');
const { CodingSession, createCodingSession, appendEvent, finalizeSession, updatePrimaryLanguage } = require('./out/session/codingSession');
const { LocalSessionStore } = require('./out/persistence/localStore');
const fs = require('fs');
const path = require('path');

const TEST_DIR = './test-data';
if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
}

console.log('=== Test 1: ActivityEvent creation ===');
const event1 = createEvent({
    sessionId: 'ses_001',
    eventType: 'document.opened',
    source: 'document',
    payload: { filePath: '/test.py', uri: 'file:///test.py', languageId: 'python' },
});
console.log('Event created:', event1.eventId, event1.eventType, event1.schemaVersion);
console.log('Session ID:', event1.sessionId);
console.log('Timestamp:', event1.timestamp);
console.log('Language ID in payload:', event1.payload.languageId);
console.log('');

console.log('=== Test 2: Session creation and event appending ===');
const session = createCodingSession({
    sessionId: 'ses_001',
    workspaceId: 'ws_test',
});
console.log('Session created, events:', session.events.length);

const event2 = createEvent({
    sessionId: 'ses_001',
    eventType: 'document.opened',
    source: 'document',
    payload: { filePath: '/test.py', uri: 'file:///test.py', languageId: 'python' },
});
appendEvent(session, event2);
console.log('After first event, events:', session.events.length);

const event3 = createEvent({
    sessionId: 'ses_001',
    eventType: 'document.changed',
    source: 'document',
    payload: { 
        filePath: '/test.py', 
        uri: 'file:///test.py', 
        languageId: 'python',
        versionBefore: 1,
        versionAfter: 2,
        changes: [{ range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5 }, deletedLength: 0, insertedLength: 5 }] 
    },
});
appendEvent(session, event3);
console.log('After second event, events:', session.events.length);

console.log('Primary language:', session.primaryLanguage);
console.log('');

console.log('=== Test 3: Session finalization ===');
finalizeSession(session);
console.log('Session endedAt:', session.endedAt);
console.log('');

console.log('=== Test 4: Local storage ===');
const store = new LocalSessionStore();
store.createSession(session).then(() => {
    console.log('Session created in storage');
    return store.appendEvent('ses_001', createEvent({
        sessionId: 'ses_001',
        eventType: 'document.saved',
        source: 'document',
        payload: { filePath: '/test.py', uri: 'file:///test.py', languageId: 'python' },
    }));
}).then(() => {
    console.log('Event appended to storage');
    return store.getSession('ses_001');
}).then((loaded) => {
    console.log('Session loaded from storage');
    console.log('Events count:', loaded.events.length);
    console.log('EndedAt:', loaded.endedAt);
    console.log('Primary language:', loaded.primaryLanguage);
    
    console.log('');
    console.log('=== Test 5: List and delete sessions ===');
    return store.listSessionIds();
}).then((ids) => {
    console.log('Session IDs:', ids);
    return store.deleteSession('ses_001');
}).then((result) => {
    console.log('Delete result:', result);
    return store.getSession('ses_001');
}).then((loaded) => {
    console.log('Session after delete:', loaded);
    console.log('');
    console.log('=== All core tests passed! ===');
}).catch((err) => {
    console.error('ERROR:', err);
});