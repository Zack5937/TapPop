import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Connection } from '@solana/web3.js';
import { createRpcFetch } from '../src/rpc';

test('RPC deadline aborts a stalled request and releases the caller', async () => {
  let signal: AbortSignal | null | undefined;
  const transport: typeof fetch = async (_, init) => {
    signal = init?.signal;
    return new Promise(() => {});
  };
  await assert.rejects(createRpcFetch(transport, 20)('https://rpc.example'), /RPC timed out/);
  assert.equal(signal?.aborted, true);
});

test('RPC deadline includes response body consumption, not only headers', async () => {
  let signal: AbortSignal | null | undefined;
  const transport: typeof fetch = async (_, init) => {
    signal = init?.signal;
    const response = new Response('');
    response.text = async () => new Promise(() => {});
    return response;
  };
  await assert.rejects(createRpcFetch(transport, 20)('https://rpc.example'), /pending payment/);
  assert.equal(signal?.aborted, true);
});

test('RPC adapter preserves request, status, headers and response body', async () => {
  const transport: typeof fetch = async (input, init) => {
    assert.equal(input, 'https://rpc.example');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, '{"method":"getGenesisHash"}');
    return new Response('{"result":"devnet"}', { status: 200, headers: { 'x-test': 'retained' } });
  };
  const response = await createRpcFetch(transport)('https://rpc.example', {
    method: 'POST', body: '{"method":"getGenesisHash"}',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-test'), 'retained');
  assert.equal(await response.text(), '{"result":"devnet"}');
});

test('RPC failures are not replaced by empty balances or successful responses', async () => {
  const failure = new Error('Network unavailable');
  const transport: typeof fetch = async () => { throw failure; };
  await assert.rejects(createRpcFetch(transport)('https://rpc.example'), (error) => error === failure);
});

test('HTTP rate limits reach the caller without hidden SDK retries', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return new Response('Rate limited', { status: 429, statusText: 'Too Many Requests' });
  };
  const rpc = new Connection('https://rpc.example', {
    fetch: createRpcFetch(transport), disableRetryOnRateLimit: true,
  });
  await assert.rejects(rpc.getGenesisHash(), /429/);
  assert.equal(calls, 1);
});
