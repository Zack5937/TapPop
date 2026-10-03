import { Connection, type ConnectionConfig } from '@solana/web3.js';
import { config } from './config';

type RpcFetch = NonNullable<ConnectionConfig['fetch']>;

export function createRpcFetch(
  transport: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs: number = config.rpcTimeoutMs,
): RpcFetch {
  // web3.js types its fetch hook with node-fetch; React Native uses the standard
  // fetch/Response globals. This adapter also bounds response body consumption.
  const fetchWithDeadline = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => controller.abort();
    if (init?.signal?.aborted) cancel();
    init?.signal?.addEventListener('abort', cancel);
    const request = async () => {
      const response = await transport(input, { ...init, signal: controller.signal });
      const body = await response.text();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
    try {
      return await Promise.race([
        request(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Solana RPC timed out. Check any pending payment before trying again.'));
            controller.abort();
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      init?.signal?.removeEventListener('abort', cancel);
    }
  };
  return fetchWithDeadline as unknown as RpcFetch;
}

export const connection = new Connection(config.rpcUrl, {
  commitment: 'confirmed',
  fetch: createRpcFetch(),
  disableRetryOnRateLimit: true,
});
