'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collect, satisfies, check } = require('./license-check.cjs');

const policy = { allowed: ['MIT', 'ISC', 'Apache-2.0'], denied: ['BUSL-1.1', 'UNKNOWN'] };
const dep = (license, dev = false, version = '1.0.0') =>
  ({ licenses: new Set([license]), versions: new Set([version]), dev });

test('SPDX OR needs one allowed id, AND needs all', () => {
  const ok = (id) => policy.allowed.includes(id);
  assert.ok(satisfies('(MIT OR GPL-2.0-only)', ok));
  assert.ok(!satisfies('MIT AND GPL-2.0-only', ok));
});

test('shipped code must use an allowed license', () => {
  const { violations } = check({ a: dep('MIT'), b: dep('AGPL-3.0-only') }, policy, null);
  assert.deepStrictEqual(violations, ['b@1.0.0: AGPL-3.0-only is not allowed in shipped code']);
});

test('dev-only code is only blocked by the deny list', () => {
  const { violations } = check({ a: dep('AGPL-3.0-only', true), b: dep('BUSL-1.1', true) }, policy, null);
  assert.deepStrictEqual(violations, ['b@1.0.0: BUSL-1.1 is denied']);
});

test('a license change in a new version is flagged', () => {
  const { changes } = check({ a: dep('BUSL-1.1', true, '2.0.0') }, policy, { a: 'MIT' });
  assert.deepStrictEqual(changes, ['a@2.0.0: license changed MIT -> BUSL-1.1']);
});

test('collect reads the installed package.json when the lockfile has no license', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'license-check-'));
  try {
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {
      '': { name: 'root' },
      'node_modules/@scope/a': { version: '1.0.0', license: 'MIT' },
      'node_modules/b': { version: '2.0.0', dev: true },
      'node_modules/c': { version: '3.0.0' },
    } }));
    fs.mkdirSync(path.join(root, 'node_modules/b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/b/package.json'), JSON.stringify({ license: 'ISC' }));
    const deps = collect(root);
    assert.deepStrictEqual([...deps['@scope/a'].licenses], ['MIT']);
    assert.deepStrictEqual([...deps.b.licenses], ['ISC']);
    assert.strictEqual(deps.b.dev, true);
    assert.deepStrictEqual([...deps.c.licenses], ['UNKNOWN']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
