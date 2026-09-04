import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { syncEncryptedUploadV2Vectors } from './sync-encrypted-upload-v2-vectors.mjs';

const SOURCE_PATH = 'protocol/vectors/encrypted-upload-v2.json';
const CONTRACT_REVISION = 'encrypted-upload-v2-contract-v1';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'bota-encrypted-upload-v2-sync-'));
  const appSdkPath = join(root, 'app-sdk');
  const destinationDirectory = join(root, 'vendor');
  const sourcePath = join(appSdkPath, SOURCE_PATH);
  const sourceBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    contractRevision: CONTRACT_REVISION,
    cases: [],
  }, null, 2)}\n`);

  mkdirSync(join(appSdkPath, 'protocol', 'vectors'), { recursive: true });
  writeFileSync(sourcePath, sourceBytes);
  execFileSync('git', ['init', '-q'], { cwd: appSdkPath });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: appSdkPath });
  execFileSync('git', ['config', 'user.name', 'Encrypted Upload v2 Test'], { cwd: appSdkPath });
  execFileSync('git', ['add', SOURCE_PATH], { cwd: appSdkPath });
  execFileSync('git', ['commit', '-qm', 'add vector'], { cwd: appSdkPath });
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: appSdkPath,
    encoding: 'utf8',
  }).trim();

  return { appSdkPath, destinationDirectory, root, sourceBytes, sourcePath, sourceRevision };
}

test('vendors committed canonical bytes with exact source metadata', (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  writeFileSync(fixture.sourcePath, '{"uncommitted":true}\n');
  syncEncryptedUploadV2Vectors({
    appSdkPath: fixture.appSdkPath,
    destinationDirectory: fixture.destinationDirectory,
    sourceRevision: fixture.sourceRevision,
  });

  const vectorPath = join(fixture.destinationDirectory, 'encrypted-upload-v2.json');
  const sourceMetadataPath = join(
    fixture.destinationDirectory,
    'encrypted-upload-v2.source.json'
  );
  assert.deepEqual(readFileSync(vectorPath), fixture.sourceBytes);
  assert.deepEqual(JSON.parse(readFileSync(sourceMetadataPath, 'utf8')), {
    sourceRepository: 'bota-dev/app-sdk',
    sourcePath: SOURCE_PATH,
    sourceRevision: fixture.sourceRevision,
    sha256: '7ea8391f3b75ec9cf2b32c9ca9f197e27c942e731d8b3a576b847de541e3f64a',
  });

  assert.doesNotThrow(() => syncEncryptedUploadV2Vectors({
    check: true,
    destinationDirectory: fixture.destinationDirectory,
  }));

  writeFileSync(vectorPath, Buffer.concat([readFileSync(vectorPath), Buffer.from(' ')]));
  assert.throws(() => syncEncryptedUploadV2Vectors({
    check: true,
    destinationDirectory: fixture.destinationDirectory,
  }), /vendored vector bytes do not match/i);
});

test('check mode compares recorded bytes with git when a source is supplied', (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  syncEncryptedUploadV2Vectors({
    appSdkPath: fixture.appSdkPath,
    destinationDirectory: fixture.destinationDirectory,
    sourceRevision: fixture.sourceRevision,
  });

  assert.doesNotThrow(() => syncEncryptedUploadV2Vectors({
    appSdkPath: fixture.appSdkPath,
    check: true,
    destinationDirectory: fixture.destinationDirectory,
    sourceRevision: fixture.sourceRevision,
  }));
});
