import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PendingPayment, Settlement } from '../src/payments';
import { watchSettlement } from '../src/settlementWatch';

// The watcher treats payment details as opaque; chain validation belongs to query.
const payment = { signature: 'the-existing-payment' } as PendingPayment;
function deferred() {
  let resolve!: (value: Settlement) => void;
  const promise = new Promise<Settlement>((done) => { resolve = done; });
  return { promise, resolve };
}

test('recovery checks immediately, coalesces foreground queries and stops at confirmation', async () => {
  const response = deferred();
  let calls = 0;
  const results: Settlement[] = [];
  const watcher = watchSettlement(payment, (value) => results.push(value), (error) => assert.fail(String(error)), async (saved) => {
    assert.equal(saved, payment);
    calls++;
    return response.promise;
  });
  try {
    assert.equal(calls, 1);
    await watcher.checkNow();
    await watcher.checkNow();
    assert.equal(calls, 1);
    response.resolve('confirmed');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(results, ['confirmed']);
    await watcher.checkNow();
    assert.equal(calls, 1);
  } finally { watcher.stop(); }
});

test('RPC outage reports an error and a later refresh checks the same saved signature', async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const results: Settlement[] = [];
  const watcher = watchSettlement(payment, (value) => results.push(value), (error) => errors.push(error), async (saved) => {
    assert.equal(saved.signature, payment.signature);
    if (++calls === 1) throw new Error('offline');
    return 'pending';
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
    assert.deepEqual(results, []);
    await watcher.checkNow();
    assert.equal(calls, 2);
    assert.deepEqual(results, ['pending']);
  } finally { watcher.stop(); }
});

test('cleanup ignores an in-flight response and prevents future requests', async () => {
  const response = deferred();
  let calls = 0;
  const results: Settlement[] = [];
  const watcher = watchSettlement(payment, (value) => results.push(value), (error) => assert.fail(String(error)), async () => {
    calls++;
    return response.promise;
  });
  watcher.stop();
  response.resolve('confirmed');
  await new Promise((resolve) => setImmediate(resolve));
  await watcher.checkNow();
  assert.equal(calls, 1);
  assert.deepEqual(results, []);
});
