import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createAccount, getAccount, listAccounts, updateAccount, deleteAccount } from '../src/repo/accounts.ts';

test('account CRUD stores only a secret reference', t => {
  const db = temporaryDatabase(t); migrate(db);
  const account = createAccount(db, { label: 'Pro account', secretRef: 'env:FLOW_ACCOUNT' });
  assert.deepEqual(getAccount(db, account.id), account);
  assert.deepEqual(listAccounts(db), [account]);
  assert.equal(updateAccount(db, account.id, { label: 'Ultra account', type: 'Ultra' })?.type, 'Ultra');
  assert.equal(getAccount(db, account.id)?.label, 'Ultra account');
  const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(account.id)!;
  assert.equal(row.secret_ref, 'env:FLOW_ACCOUNT');
  for (const field of ['secret', 'password', 'token', 'cookie', 'apiKey']) {
    assert.equal(field in row, false);
    assert.equal(field in account, false);
    assert.throws(() => createAccount(db, { label: 'Bad', [field]: 'raw-secret' }));
    assert.throws(() => updateAccount(db, account.id, { [field]: 'raw-secret' }));
  }
  assert.equal(listAccounts(db).length, 1);
  assert.equal(deleteAccount(db, account.id), true);
  assert.equal(getAccount(db, account.id), undefined);
  assert.equal(deleteAccount(db, account.id), false);
  assert.equal(updateAccount(db, account.id, { label: 'Missing' }), undefined);
});
