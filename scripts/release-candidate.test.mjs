import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createCandidateInventory,
  verifyCandidateInventory,
  writeCandidateInventory,
} from './release-candidate.mjs';

const PACKAGE_NAME = '@bota.dev/react-native-sdk';
const VERSION = '0.0.66';
const SOURCE_REVISION = 'a'.repeat(40);

function writePackageJson(path, { name = PACKAGE_NAME, version = VERSION } = {}) {
  writeFileSync(path, `${JSON.stringify({ name, version }, null, 2)}\n`);
}

function makeFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bota-release-candidate-'));
  const packageDirectory = join(root, 'package');
  const packageJsonPath = join(root, 'package.json');
  const tarballPath = join(root, `bota.dev-react-native-sdk-${VERSION}.tgz`);
  const inventoryPath = join(root, 'release-candidate.json');

  mkdirSync(packageDirectory);
  writePackageJson(packageJsonPath, options.rootPackage);
  writePackageJson(join(packageDirectory, 'package.json'), options.packedPackage);
  writeFileSync(join(packageDirectory, 'index.js'), 'export const fixture = true;\n');
  execFileSync('tar', ['-czf', tarballPath, '-C', root, 'package']);

  return { inventoryPath, packageJsonPath, root, tarballPath };
}

test('creates and verifies a deterministic legacy release candidate inventory', () => {
  const fixture = makeFixture();
  const firstPath = join(fixture.root, 'first.json');
  const secondPath = join(fixture.root, 'second.json');
  const options = {
    packageJsonPath: fixture.packageJsonPath,
    sourceRevision: SOURCE_REVISION,
    tag: `v${VERSION}`,
    tarballPath: fixture.tarballPath,
  };

  writeCandidateInventory({ ...options, outputPath: firstPath });
  writeCandidateInventory({ ...options, outputPath: secondPath });

  assert.equal(readFileSync(firstPath, 'utf8'), readFileSync(secondPath, 'utf8'));
  assert.deepEqual(verifyCandidateInventory({
    inventoryPath: firstPath,
    tarballPath: fixture.tarballPath,
  }), createCandidateInventory(options));
});

test('rejects non-legacy versions and tags that do not match exactly', () => {
  const stable = makeFixture({
    rootPackage: { version: '1.2.0-beta.0' },
    packedPackage: { version: '1.2.0-beta.0' },
  });
  assert.throws(() => createCandidateInventory({
    packageJsonPath: stable.packageJsonPath,
    sourceRevision: SOURCE_REVISION,
    tag: 'v1.2.0-beta.0',
    tarballPath: stable.tarballPath,
  }), /legacy 0\.0\.x/);

  const fixture = makeFixture();
  assert.throws(() => createCandidateInventory({
    packageJsonPath: fixture.packageJsonPath,
    sourceRevision: SOURCE_REVISION,
    tag: 'v0.0.67',
    tarballPath: fixture.tarballPath,
  }), /must equal v0\.0\.66/);
});

test('rejects package-name drift between source and packed metadata', () => {
  const wrongRoot = makeFixture({ rootPackage: { name: '@example/sdk' } });
  assert.throws(() => createCandidateInventory({
    packageJsonPath: wrongRoot.packageJsonPath,
    sourceRevision: SOURCE_REVISION,
    tag: `v${VERSION}`,
    tarballPath: wrongRoot.tarballPath,
  }), /source package name/);

  const wrongTarball = makeFixture({ packedPackage: { name: '@example/sdk' } });
  assert.throws(() => createCandidateInventory({
    packageJsonPath: wrongTarball.packageJsonPath,
    sourceRevision: SOURCE_REVISION,
    tag: `v${VERSION}`,
    tarballPath: wrongTarball.tarballPath,
  }), /packed package name/);
});

test('detects a tarball changed after the inventory was written', () => {
  const fixture = makeFixture();
  writeCandidateInventory({
    outputPath: fixture.inventoryPath,
    packageJsonPath: fixture.packageJsonPath,
    sourceRevision: SOURCE_REVISION,
    tag: `v${VERSION}`,
    tarballPath: fixture.tarballPath,
  });
  writeFileSync(fixture.tarballPath, Buffer.concat([
    readFileSync(fixture.tarballPath),
    Buffer.from('tampered'),
  ]));

  assert.throws(() => verifyCandidateInventory({
    inventoryPath: fixture.inventoryPath,
    tarballPath: fixture.tarballPath,
  }), /tarball (byte length|SHA-1|SHA-256)/);
});

test('rejects an unsupported candidate inventory schema', () => {
  const fixture = makeFixture();
  writeCandidateInventory({
    outputPath: fixture.inventoryPath,
    packageJsonPath: fixture.packageJsonPath,
    sourceRevision: SOURCE_REVISION,
    tag: `v${VERSION}`,
    tarballPath: fixture.tarballPath,
  });
  const inventory = JSON.parse(readFileSync(fixture.inventoryPath, 'utf8'));
  inventory.schemaVersion = 999;
  writeFileSync(fixture.inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  assert.throws(() => verifyCandidateInventory({
    inventoryPath: fixture.inventoryPath,
    tarballPath: fixture.tarballPath,
  }), /schema version must be 1/);
});
