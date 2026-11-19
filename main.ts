// main.ts — entrypoint for the github-core-clone-01 forge.
//
// This file only owns the trial lifecycle. Everything the suite grades
// (git smart HTTP, the REST v3 API, GraphQL, MCP, the object store)
// lives in app.ts; main.ts just gets the forge registered and waits.
//
// Handshake, in order:
//   1. Read MAKEFUN_ENV_URL, the suite env's origin (http://store:8080 in
//      a trial). Without it there is nothing to register with: exit 1.
//   2. Start the forge on an ephemeral port — listen(0) picks one, and it
//      is never 8080 because the env owns that — then POST {"port": N} to
//      $ENV_URL/register. A 200 registers us; a 409 means another process
//      already won the race, which is equally fine. A 400 or 405 is a
//      contract error and aborts; anything else retries forever with
//      exponential backoff.
//   3. Poll GET $ENV_URL/done until it reports {"done": true}, then close
//      the server and exit 0.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;
const RETRY_MAX_SHIFT = 8;

if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set, nothing to register with\n');
  process.exit(1);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function backoff(attempt: number): number {
  const shift = Math.min(attempt, RETRY_MAX_SHIFT);
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** shift);
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register contract error HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register contract error')) {
        throw err;
      }
    }
    await sleep(backoff(attempt));
  }
}

async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok && ((await response.json()) as { done?: unknown }).done === true) return;
    } catch {
      // The env is not answering yet; keep polling.
    }
    await sleep(backoff(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind a TCP port');
  }
  process.stdout.write(`[forge] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[forge] registered, waiting for done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[forge] ${message}\n`);
  process.exit(1);
}
