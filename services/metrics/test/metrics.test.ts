import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuUsagePercent } from '../src/metrics';
import { parsePort } from '../src/config';

test('cpuUsagePercent рахує відсоток завантаження', () => {
  const pct = cpuUsagePercent({ idle: 800, user: 100, nice: 0, sys: 100, irq: 0 });
  assert.ok(pct > 0);
  assert.ok(pct <= 100);
});

test('cpuUsagePercent: повний простій = 0, нульові лічильники = 0', () => {
  assert.equal(cpuUsagePercent({ idle: 1000, user: 0, nice: 0, sys: 0, irq: 0 }), 0);
  assert.equal(cpuUsagePercent({ idle: 0, user: 0, nice: 0, sys: 0, irq: 0 }), 0);
});

test('parsePort коректно обробляє валідні/невалідні значення', () => {
  assert.equal(parsePort(undefined, 8081), 8081);
  assert.equal(parsePort('abc', 8081), 8081);
  assert.equal(parsePort('0', 8081), 8081);
  assert.equal(parsePort('99999', 8081), 8081);
  assert.equal(parsePort('8181', 8081), 8181);
});