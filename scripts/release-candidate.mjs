#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_NAME = '@bota.dev/react-native-sdk';
const LEGACY_VERSION = /^0\.0\.\d+$/;
const SOURCE_REVISION = /^[0-9a-f]{40}$/;
const INVENTORY_KEYS = ['packageName', 'schemaVersion', 'sourceRevision', 'tag', 'tarball', 'version'];
const TARBALL_KEYS = ['byteLength', 'fileName', 'sha1', 'sha256'];

function assertObjectKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields must be exactly ${expected.join(', ')}`);
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read ${label} at ${path}: ${error.message}`);
  }
}

function readPackedPackageJson(tarballPath) {
  let contents;
  try {
    contents = execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`Failed to read package/package.json from ${tarballPath}: ${error.stderr?.trim() || error.message}`);
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Packed package.json is invalid JSON: ${error.message}`);
  }
}

function digest(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest('hex');
}

function validateReleaseMetadata({ packageName, version, tag, sourceRevision }, source) {
  if (packageName !== PACKAGE_NAME) {
    throw new Error(`${source} package name must be ${PACKAGE_NAME}; got ${packageName}`);
  }
  if (typeof version !== 'string' || !LEGACY_VERSION.test(version)) {
    throw new Error(`${source} version must be a legacy 0.0.x version; got ${version}`);
  }
  if (tag !== `v${version}`) {
    throw new Error(`tag must equal v${version}; got ${tag}`);
  }
  if (typeof sourceRevision !== 'string' || !SOURCE_REVISION.test(sourceRevision)) {
    throw new Error('source revision must be a lowercase 40-character Git object ID');
  }
}

export function createCandidateInventory({
  packageJsonPath,
  sourceRevision,
  tag,
  tarballPath,
}) {
  const sourcePackage = readJson(packageJsonPath, 'source package.json');
  validateReleaseMetadata({
    packageName: sourcePackage.name,
    sourceRevision,
    tag,
    version: sourcePackage.version,
  }, 'source');

  const packedPackage = readPackedPackageJson(tarballPath);
  if (packedPackage.name !== PACKAGE_NAME) {
    throw new Error(`packed package name must be ${PACKAGE_NAME}; got ${packedPackage.name}`);
  }
  if (packedPackage.version !== sourcePackage.version) {
    throw new Error(`packed package version must equal ${sourcePackage.version}; got ${packedPackage.version}`);
  }

  const bytes = readFileSync(tarballPath);
  return {
    schemaVersion: 1,
    packageName: PACKAGE_NAME,
    version: sourcePackage.version,
    tag,
    sourceRevision,
    tarball: {
      fileName: basename(tarballPath),
      byteLength: bytes.byteLength,
      sha1: digest(bytes, 'sha1'),
      sha256: digest(bytes, 'sha256'),
    },
  };
}

export function writeCandidateInventory({ outputPath, ...options }) {
  const inventory = createCandidateInventory(options);
  const destination = resolve(outputPath);
  const temporary = `${destination}.${process.pid}.tmp`;
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, destination);
  return inventory;
}

export function verifyCandidateInventory({ inventoryPath, tarballPath }) {
  const inventory = readJson(inventoryPath, 'candidate inventory');
  assertObjectKeys(inventory, INVENTORY_KEYS, 'candidate inventory');
  assertObjectKeys(inventory.tarball, TARBALL_KEYS, 'candidate inventory tarball');
  if (inventory.schemaVersion !== 1) {
    throw new Error(`candidate inventory schema version must be 1; got ${inventory.schemaVersion}`);
  }
  validateReleaseMetadata(inventory, 'candidate inventory');

  const packedPackage = readPackedPackageJson(tarballPath);
  if (packedPackage.name !== inventory.packageName) {
    throw new Error(`packed package name must equal ${inventory.packageName}; got ${packedPackage.name}`);
  }
  if (packedPackage.version !== inventory.version) {
    throw new Error(`packed package version must equal ${inventory.version}; got ${packedPackage.version}`);
  }
  if (basename(tarballPath) !== inventory.tarball.fileName) {
    throw new Error(`tarball file name must equal ${inventory.tarball.fileName}`);
  }

  const bytes = readFileSync(tarballPath);
  if (statSync(tarballPath).size !== inventory.tarball.byteLength) {
    throw new Error('tarball byte length does not match the candidate inventory');
  }
  if (digest(bytes, 'sha1') !== inventory.tarball.sha1) {
    throw new Error('tarball SHA-1 does not match the candidate inventory');
  }
  if (digest(bytes, 'sha256') !== inventory.tarball.sha256) {
    throw new Error('tarball SHA-256 does not match the candidate inventory');
  }

  return inventory;
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value pairs; got ${flag ?? '(missing)'}`);
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

function requireOptions(options, names) {
  for (const name of names) {
    if (!options[name]) {
      throw new Error(`Missing required option --${name}`);
    }
  }
}

function runCli() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseOptions(args);
  if (command === 'create') {
    requireOptions(options, ['tarball', 'package-json', 'source-revision', 'tag', 'output']);
    writeCandidateInventory({
      outputPath: options.output,
      packageJsonPath: options['package-json'],
      sourceRevision: options['source-revision'],
      tag: options.tag,
      tarballPath: options.tarball,
    });
    return;
  }
  if (command === 'verify') {
    requireOptions(options, ['tarball', 'inventory']);
    verifyCandidateInventory({
      inventoryPath: options.inventory,
      tarballPath: options.tarball,
    });
    return;
  }
  throw new Error('Usage: release-candidate.mjs <create|verify> [options]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
