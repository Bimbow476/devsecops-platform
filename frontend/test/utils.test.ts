import { test } from 'node:test';
import assert from 'node:assert/strict';
import { average, formatBytes, formatUptime } from '../src/utils';

test('formatBytes конвертує у KB/MB/GB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(Number.NaN), '—');
});

test('formatUptime форматує тривалість', () => {
  assert.equal(formatUptime(45), '45с');
  assert.equal(formatUptime(125), '2хв 5с');
  assert.equal(formatUptime(7000), '1г 56хв 40с');
  assert.equal(formatUptime(90000), '1д 1г 0хв');
  assert.equal(formatUptime(-1), '—');
});

test('average рахує середнє', () => {
  assert.equal(average([]), 0);
  assert.equal(average([1, 2, 3]), 2);
});