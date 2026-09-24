import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkService, normalizeHealth, type Fetcher } from '../src/status';
import { parsePort } from '../src/config';

function stubFetch(result: {
  ok: boolean;
  status: number;
  body: unknown;
  throws?: boolean;
}): Fetcher {
  return async () => {
    if (result.throws) throw new Error('network unreachable');
    return {
      ok: result.ok,
      status: result.status,
      json: async () => result.body,
    };
  };
}

test('checkService повертає ok з версією для живого сервісу', async () => {
  const status = await checkService(
    { name: 'metrics', url: 'http://metrics:8081' },
    { fetcher: stubFetch({ ok: true, status: 200, body: { status: 'ok', version: '1.2.3' } }) },
  );
  assert.equal(status.status, 'ok');
  assert.equal(status.healthy, true);
  assert.equal(status.version, '1.2.3');
  assert.equal(status.error, null);
  assert.ok(typeof status.latencyMs === 'number');
});

test('checkService позначає недоступний сервіс', async () => {
  const status = await checkService(
    { name: 'data', url: 'http://data:8082' },
    { fetcher: stubFetch({ ok: false, status: 503, body: {} }) },
  );
  assert.equal(status.status, 'down');
  assert.equal(status.healthy, false);
  assert.ok(status.error?.includes('503'));
});

test('checkService обробляє помилку мережі', async () => {
  const status = await checkService(
    { name: 'metrics', url: 'http://metrics:8081' },
    { fetcher: stubFetch({ ok: true, status: 200, body: {}, throws: true }) },
  );
  assert.equal(status.status, 'down');
  assert.equal(status.healthy, false);
  assert.ok(status.error);
});

test('normalizeHealth працює з довільним вхідним обʼєктом', () => {
  assert.deepEqual(normalizeHealth({ status: 'ok', version: '0.1.0' }), {
    status: 'ok',
    version: '0.1.0',
  });
  assert.deepEqual(normalizeHealth(null), {});
  assert.deepEqual(normalizeHealth('junk'), {});
});

test('parsePort коректно обробляє валідні/невалідні значення', () => {
  assert.equal(parsePort(undefined, 8080), 8080);
  assert.equal(parsePort('abc', 8080), 8080);
  assert.equal(parsePort('0', 8080), 8080);
  assert.equal(parsePort('70000', 8080), 8080);
  assert.equal(parsePort('9090', 8080), 9090);
});