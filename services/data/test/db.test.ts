import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteRecord,
  getRecord,
  insertRecord,
  listRecords,
  openDatabase,
  updateRecord,
} from '../src/db';

function testDb() {
  return openDatabase(':memory:');
}

test('insertRecord створює запис із дефолтними значеннями', () => {
  const db = testDb();
  const record = insertRecord(db, { title: 'Новий запис' });
  assert.ok(record.id > 0);
  assert.equal(record.title, 'Новий запис');
  assert.equal(record.status, 'new');
  assert.equal(record.priority, 3);
  db.close();
});

test('listRecords повертає забражені результати з фільтрами та пошуком', () => {
  const db = testDb();
  insertRecord(db, { title: 'Інфраструктура', status: 'in_progress', priority: 1 });
  insertRecord(db, { title: 'Безпека', status: 'done', priority: 2 });

  const all = listRecords(db);
  assert.equal(all.total, 8); // 6 демо + 2 доданих
  assert.ok(all.items.length >= 8);
  assert.equal(all.items[0].title, 'Безпека'); // ORDER BY id DESC

  const search = listRecords(db, { search: 'безпек' });
  assert.equal(search.total, 1);
  assert.equal(search.items[0].title, 'Безпека');

  const filtered = listRecords(db, { status: 'done' });
  assert.ok(filtered.items.every((r) => r.status === 'done'));
  db.close();
});

test('updateRecord оновлює лише передані поля', () => {
  const db = testDb();
  const created = insertRecord(db, { title: 'Старий заголовок', priority: 4 });
  const updated = updateRecord(db, created.id, { title: 'Новий заголовок' });
  assert.ok(updated);
  assert.equal(updated.title, 'Новий заголовок');
  assert.equal(updated.priority, 4);
  assert.notEqual(updated.updated_at, updated.created_at);
  db.close();
});

test('deleteRecord видаляє запис, getRecord повертає null після видалення', () => {
  const db = testDb();
  const created = insertRecord(db, { title: 'Видалити мене' });
  assert.ok(getRecord(db, created.id));
  assert.equal(deleteRecord(db, created.id), true);
  assert.equal(getRecord(db, created.id), null);
  assert.equal(deleteRecord(db, created.id), false);
  db.close();
});

test('updateRecord на неіснуючому id повертає null', () => {
  const db = testDb();
  assert.equal(updateRecord(db, 999999, { title: 'x' }), null);
  db.close();
});