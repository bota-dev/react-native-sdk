#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONTRACT_REVISION = 'encrypted-upload-v2-contract-v1';
const SOURCE_REPOSITORY = 'bota-dev/app-sdk';
const SOURCE_PATH = 'protocol/vectors/encrypted-upload-v2.json';
const SOURCE_REVISION = /^[0-9a-f]{40}$/;
const SOURCE_KEYS = ['sha256', 'sourcePath', 'sourceRepository', 'sourceRevision'];
const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_DESTINATION = join(REPOSITORY_ROOT, 'protocol', 'vendor', 'app-sdk');

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error(`${label} fields must be exactly ${sortedExpected.join(', ')}`);
  }
}

function parseJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return value;
}

function validateVector(bytes, label) {
  const vector = parseJson(bytes, label);
  if (!vector || typeof vector !== 'object' || Array.isArray(vector)) {
    throw new Error(`${label} must be a JSON object`);
  }
  if (vector.contractRevision !== CONTRACT_REVISION) {
    throw new Error(
      `${label} contractRevision must be ${CONTRACT_REVISION}; got ${vector.contractRevision}`
    );
  }
}

function validateSourceMetadata(value) {
  assertExactKeys(value, SOURCE_KEYS, 'encrypted upload v2 source metadata');
  if (value.sourceRepository !== SOURCE_REPOSITORY) {
    throw new Error(`sourceRepository must be ${SOURCE_REPOSITORY}`);
  }
  if (value.sourcePath !== SOURCE_PATH) {
    throw new Error(`sourcePath must be ${SOURCE_PATH}`);
  }
  if (!SOURCE_REVISION.test(value.sourceRevision)) {
    throw new Error('sourceRevision must be a lowercase 40-character Git object ID');
  }
  if (!/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new Error('sha256 must be a lowercase 64-character digest');
  }
  return value;
}

function readCommittedVector(appSdkPath, sourceRevision) {
  if (!SOURCE_REVISION.test(sourceRevision)) {
    throw new Error('source revision must be a lowercase 40-character Git object ID');
  }

  const checkout = resolve(appSdkPath);
  let isCheckout;
  try {
    isCheckout = execFileSync(
      'git',
      ['-C', checkout, 'rev-parse', '--is-inside-work-tree'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
  } catch (error) {
    throw new Error(
      `--app-sdk must resolve to a Git checkout: ${error.stderr?.toString().trim() || error.message}`
    );
  }
  if (isCheckout !== 'true') {
    throw new Error('--app-sdk must resolve to a Git checkout');
  }

  let bytes;
  try {
    bytes = execFileSync(
      'git',
      ['-C', checkout, 'show', `${sourceRevision}:${SOURCE_PATH}`],
      { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (error) {
    throw new Error(
      `failed to read ${SOURCE_PATH} at ${sourceRevision}: ${error.stderr?.toString().trim() || error.message}`
    );
  }
  validateVector(bytes, 'committed App SDK vector');
  return bytes;
}

function writeAtomic(path, bytes) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes, { flag: 'wx' });
  renameSync(temporary, path);
}

function readVendored(destinationDirectory) {
  const vectorPath = join(destinationDirectory, 'encrypted-upload-v2.json');
  const sourcePath = join(destinationDirectory, 'encrypted-upload-v2.source.json');
  let vectorBytes;
  let sourceMetadata;
  try {
    vectorBytes = readFileSync(vectorPath);
    sourceMetadata = parseJson(readFileSync(sourcePath), 'encrypted upload v2 source metadata');
  } catch (error) {
    throw new Error(`failed to read vendored encrypted upload v2 contract: ${error.message}`);
  }
  validateVector(vectorBytes, 'vendored encrypted upload v2 vector');
  validateSourceMetadata(sourceMetadata);
  return { sourceMetadata, vectorBytes };
}

export function syncEncryptedUploadV2Vectors({
  appSdkPath,
  check = false,
  destinationDirectory = DEFAULT_DESTINATION,
  sourceRevision,
}) {
  const destination = resolve(destinationDirectory);
  if ((appSdkPath === undefined) !== (sourceRevision === undefined)) {
    throw new Error('--app-sdk and --source-revision must be supplied together');
  }

  if (check) {
    const vendored = readVendored(destination);
    const actualDigest = digest(vendored.vectorBytes);
    if (actualDigest !== vendored.sourceMetadata.sha256) {
      throw new Error('vendored vector bytes do not match the recorded SHA-256');
    }

    if (appSdkPath !== undefined && sourceRevision !== undefined) {
      const committed = readCommittedVector(appSdkPath, sourceRevision);
      if (vendored.sourceMetadata.sourceRevision !== sourceRevision) {
        throw new Error('vendored source revision does not match --source-revision');
      }
      if (!vendored.vectorBytes.equals(committed)) {
        throw new Error('vendored vector bytes do not match the committed App SDK vector');
      }
    }
    return vendored.sourceMetadata;
  }

  if (appSdkPath === undefined || sourceRevision === undefined) {
    throw new Error('write mode requires --app-sdk and --source-revision');
  }

  const vectorBytes = readCommittedVector(appSdkPath, sourceRevision);
  const sourceMetadata = {
    sourceRepository: SOURCE_REPOSITORY,
    sourcePath: SOURCE_PATH,
    sourceRevision,
    sha256: digest(vectorBytes),
  };
  mkdirSync(destination, { recursive: true });
  writeAtomic(join(destination, 'encrypted-upload-v2.json'), vectorBytes);
  writeAtomic(
    join(destination, 'encrypted-upload-v2.source.json'),
    `${JSON.stringify(sourceMetadata, null, 2)}\n`
  );
  return sourceMetadata;
}

function parseCli(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--check') {
      if (options.check !== undefined) {
        throw new Error('duplicate option --check');
      }
      options.check = true;
      continue;
    }
    if (flag !== '--app-sdk' && flag !== '--source-revision') {
      throw new Error(`unknown option ${flag ?? '(missing)'}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${flag}`);
    }
    const key = flag === '--app-sdk' ? 'appSdkPath' : 'sourceRevision';
    if (options[key] !== undefined) {
      throw new Error(`duplicate option ${flag}`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    syncEncryptedUploadV2Vectors(parseCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
