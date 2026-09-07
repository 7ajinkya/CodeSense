import { expect } from 'chai';
import {
  buildContentChanges,
  countInsertedLines,
} from 'codesense/capture/documentChanges';

const CHANGE = {
  range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 },
  rangeLength: 1,
  text: 'x',
};

describe('insertedText privacy boundary', () => {
  it('records exact inserted text while an attempt is active', () => {
    const [change] = buildContentChanges([CHANGE], true);
    expect(change.insertedText).to.equal('x');
    expect(change.insertedLength).to.equal(1);
    expect(change.deletedLength).to.equal(1);
  });

  it('omits exact text without an attempt but keeps the structural event', () => {
    const [change] = buildContentChanges([CHANGE], false);
    expect('insertedText' in change).to.be.false;
    expect(change.insertedLength).to.equal(1);
    expect(change.deletedLength).to.equal(1);
    expect(change.insertedLineCount).to.equal(0);
    expect(change.range).to.deep.equal(CHANGE.range);
  });

  it('preserves every change of a multi-change event in both modes', () => {
    const changes = [
      CHANGE,
      {
        range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 0 },
        rangeLength: 0,
        text: 'yz\n',
      },
    ];
    expect(buildContentChanges(changes, true).length).to.equal(2);
    const without = buildContentChanges(changes, false);
    expect(without.length).to.equal(2);
    expect(without.every((c) => !('insertedText' in c))).to.be.true;
    expect(without[1].insertedLength).to.equal(3);
  });

  it('counts inserted lines', () => {
    expect(countInsertedLines('')).to.equal(0);
    expect(countInsertedLines('x')).to.equal(0);
    expect(countInsertedLines('x\ny\n')).to.equal(2);
  });
});
