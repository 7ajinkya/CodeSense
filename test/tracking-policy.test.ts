import { expect } from 'chai';
import {
  ActiveDocumentTracker,
  shouldObserveDocument,
} from 'codesense/capture/trackingPolicy';

const PY_URI = 'file:///workspace/solution.py';
const JAVA_URI = 'file:///workspace/Solution.java';
const MD_URI = 'file:///workspace/README.md';

describe('Document tracking policy', () => {
  it('tracks an active Python document', () => {
    expect(
      shouldObserveDocument({ sessionActive: true, languageId: 'python', isActiveDocument: true }),
    ).to.be.true;
  });

  it('tracks an active Java document', () => {
    expect(
      shouldObserveDocument({ sessionActive: true, languageId: 'java', isActiveDocument: true }),
    ).to.be.true;
  });

  it('does not track unsupported languages', () => {
    for (const languageId of ['json', 'markdown', 'plaintext', 'typescript', 'cpp']) {
      expect(
        shouldObserveDocument({ sessionActive: true, languageId, isActiveDocument: true }),
        languageId,
      ).to.be.false;
    }
  });

  it('does not observe inactive Python/Java documents', () => {
    for (const languageId of ['python', 'java']) {
      expect(
        shouldObserveDocument({ sessionActive: true, languageId, isActiveDocument: false }),
        languageId,
      ).to.be.false;
    }
  });

  it('does not observe anything without an active session', () => {
    expect(
      shouldObserveDocument({ sessionActive: false, languageId: 'python', isActiveDocument: true }),
    ).to.be.false;
  });

  it('stops document observation when switching to an unsupported document', () => {
    const tracker = new ActiveDocumentTracker();
    expect(tracker.updateActiveDocument(PY_URI, 'python', true)).to.be.true;
    expect(tracker.isTracked(PY_URI)).to.be.true;

    // Learner switches to README.md: session continues, observation stops.
    expect(tracker.updateActiveDocument(MD_URI, 'markdown', true)).to.be.false;
    expect(tracker.isTracked(PY_URI)).to.be.false;
    expect(tracker.isTracked(MD_URI)).to.be.false;
    expect(tracker.tracked).to.be.null;
  });

  it('resumes document observation when switching back to Python/Java', () => {
    const tracker = new ActiveDocumentTracker();
    tracker.updateActiveDocument(PY_URI, 'python', true);
    tracker.updateActiveDocument(MD_URI, 'markdown', true);
    expect(tracker.tracked).to.be.null;

    expect(tracker.updateActiveDocument(JAVA_URI, 'java', true)).to.be.true;
    expect(tracker.isTracked(JAVA_URI)).to.be.true;
    expect(tracker.tracked).to.deep.equal({ uri: JAVA_URI, languageId: 'java' });
  });

  it('records close only for the tracked document', () => {
    const tracker = new ActiveDocumentTracker();
    tracker.updateActiveDocument(PY_URI, 'python', true);

    // Closing an untracked file is not observed.
    expect(tracker.consumeIfTracked(MD_URI)).to.be.false;
    expect(tracker.isTracked(PY_URI)).to.be.true;

    // Closing the tracked file is observed exactly once.
    expect(tracker.consumeIfTracked(PY_URI)).to.be.true;
    expect(tracker.consumeIfTracked(PY_URI)).to.be.false;
  });

  it('clears tracking when the session ends but keeps the decision pure', () => {
    const tracker = new ActiveDocumentTracker();
    tracker.updateActiveDocument(PY_URI, 'python', true);
    tracker.reset();
    expect(tracker.tracked).to.be.null;
    expect(tracker.isTracked(PY_URI)).to.be.false;
    // A new session may track the same document again.
    expect(tracker.updateActiveDocument(PY_URI, 'python', true)).to.be.true;
  });
});
