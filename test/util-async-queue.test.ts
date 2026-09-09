import { expect } from 'chai';
import { createAsyncQueue } from 'codesense/util/asyncQueue';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AsyncQueue (serial background chains)', () => {
  it('runs tasks in enqueue order, each after the previous settles', async () => {
    const queue = createAsyncQueue();
    const started: string[] = [];
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const results = [
      queue.enqueue(async () => {
        started.push('a');
        return gates[0]?.promise as Promise<string>;
      }),
      queue.enqueue(async () => {
        started.push('b');
        return gates[1]?.promise as Promise<string>;
      }),
      queue.enqueue(async () => {
        started.push('c');
        return gates[2]?.promise as Promise<string>;
      }),
    ];
    await Promise.resolve();
    await Promise.resolve();
    // Only the first task may have started; the rest queue behind it.
    expect(started).to.deep.equal(['a']);
    gates[0]?.resolve('A');
    expect(await results[0]).to.equal('A');
    await Promise.resolve();
    await Promise.resolve();
    expect(started).to.deep.equal(['a', 'b']);
    gates[1]?.resolve('B');
    expect(await results[1]).to.equal('B');
    gates[2]?.resolve('C');
    expect(await results[2]).to.equal('C');
    expect(started).to.deep.equal(['a', 'b', 'c']);
  });

  it('isolates rejections: one failure never breaks the tail', async () => {
    const queue = createAsyncQueue();
    const first = queue.enqueue(async () => {
      throw new Error('boom');
    });
    const second = queue.enqueue(async () => 'fine');
    let threw = false;
    try {
      await first;
    } catch (err) {
      threw = true;
      expect((err as Error).message).to.equal('boom');
    }
    expect(threw, 'caller still observes its own rejection').to.be.true;
    expect(await second).to.equal('fine');
    // The queue remains usable afterwards.
    expect(await queue.enqueue(async () => 42)).to.equal(42);
  });

  it('passes return values through untouched', async () => {
    const queue = createAsyncQueue();
    expect(await queue.enqueue(async () => ({ ok: true as const }))).to.deep.equal({ ok: true });
  });

  it('serializes a burst of concurrent enqueues (max concurrency 1)', async () => {
    const queue = createAsyncQueue();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const burst = [0, 1, 2, 3, 4].map((n) =>
      queue.enqueue(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        order.push(n);
        active -= 1;
        return n;
      }),
    );
    expect(await Promise.all(burst)).to.deep.equal([0, 1, 2, 3, 4]);
    expect(maxActive).to.equal(1);
    expect(order).to.deep.equal([0, 1, 2, 3, 4]);
  });
});
