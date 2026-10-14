import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('Flyway preparation preserves SQL bodies and refuses unsupported migrations', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'flyway-preparation-'));
  const script = new URL('../scripts/prepare-flyway.sh', import.meta.url).pathname;
  const source = new URL('../db/migrations', import.meta.url).pathname;
  try {
    execFileSync('bash', [script, source, join(tmp, 'sql')]);
    for (const [version, description] of [['001','baseline'],['002','owner_auth'],['003','runtime_defaults'],['004','delivery_tariffs']]) {
      const original = readFileSync(join(source, `${version}_${description}.sql`), 'utf8');
      const result = readFileSync(join(tmp, 'sql', `V${version}__${description}.sql`), 'utf8');
      assert.equal(result, original.replace(/^BEGIN;$/m, '').replace(/COMMIT;\n$/, '\n'));
    }
    assert.throws(() => execFileSync('bash', [script, source, join(tmp, 'sql')], {stdio:'pipe'}));
    mkdirSync(join(tmp,'invalid'));
    writeFileSync(join(tmp,'invalid','005_bad.sql'), 'CREATE TABLE t(id int);\n');
    assert.throws(() => execFileSync('bash', [script, join(tmp,'invalid'), join(tmp,'bad')], {stdio:'pipe'}));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
