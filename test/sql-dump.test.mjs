import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMysqlValues } from '../lib/sql-dump.mjs';
import { postgresSql } from '../lib/db.mjs';

test('MySQL dump parsing preserves strings, escapes, nulls, and BIGINT precision', () => {
  assert.deepEqual(parseMysqlValues("('0158','O\\'Brien, (test)','it''s',NULL,9007199254740993),('a\\nb','\\\\',0,'',-2);"),
    [['0158', "O'Brien, (test)", "it's", null, '9007199254740993'], ['a\nb', '\\', '0', '', '-2']]);
});
test('unsupported SQL is rejected rather than executed', () => {
  for (const values of ["(1); DROP TABLE bank.kouza_master;", "(SELECT 1);", "('unterminated);", '(1.2);']) {
    assert.throws(() => parseMysqlValues(values));
  }
});
test('Postgres queries keep values parameterized', () => {
  assert.equal(postgresSql('SELECT * FROM bank.kouza_master WHERE account_id IN (?, ?) AND balance>?'),
    'SELECT * FROM bank.kouza_master WHERE account_id IN ($1, $2) AND balance>$3');
});
