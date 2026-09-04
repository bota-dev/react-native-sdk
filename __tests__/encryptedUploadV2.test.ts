import { Buffer } from 'buffer';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import vectors from '../protocol/vendor/app-sdk/encrypted-upload-v2.json';
import {
  decodeEncryptedUploadV2Capabilities,
  decodeEncryptedUploadV2Document,
  decodeEncryptedUploadV2SignedBlob,
  decodeEncryptedUploadV2Transfer,
  encodeEncryptedUploadV2SignedBlob,
  encodeEncryptedUploadV2Transfer,
  supportsEncryptedUploadV2Batch,
} from '../src/protocol/encryptedUploadV2';

interface VectorCase {
  name: string;
  category: string;
  operation: string;
  inputHex: string;
  expected?: {
    decodedType?: string;
    encodedHex?: string;
  };
  expectedError?: string;
}

const cases = vectors.cases as VectorCase[];
const bytes = (vector: VectorCase): Buffer => Buffer.from(vector.inputHex, 'hex');
const V2_CHARACTERISTIC_UUIDS = [
  'B07A0004-0006-1000-8000-00805F9B34FB',
  'B07A0004-0007-1000-8000-00805F9B34FB',
  'B07A0004-0008-1000-8000-00805F9B34FB',
  'B07A0004-0009-1000-8000-00805F9B34FB',
  'B07A0004-000A-1000-8000-00805F9B34FB',
  'B07A0004-000B-1000-8000-00805F9B34FB',
];

function thrownCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function contractFiles(root: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'lib' || entry.name === 'node_modules') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...contractFiles(path));
    } else if (/\.(?:md|ts)$/.test(entry.name)) {
      paths.push(path);
    }
  }
  return paths;
}

describe('Encrypted Upload v2 internal contract codecs', () => {
  it('decodes and re-encodes every stateless BLE framing vector', () => {
    const valid = cases.filter(
      (vector) => vector.category === 'ble' && vector.expected?.decodedType
    );

    for (const vector of valid) {
      if (vector.operation === 'decodeCapabilities') {
        const value = decodeEncryptedUploadV2Capabilities(bytes(vector));
        expect(value.highestTransferProfileVersion).toBe(2);
        continue;
      }
      if (vector.operation === 'decodeSignedBlob') {
        const value = decodeEncryptedUploadV2SignedBlob(bytes(vector));
        expect(value.type).toBe(vector.expected?.decodedType);
        expect(encodeEncryptedUploadV2SignedBlob(value).toString('hex')).toBe(
          vector.expected?.encodedHex
        );
        continue;
      }
      if (vector.operation === 'decodeTransfer') {
        const value = decodeEncryptedUploadV2Transfer(bytes(vector));
        expect(value.type).toBe(vector.expected?.decodedType);
        expect(encodeEncryptedUploadV2Transfer(value).toString('hex')).toBe(
          vector.expected?.encodedHex
        );
      }
    }
  });

  it('returns the stable vector error for every stateless malformed BLE frame', () => {
    const statelessMalformedNames = new Set([
      'ble-truncated-capability',
      'ble-capability-trailing-byte',
      'ble-capability-unknown-version',
      'ble-capability-unknown-flag',
      'ble-capability-nonzero-reserved',
      'ble-truncated-blob-begin',
      'ble-blob-nonzero-reserved',
      'ble-trailing-start',
      'ble-truncated-start',
      'ble-nonzero-reserved',
      'ble-unknown-message',
      'ble-unknown-version',
      'ble-unknown-flags',
      'ble-window-count-mismatch',
      'ble-data-length-mismatch',
      'ble-zero-session',
    ]);
    const operations = {
      decodeCapabilities: decodeEncryptedUploadV2Capabilities,
      decodeSignedBlob: decodeEncryptedUploadV2SignedBlob,
      decodeTransfer: decodeEncryptedUploadV2Transfer,
    } as const;

    for (const vector of cases.filter((item) => statelessMalformedNames.has(item.name))) {
      const operation = operations[vector.operation as keyof typeof operations];
      expect(thrownCode(() => operation(bytes(vector)))).toBe(vector.expectedError);
    }
  });

  it('requires explicit batch capabilities 0 through 6 and ignores streaming bit 7', () => {
    const capability = cases.find((vector) => vector.name === 'capability');
    if (!capability) throw new Error('capability vector is missing');
    const decoded = decodeEncryptedUploadV2Capabilities(bytes(capability));

    expect(supportsEncryptedUploadV2Batch({ ...decoded, flags: 0x7f })).toBe(true);
    expect(supportsEncryptedUploadV2Batch({ ...decoded, flags: 0xff })).toBe(true);
    expect(supportsEncryptedUploadV2Batch({ ...decoded, flags: 0x7e })).toBe(false);
    expect(supportsEncryptedUploadV2Batch(undefined)).toBe(false);
  });

  it('keeps signed documents opaque while validating framing', () => {
    const kinds = {
      verifyUploadAuthorization: 'authorization',
      verifyUploadManifest: 'manifest',
      verifyCompletionReceipt: 'receipt',
    } as const;

    for (const vector of cases.filter((item) => item.category === 'signed-document')) {
      const kind = kinds[vector.operation as keyof typeof kinds];
      const value = decodeEncryptedUploadV2Document(kind, bytes(vector));
      expect(Object.keys(value).sort()).toEqual(['byteLength', 'bytes', 'kind', 'version']);
      expect(value.kind).toBe(kind);
      expect(value.version).toBe(2);
      expect(value.bytes.toString('hex')).toBe(vector.inputHex);
    }
  });

  it('rejects malformed signed-document framing before treating bytes as opaque', () => {
    const authorization = cases.find(
      (vector) => vector.name === 'authorization-development'
    );
    if (!authorization) throw new Error('authorization vector is missing');

    const truncated = bytes(authorization).subarray(0, -1);
    expect(thrownCode(() => decodeEncryptedUploadV2Document('authorization', truncated))).toBe(
      'invalid_length'
    );
    const wrongVersion = bytes(authorization);
    wrongVersion.writeUInt16LE(1, 8);
    expect(thrownCode(() => decodeEncryptedUploadV2Document('authorization', wrongVersion))).toBe(
      'unsupported_version'
    );
  });

  it('keeps v2 characteristic UUIDs out of BLE runtime call sites', () => {
    const repositoryRoot = join(__dirname, '..');
    const allowed = [
      'FIRMWARE_PROTOCOL.md',
      '__tests__/encryptedUploadV2.test.ts',
      'src/ble/constants.ts',
    ].sort();
    const paths = contractFiles(repositoryRoot);

    for (const uuid of V2_CHARACTERISTIC_UUIDS) {
      const hits = paths
        .filter((path) => readFileSync(path, 'utf8').includes(uuid))
        .map((path) => relative(repositoryRoot, path))
        .sort();
      expect(hits).toEqual(allowed);
    }
  });
});
