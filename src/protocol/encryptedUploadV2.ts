import { Buffer } from 'buffer';

export type EncryptedUploadV2Availability = 'unsupported' | 'batch';
export type EncryptedUploadV2DocumentKind = 'authorization' | 'manifest' | 'receipt';
export type EncryptedUploadV2ContractErrorCode =
  | 'invalid_length'
  | 'noncanonical_encoding'
  | 'unsupported_version';

export class EncryptedUploadV2ContractError extends Error {
  constructor(
    readonly code: EncryptedUploadV2ContractErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'EncryptedUploadV2ContractError';
  }
}

export interface EncryptedUploadV2Capabilities {
  highestTransferProfileVersion: number;
  flags: number;
  maximumSignedBlobBytes: number;
  maximumManifestBytes: number;
  maximumDataPayloadBytes: number;
  maximumWindowPackets: number;
  durableCheckpointIntervalBlocks: number;
  maximumMissingSequences: number;
}

export interface EncryptedUploadV2Document {
  kind: EncryptedUploadV2DocumentKind;
  version: 2;
  byteLength: number;
  bytes: Buffer;
}

export interface EncryptedUploadV2CommonHeader {
  messageType: number;
  flags: number;
  transportSessionId: bigint;
}

export type EncryptedUploadV2SignedBlob =
  | {
      type: 'blobBegin';
      kind: number;
      writeId: number;
      totalLength: number;
      sha256: Buffer;
    }
  | {
      type: 'blobData';
      kind: number;
      writeId: number;
      offset: number;
      data: Buffer;
    }
  | { type: 'blobCommit'; kind: number; writeId: number }
  | { type: 'blobAbort'; kind: number; writeId: number }
  | { type: 'blobResult'; kind: number; writeId: number; result: number };

interface EncryptedUploadV2StartFields {
  common: EncryptedUploadV2CommonHeader;
  uploadSessionUuid: Buffer;
  recordingUuid: Buffer;
  recordingGeneration: number;
  checkpointRevision: number;
  nextCiphertextOffset: bigint;
  prefixSha256: Buffer;
  windowPackets: number;
  dataPayloadBytes: number;
}

export type EncryptedUploadV2Transfer =
  | { type: 'list'; common: EncryptedUploadV2CommonHeader; requestFlags: number }
  | {
      type: 'recordingEntry';
      common: EncryptedUploadV2CommonHeader;
      recordingUuid: Buffer;
      recordingGeneration: number;
      storageFormat: number;
      completionState: number;
      startedAt: bigint;
      durationSeconds: number;
      plaintextLength: bigint;
      ciphertextLength: bigint;
      ciphertextSha256: Buffer;
    }
  | {
      type: 'recordingListEnd';
      common: EncryptedUploadV2CommonHeader;
      count: number;
      listRevision: number;
      listSha256: Buffer;
    }
  | (EncryptedUploadV2StartFields & {
      type: 'start';
      authorizationSha256: Buffer;
    })
  | (EncryptedUploadV2StartFields & {
      type: 'startAck';
      ciphertextLength: bigint;
      ciphertextSha256: Buffer;
      checkpointIntervalBlocks: number;
    })
  | {
      type: 'data';
      common: EncryptedUploadV2CommonHeader;
      sequence: number;
      offset: bigint;
      data: Buffer;
    }
  | {
      type: 'windowEnd';
      common: EncryptedUploadV2CommonHeader;
      windowIndex: number;
      firstSequence: number;
      lastSequence: number;
      nextCiphertextOffset: bigint;
      prefixSha256: Buffer;
      checkpointRevision: number;
    }
  | {
      type: 'windowAck';
      common: EncryptedUploadV2CommonHeader;
      windowIndex: number;
      highestContiguousSequence: number;
      nextCiphertextOffset: bigint;
      prefixSha256: Buffer;
      checkpointRevision: number;
      missingSequences: number[];
    }
  | {
      type: 'manifestChunk';
      common: EncryptedUploadV2CommonHeader;
      totalManifestLength: number;
      chunkOffset: number;
      manifestSha256: Buffer;
      chunk: Buffer;
    }
  | {
      type: 'eof';
      common: EncryptedUploadV2CommonHeader;
      finalSequence: number;
      blockCount: number;
      ciphertextLength: bigint;
      ciphertextSha256: Buffer;
      manifestSha256: Buffer;
    }
  | (EncryptedUploadV2StartFields & { type: 'resumeRequest' | 'resumeAccept' })
  | {
      type: 'resumeReject';
      common: EncryptedUploadV2CommonHeader;
      reason: number;
      checkpointRevision: number;
      nextCiphertextOffset: bigint;
      prefixSha256: Buffer;
    }
  | {
      type: 'confirm';
      common: EncryptedUploadV2CommonHeader;
      uploadSessionUuid: Buffer;
      recordingUuid: Buffer;
      recordingGeneration: number;
      ownerRevision: number;
      receiptSha256: Buffer;
    }
  | { type: 'abort'; common: EncryptedUploadV2CommonHeader; reason: number }
  | {
      type: 'error';
      common: EncryptedUploadV2CommonHeader;
      result: number;
      failedMessageType: number;
      checkpointRevision: number;
    };

const DOCUMENT_VERSION = 2;
const TRANSFER_VERSION = 2;
const MAX_FRAME_LENGTH = 512;
const BLOB_DOCUMENT_LENGTHS: Readonly<Record<number, number>> = { 1: 408, 2: 336 };
const DOCUMENTS: Readonly<
  Record<EncryptedUploadV2DocumentKind, { magic: string; length: number }>
> = {
  authorization: { magic: 'BOTAAUT2', length: 408 },
  manifest: { magic: 'BOTAMNF2', length: 580 },
  receipt: { magic: 'BOTARCPT', length: 336 },
};

const MESSAGE = {
  start: 0x20,
  windowAck: 0x21,
  resumeRequest: 0x22,
  confirm: 0x23,
  abort: 0x24,
  list: 0x25,
  startAck: 0x40,
  data: 0x41,
  windowEnd: 0x42,
  manifestChunk: 0x43,
  eof: 0x44,
  resumeAccept: 0x45,
  resumeReject: 0x46,
  recordingEntry: 0x48,
  recordingListEnd: 0x49,
  error: 0x4f,
} as const;

function fail(code: EncryptedUploadV2ContractErrorCode, message: string): never {
  throw new EncryptedUploadV2ContractError(code, message);
}

function requireExact(bytes: Buffer, expected: number, label: string): void {
  if (bytes.length !== expected) {
    fail('invalid_length', `${label} must be ${expected} bytes; got ${bytes.length}`);
  }
}

function requireMinimum(bytes: Buffer, minimum: number, label: string): void {
  if (bytes.length < minimum) {
    fail('invalid_length', `${label} must be at least ${minimum} bytes; got ${bytes.length}`);
  }
  if (bytes.length > MAX_FRAME_LENGTH) {
    fail('invalid_length', `${label} exceeds the maximum frame length`);
  }
}

function requireZero(bytes: Buffer, offset: number, length: number, label: string): void {
  for (let index = offset; index < offset + length; index += 1) {
    if (bytes[index] !== 0) {
      fail('noncanonical_encoding', `${label} must be zero`);
    }
  }
}

function fixed(bytes: Buffer, offset: number, length: number): Buffer {
  return Buffer.from(bytes.subarray(offset, offset + length));
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

function requireU16(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    fail('invalid_length', `${label} must fit u16`);
  }
}

function requireU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail('invalid_length', `${label} must fit u32`);
  }
}

function requireU64(value: bigint, label: string): void {
  if (value < 0n || value > 0xffffffffffffffffn) {
    fail('invalid_length', `${label} must fit u64`);
  }
}

function putFixed(target: Buffer, offset: number, value: Uint8Array, length: number, label: string): void {
  if (value.byteLength !== length) {
    fail('invalid_length', `${label} must be ${length} bytes`);
  }
  Buffer.from(value).copy(target, offset);
}

function decodeCommon(bytes: Buffer, expectedMessage: number): EncryptedUploadV2CommonHeader {
  requireMinimum(bytes, 12, 'transfer frame');
  if (bytes[0] !== expectedMessage) {
    fail('unsupported_version', `unexpected transfer message ${bytes[0]}`);
  }
  if (bytes[1] !== TRANSFER_VERSION) {
    fail('unsupported_version', `unsupported transfer version ${bytes[1]}`);
  }
  const flags = bytes.readUInt16LE(2);
  if (flags !== 0) {
    fail('noncanonical_encoding', 'transfer message flags must be zero');
  }
  const transportSessionId = bytes.readBigUInt64LE(4);
  if (transportSessionId === 0n) {
    fail('noncanonical_encoding', 'transport session ID must be nonzero');
  }
  return { messageType: expectedMessage, flags, transportSessionId };
}

function encodeCommon(
  common: EncryptedUploadV2CommonHeader,
  expectedMessage: number,
  length: number
): Buffer {
  if (common.messageType !== expectedMessage) {
    fail('noncanonical_encoding', 'transfer variant and message type disagree');
  }
  if (common.flags !== 0) {
    fail('noncanonical_encoding', 'transfer message flags must be zero');
  }
  requireU64(common.transportSessionId, 'transport session ID');
  if (common.transportSessionId === 0n) {
    fail('noncanonical_encoding', 'transport session ID must be nonzero');
  }
  const bytes = Buffer.alloc(length);
  bytes[0] = expectedMessage;
  bytes[1] = TRANSFER_VERSION;
  bytes.writeUInt16LE(common.flags, 2);
  bytes.writeBigUInt64LE(common.transportSessionId, 4);
  return bytes;
}

function requireWindow(windowPackets: number, dataPayloadBytes: number): void {
  requireU16(windowPackets, 'window packets');
  requireU16(dataPayloadBytes, 'DATA payload bytes');
  if (windowPackets === 0 || dataPayloadBytes === 0) {
    fail('invalid_length', 'window packets and DATA payload bytes must be nonzero');
  }
}

function blobDocumentLength(kind: number): number {
  const length = BLOB_DOCUMENT_LENGTHS[kind];
  if (length === undefined) {
    fail('unsupported_version', `unknown signed blob kind ${kind}`);
  }
  return length;
}

function decodeBlobPrefix(bytes: Buffer): { kind: number; writeId: number } {
  if (bytes[1] !== DOCUMENT_VERSION) {
    fail('unsupported_version', `unsupported signed blob version ${bytes[1]}`);
  }
  const kind = bytes[2];
  blobDocumentLength(kind);
  requireZero(bytes, 3, 1, 'signed blob reserved byte');
  return { kind, writeId: bytes.readUInt32LE(4) };
}

function encodeBlobPrefix(code: number, kind: number, writeId: number, length: number): Buffer {
  blobDocumentLength(kind);
  requireU32(writeId, 'signed blob write ID');
  const bytes = Buffer.alloc(length);
  bytes[0] = code;
  bytes[1] = DOCUMENT_VERSION;
  bytes[2] = kind;
  bytes.writeUInt32LE(writeId, 4);
  return bytes;
}

export function decodeEncryptedUploadV2Capabilities(
  value: Uint8Array
): EncryptedUploadV2Capabilities {
  const bytes = asBuffer(value);
  requireExact(bytes, 24, 'capability value');
  if (bytes[0] !== 1 || bytes[1] !== TRANSFER_VERSION) {
    fail('unsupported_version', 'unsupported encrypted upload v2 capability version');
  }
  if (bytes.readUInt16LE(2) !== 24) {
    fail('invalid_length', 'capability declared length must be 24');
  }
  const flags = bytes.readUInt32LE(4);
  if ((flags & ~0xff) !== 0) {
    fail('noncanonical_encoding', 'capability flags contain unknown bits');
  }
  requireZero(bytes, 22, 2, 'capability reserved bytes');
  const decoded = {
    highestTransferProfileVersion: bytes[1],
    flags,
    maximumSignedBlobBytes: bytes.readUInt16LE(8),
    maximumManifestBytes: bytes.readUInt16LE(10),
    maximumDataPayloadBytes: bytes.readUInt16LE(12),
    maximumWindowPackets: bytes.readUInt16LE(14),
    durableCheckpointIntervalBlocks: bytes.readUInt32LE(16),
    maximumMissingSequences: bytes.readUInt16LE(20),
  };
  if (
    decoded.maximumSignedBlobBytes < 408 ||
    decoded.maximumManifestBytes < 580 ||
    decoded.maximumDataPayloadBytes === 0 ||
    decoded.maximumWindowPackets === 0 ||
    decoded.durableCheckpointIntervalBlocks === 0 ||
    decoded.maximumMissingSequences === 0
  ) {
    fail('invalid_length', 'capability bounds are not usable');
  }
  return decoded;
}

export function supportsEncryptedUploadV2Batch(
  value: EncryptedUploadV2Capabilities | undefined
): boolean {
  const required = 0x7f;
  return (
    value !== undefined &&
    value.highestTransferProfileVersion === 2 &&
    (value.flags & required) === required
  );
}

export function decodeEncryptedUploadV2Document(
  kind: EncryptedUploadV2DocumentKind,
  value: Uint8Array
): EncryptedUploadV2Document {
  const bytes = asBuffer(value);
  const format = DOCUMENTS[kind];
  requireExact(bytes, format.length, `${kind} document`);
  if (!bytes.subarray(0, 8).equals(Buffer.from(format.magic, 'ascii'))) {
    fail('unsupported_version', `${kind} document magic is not recognized`);
  }
  if (bytes.readUInt16LE(8) !== DOCUMENT_VERSION) {
    fail('unsupported_version', `${kind} document version is not supported`);
  }
  if (bytes.readUInt16LE(10) !== format.length) {
    fail('invalid_length', `${kind} document declared length is not canonical`);
  }
  return { kind, version: 2, byteLength: bytes.length, bytes };
}

export function decodeEncryptedUploadV2SignedBlob(
  value: Uint8Array
): EncryptedUploadV2SignedBlob {
  const bytes = asBuffer(value);
  requireMinimum(bytes, 1, 'signed blob frame');
  switch (bytes[0]) {
    case 0x60: {
      requireExact(bytes, 42, 'signed blob BEGIN');
      const prefix = decodeBlobPrefix(bytes);
      const totalLength = bytes.readUInt16LE(8);
      if (totalLength !== blobDocumentLength(prefix.kind)) {
        fail('invalid_length', 'signed blob total length is not canonical');
      }
      return {
        type: 'blobBegin',
        ...prefix,
        totalLength,
        sha256: fixed(bytes, 10, 32),
      };
    }
    case 0x61: {
      requireMinimum(bytes, 12, 'signed blob DATA');
      const prefix = decodeBlobPrefix(bytes);
      const offset = bytes.readUInt16LE(8);
      const chunkLength = bytes.readUInt16LE(10);
      if (chunkLength === 0 || bytes.length !== 12 + chunkLength) {
        fail('invalid_length', 'signed blob DATA length is not canonical');
      }
      if (offset + chunkLength > blobDocumentLength(prefix.kind)) {
        fail('invalid_length', 'signed blob DATA exceeds its document');
      }
      return { type: 'blobData', ...prefix, offset, data: fixed(bytes, 12, chunkLength) };
    }
    case 0x62:
    case 0x63: {
      requireExact(bytes, 8, bytes[0] === 0x62 ? 'signed blob COMMIT' : 'signed blob ABORT');
      const prefix = decodeBlobPrefix(bytes);
      return { type: bytes[0] === 0x62 ? 'blobCommit' : 'blobAbort', ...prefix };
    }
    case 0x64: {
      requireExact(bytes, 10, 'signed blob RESULT');
      const prefix = decodeBlobPrefix(bytes);
      return { type: 'blobResult', ...prefix, result: bytes.readUInt16LE(8) };
    }
    default:
      fail('unsupported_version', `unknown signed blob message ${bytes[0]}`);
  }
}

export function encodeEncryptedUploadV2SignedBlob(value: EncryptedUploadV2SignedBlob): Buffer {
  switch (value.type) {
    case 'blobBegin': {
      if (value.totalLength !== blobDocumentLength(value.kind)) {
        fail('invalid_length', 'signed blob total length is not canonical');
      }
      const bytes = encodeBlobPrefix(0x60, value.kind, value.writeId, 42);
      bytes.writeUInt16LE(value.totalLength, 8);
      putFixed(bytes, 10, value.sha256, 32, 'signed blob SHA-256');
      return bytes;
    }
    case 'blobData': {
      requireU16(value.offset, 'signed blob offset');
      requireU16(value.data.byteLength, 'signed blob DATA length');
      if (
        value.data.byteLength === 0 ||
        value.offset + value.data.byteLength > blobDocumentLength(value.kind) ||
        12 + value.data.byteLength > MAX_FRAME_LENGTH
      ) {
        fail('invalid_length', 'signed blob DATA range is not canonical');
      }
      const bytes = encodeBlobPrefix(0x61, value.kind, value.writeId, 12 + value.data.byteLength);
      bytes.writeUInt16LE(value.offset, 8);
      bytes.writeUInt16LE(value.data.byteLength, 10);
      Buffer.from(value.data).copy(bytes, 12);
      return bytes;
    }
    case 'blobCommit':
      return encodeBlobPrefix(0x62, value.kind, value.writeId, 8);
    case 'blobAbort':
      return encodeBlobPrefix(0x63, value.kind, value.writeId, 8);
    case 'blobResult': {
      requireU16(value.result, 'signed blob result');
      const bytes = encodeBlobPrefix(0x64, value.kind, value.writeId, 10);
      bytes.writeUInt16LE(value.result, 8);
      return bytes;
    }
  }
}

export function decodeEncryptedUploadV2Transfer(value: Uint8Array): EncryptedUploadV2Transfer {
  const bytes = asBuffer(value);
  requireMinimum(bytes, 1, 'transfer frame');
  const messageType = bytes[0];
  if (!Object.values(MESSAGE).includes(messageType as (typeof MESSAGE)[keyof typeof MESSAGE])) {
    fail('unsupported_version', `unknown transfer message ${messageType}`);
  }

  switch (messageType) {
    case MESSAGE.list: {
      requireExact(bytes, 16, 'LIST');
      const common = decodeCommon(bytes, messageType);
      const requestFlags = bytes.readUInt32LE(12);
      if (requestFlags !== 0) fail('noncanonical_encoding', 'LIST request flags must be zero');
      return { type: 'list', common, requestFlags };
    }
    case MESSAGE.recordingEntry: {
      requireExact(bytes, 96, 'RECORDING_ENTRY');
      const common = decodeCommon(bytes, messageType);
      requireZero(bytes, 34, 2, 'RECORDING_ENTRY reserved bytes');
      const storageFormat = bytes[32];
      const completionState = bytes[33];
      if (storageFormat !== 3 || completionState !== 1) {
        fail('noncanonical_encoding', 'RECORDING_ENTRY is not committed bota_enc_v2');
      }
      return {
        type: 'recordingEntry',
        common,
        recordingUuid: fixed(bytes, 12, 16),
        recordingGeneration: bytes.readUInt32LE(28),
        storageFormat,
        completionState,
        startedAt: bytes.readBigUInt64LE(36),
        durationSeconds: bytes.readUInt32LE(44),
        plaintextLength: bytes.readBigUInt64LE(48),
        ciphertextLength: bytes.readBigUInt64LE(56),
        ciphertextSha256: fixed(bytes, 64, 32),
      };
    }
    case MESSAGE.recordingListEnd:
      requireExact(bytes, 52, 'RECORDING_LIST_END');
      return {
        type: 'recordingListEnd',
        common: decodeCommon(bytes, messageType),
        count: bytes.readUInt32LE(12),
        listRevision: bytes.readUInt32LE(16),
        listSha256: fixed(bytes, 20, 32),
      };
    case MESSAGE.start: {
      requireExact(bytes, 128, 'START');
      const windowPackets = bytes.readUInt16LE(124);
      const dataPayloadBytes = bytes.readUInt16LE(126);
      requireWindow(windowPackets, dataPayloadBytes);
      return {
        type: 'start',
        common: decodeCommon(bytes, messageType),
        uploadSessionUuid: fixed(bytes, 12, 16),
        recordingUuid: fixed(bytes, 28, 16),
        recordingGeneration: bytes.readUInt32LE(44),
        authorizationSha256: fixed(bytes, 48, 32),
        checkpointRevision: bytes.readUInt32LE(80),
        nextCiphertextOffset: bytes.readBigUInt64LE(84),
        prefixSha256: fixed(bytes, 92, 32),
        windowPackets,
        dataPayloadBytes,
      };
    }
    case MESSAGE.startAck: {
      requireExact(bytes, 140, 'START_ACK');
      const windowPackets = bytes.readUInt16LE(88);
      const dataPayloadBytes = bytes.readUInt16LE(90);
      requireWindow(windowPackets, dataPayloadBytes);
      const checkpointIntervalBlocks = bytes.readUInt32LE(92);
      if (checkpointIntervalBlocks === 0) {
        fail('invalid_length', 'START_ACK checkpoint interval must be nonzero');
      }
      return {
        type: 'startAck',
        common: decodeCommon(bytes, messageType),
        uploadSessionUuid: fixed(bytes, 12, 16),
        recordingUuid: fixed(bytes, 28, 16),
        recordingGeneration: bytes.readUInt32LE(44),
        ciphertextLength: bytes.readBigUInt64LE(48),
        ciphertextSha256: fixed(bytes, 56, 32),
        windowPackets,
        dataPayloadBytes,
        checkpointIntervalBlocks,
        checkpointRevision: bytes.readUInt32LE(96),
        nextCiphertextOffset: bytes.readBigUInt64LE(100),
        prefixSha256: fixed(bytes, 108, 32),
      };
    }
    case MESSAGE.data: {
      requireMinimum(bytes, 28, 'DATA');
      const common = decodeCommon(bytes, messageType);
      const payloadLength = bytes.readUInt16LE(24);
      requireZero(bytes, 26, 2, 'DATA reserved bytes');
      if (payloadLength === 0 || bytes.length !== 28 + payloadLength) {
        fail('invalid_length', 'DATA payload length is not canonical');
      }
      const offset = bytes.readBigUInt64LE(16);
      if (offset + BigInt(payloadLength) > 0xffffffffffffffffn) {
        fail('invalid_length', 'DATA ciphertext range overflows u64');
      }
      return {
        type: 'data',
        common,
        sequence: bytes.readUInt32LE(12),
        offset,
        data: fixed(bytes, 28, payloadLength),
      };
    }
    case MESSAGE.windowEnd: {
      requireExact(bytes, 68, 'WINDOW_END');
      const firstSequence = bytes.readUInt32LE(16);
      const lastSequence = bytes.readUInt32LE(20);
      if (firstSequence > lastSequence) {
        fail('invalid_length', 'WINDOW_END first sequence exceeds last sequence');
      }
      return {
        type: 'windowEnd',
        common: decodeCommon(bytes, messageType),
        windowIndex: bytes.readUInt32LE(12),
        firstSequence,
        lastSequence,
        nextCiphertextOffset: bytes.readBigUInt64LE(24),
        prefixSha256: fixed(bytes, 32, 32),
        checkpointRevision: bytes.readUInt32LE(64),
      };
    }
    case MESSAGE.windowAck: {
      requireMinimum(bytes, 68, 'WINDOW_ACK');
      const common = decodeCommon(bytes, messageType);
      const count = bytes.readUInt16LE(64);
      requireZero(bytes, 66, 2, 'WINDOW_ACK reserved bytes');
      if (bytes.length !== 68 + count * 4) {
        fail('invalid_length', 'WINDOW_ACK missing sequence count does not match its tail');
      }
      const missingSequences = Array.from({ length: count }, (_, index) =>
        bytes.readUInt32LE(68 + index * 4)
      );
      return {
        type: 'windowAck',
        common,
        windowIndex: bytes.readUInt32LE(12),
        highestContiguousSequence: bytes.readUInt32LE(16),
        nextCiphertextOffset: bytes.readBigUInt64LE(20),
        prefixSha256: fixed(bytes, 28, 32),
        checkpointRevision: bytes.readUInt32LE(60),
        missingSequences,
      };
    }
    case MESSAGE.manifestChunk: {
      requireMinimum(bytes, 52, 'MANIFEST_CHUNK');
      const common = decodeCommon(bytes, messageType);
      const totalManifestLength = bytes.readUInt16LE(12);
      const chunkOffset = bytes.readUInt16LE(14);
      const chunkLength = bytes.readUInt16LE(16);
      requireZero(bytes, 18, 2, 'MANIFEST_CHUNK reserved bytes');
      if (
        totalManifestLength !== 580 ||
        chunkLength === 0 ||
        bytes.length !== 52 + chunkLength ||
        chunkOffset + chunkLength > totalManifestLength
      ) {
        fail('invalid_length', 'MANIFEST_CHUNK range is not canonical');
      }
      return {
        type: 'manifestChunk',
        common,
        totalManifestLength,
        chunkOffset,
        manifestSha256: fixed(bytes, 20, 32),
        chunk: fixed(bytes, 52, chunkLength),
      };
    }
    case MESSAGE.eof:
      requireExact(bytes, 92, 'EOF');
      return {
        type: 'eof',
        common: decodeCommon(bytes, messageType),
        finalSequence: bytes.readUInt32LE(12),
        blockCount: bytes.readUInt32LE(16),
        ciphertextLength: bytes.readBigUInt64LE(20),
        ciphertextSha256: fixed(bytes, 28, 32),
        manifestSha256: fixed(bytes, 60, 32),
      };
    case MESSAGE.resumeRequest:
    case MESSAGE.resumeAccept: {
      requireExact(bytes, 96, messageType === MESSAGE.resumeRequest ? 'RESUME_REQUEST' : 'RESUME_ACCEPT');
      const windowPackets = bytes.readUInt16LE(92);
      const dataPayloadBytes = bytes.readUInt16LE(94);
      requireWindow(windowPackets, dataPayloadBytes);
      return {
        type: messageType === MESSAGE.resumeRequest ? 'resumeRequest' : 'resumeAccept',
        common: decodeCommon(bytes, messageType),
        uploadSessionUuid: fixed(bytes, 12, 16),
        recordingUuid: fixed(bytes, 28, 16),
        recordingGeneration: bytes.readUInt32LE(44),
        checkpointRevision: bytes.readUInt32LE(48),
        nextCiphertextOffset: bytes.readBigUInt64LE(52),
        prefixSha256: fixed(bytes, 60, 32),
        windowPackets,
        dataPayloadBytes,
      };
    }
    case MESSAGE.resumeReject:
      requireExact(bytes, 60, 'RESUME_REJECT');
      requireZero(bytes, 14, 2, 'RESUME_REJECT reserved bytes');
      return {
        type: 'resumeReject',
        common: decodeCommon(bytes, messageType),
        reason: bytes.readUInt16LE(12),
        checkpointRevision: bytes.readUInt32LE(16),
        nextCiphertextOffset: bytes.readBigUInt64LE(20),
        prefixSha256: fixed(bytes, 28, 32),
      };
    case MESSAGE.confirm:
      requireExact(bytes, 84, 'CONFIRM');
      return {
        type: 'confirm',
        common: decodeCommon(bytes, messageType),
        uploadSessionUuid: fixed(bytes, 12, 16),
        recordingUuid: fixed(bytes, 28, 16),
        recordingGeneration: bytes.readUInt32LE(44),
        ownerRevision: bytes.readUInt32LE(48),
        receiptSha256: fixed(bytes, 52, 32),
      };
    case MESSAGE.abort:
      requireExact(bytes, 16, 'ABORT');
      requireZero(bytes, 14, 2, 'ABORT reserved bytes');
      return {
        type: 'abort',
        common: decodeCommon(bytes, messageType),
        reason: bytes.readUInt16LE(12),
      };
    case MESSAGE.error:
      requireExact(bytes, 20, 'ERROR');
      requireZero(bytes, 15, 1, 'ERROR reserved byte');
      return {
        type: 'error',
        common: decodeCommon(bytes, messageType),
        result: bytes.readUInt16LE(12),
        failedMessageType: bytes[14],
        checkpointRevision: bytes.readUInt32LE(16),
      };
    default:
      fail('unsupported_version', `unknown transfer message ${messageType}`);
  }
}

export function encodeEncryptedUploadV2Transfer(value: EncryptedUploadV2Transfer): Buffer {
  switch (value.type) {
    case 'list': {
      if (value.requestFlags !== 0) fail('noncanonical_encoding', 'LIST request flags must be zero');
      const bytes = encodeCommon(value.common, MESSAGE.list, 16);
      bytes.writeUInt32LE(value.requestFlags, 12);
      return bytes;
    }
    case 'recordingEntry': {
      if (value.storageFormat !== 3 || value.completionState !== 1) {
        fail('noncanonical_encoding', 'RECORDING_ENTRY is not committed bota_enc_v2');
      }
      const bytes = encodeCommon(value.common, MESSAGE.recordingEntry, 96);
      putFixed(bytes, 12, value.recordingUuid, 16, 'recording UUID');
      bytes.writeUInt32LE(value.recordingGeneration, 28);
      bytes[32] = value.storageFormat;
      bytes[33] = value.completionState;
      bytes.writeBigUInt64LE(value.startedAt, 36);
      bytes.writeUInt32LE(value.durationSeconds, 44);
      bytes.writeBigUInt64LE(value.plaintextLength, 48);
      bytes.writeBigUInt64LE(value.ciphertextLength, 56);
      putFixed(bytes, 64, value.ciphertextSha256, 32, 'ciphertext SHA-256');
      return bytes;
    }
    case 'recordingListEnd': {
      const bytes = encodeCommon(value.common, MESSAGE.recordingListEnd, 52);
      bytes.writeUInt32LE(value.count, 12);
      bytes.writeUInt32LE(value.listRevision, 16);
      putFixed(bytes, 20, value.listSha256, 32, 'recording list SHA-256');
      return bytes;
    }
    case 'start': {
      requireWindow(value.windowPackets, value.dataPayloadBytes);
      const bytes = encodeCommon(value.common, MESSAGE.start, 128);
      putFixed(bytes, 12, value.uploadSessionUuid, 16, 'upload session UUID');
      putFixed(bytes, 28, value.recordingUuid, 16, 'recording UUID');
      bytes.writeUInt32LE(value.recordingGeneration, 44);
      putFixed(bytes, 48, value.authorizationSha256, 32, 'authorization SHA-256');
      bytes.writeUInt32LE(value.checkpointRevision, 80);
      bytes.writeBigUInt64LE(value.nextCiphertextOffset, 84);
      putFixed(bytes, 92, value.prefixSha256, 32, 'prefix SHA-256');
      bytes.writeUInt16LE(value.windowPackets, 124);
      bytes.writeUInt16LE(value.dataPayloadBytes, 126);
      return bytes;
    }
    case 'startAck': {
      requireWindow(value.windowPackets, value.dataPayloadBytes);
      if (value.checkpointIntervalBlocks === 0) {
        fail('invalid_length', 'START_ACK checkpoint interval must be nonzero');
      }
      const bytes = encodeCommon(value.common, MESSAGE.startAck, 140);
      putFixed(bytes, 12, value.uploadSessionUuid, 16, 'upload session UUID');
      putFixed(bytes, 28, value.recordingUuid, 16, 'recording UUID');
      bytes.writeUInt32LE(value.recordingGeneration, 44);
      bytes.writeBigUInt64LE(value.ciphertextLength, 48);
      putFixed(bytes, 56, value.ciphertextSha256, 32, 'ciphertext SHA-256');
      bytes.writeUInt16LE(value.windowPackets, 88);
      bytes.writeUInt16LE(value.dataPayloadBytes, 90);
      bytes.writeUInt32LE(value.checkpointIntervalBlocks, 92);
      bytes.writeUInt32LE(value.checkpointRevision, 96);
      bytes.writeBigUInt64LE(value.nextCiphertextOffset, 100);
      putFixed(bytes, 108, value.prefixSha256, 32, 'prefix SHA-256');
      return bytes;
    }
    case 'data': {
      requireU16(value.data.byteLength, 'DATA payload length');
      if (value.data.byteLength === 0 || 28 + value.data.byteLength > MAX_FRAME_LENGTH) {
        fail('invalid_length', 'DATA payload length is not canonical');
      }
      const bytes = encodeCommon(value.common, MESSAGE.data, 28 + value.data.byteLength);
      bytes.writeUInt32LE(value.sequence, 12);
      bytes.writeBigUInt64LE(value.offset, 16);
      bytes.writeUInt16LE(value.data.byteLength, 24);
      Buffer.from(value.data).copy(bytes, 28);
      return bytes;
    }
    case 'windowEnd': {
      if (value.firstSequence > value.lastSequence) {
        fail('invalid_length', 'WINDOW_END first sequence exceeds last sequence');
      }
      const bytes = encodeCommon(value.common, MESSAGE.windowEnd, 68);
      bytes.writeUInt32LE(value.windowIndex, 12);
      bytes.writeUInt32LE(value.firstSequence, 16);
      bytes.writeUInt32LE(value.lastSequence, 20);
      bytes.writeBigUInt64LE(value.nextCiphertextOffset, 24);
      putFixed(bytes, 32, value.prefixSha256, 32, 'prefix SHA-256');
      bytes.writeUInt32LE(value.checkpointRevision, 64);
      return bytes;
    }
    case 'windowAck': {
      requireU16(value.missingSequences.length, 'WINDOW_ACK missing count');
      const length = 68 + value.missingSequences.length * 4;
      if (length > MAX_FRAME_LENGTH) fail('invalid_length', 'WINDOW_ACK exceeds maximum frame length');
      const bytes = encodeCommon(value.common, MESSAGE.windowAck, length);
      bytes.writeUInt32LE(value.windowIndex, 12);
      bytes.writeUInt32LE(value.highestContiguousSequence, 16);
      bytes.writeBigUInt64LE(value.nextCiphertextOffset, 20);
      putFixed(bytes, 28, value.prefixSha256, 32, 'prefix SHA-256');
      bytes.writeUInt32LE(value.checkpointRevision, 60);
      bytes.writeUInt16LE(value.missingSequences.length, 64);
      value.missingSequences.forEach((sequence, index) => bytes.writeUInt32LE(sequence, 68 + index * 4));
      return bytes;
    }
    case 'manifestChunk': {
      requireU16(value.chunk.byteLength, 'MANIFEST_CHUNK length');
      if (
        value.totalManifestLength !== 580 ||
        value.chunk.byteLength === 0 ||
        value.chunkOffset + value.chunk.byteLength > value.totalManifestLength ||
        52 + value.chunk.byteLength > MAX_FRAME_LENGTH
      ) {
        fail('invalid_length', 'MANIFEST_CHUNK range is not canonical');
      }
      const bytes = encodeCommon(value.common, MESSAGE.manifestChunk, 52 + value.chunk.byteLength);
      bytes.writeUInt16LE(value.totalManifestLength, 12);
      bytes.writeUInt16LE(value.chunkOffset, 14);
      bytes.writeUInt16LE(value.chunk.byteLength, 16);
      putFixed(bytes, 20, value.manifestSha256, 32, 'manifest SHA-256');
      Buffer.from(value.chunk).copy(bytes, 52);
      return bytes;
    }
    case 'eof': {
      const bytes = encodeCommon(value.common, MESSAGE.eof, 92);
      bytes.writeUInt32LE(value.finalSequence, 12);
      bytes.writeUInt32LE(value.blockCount, 16);
      bytes.writeBigUInt64LE(value.ciphertextLength, 20);
      putFixed(bytes, 28, value.ciphertextSha256, 32, 'ciphertext SHA-256');
      putFixed(bytes, 60, value.manifestSha256, 32, 'manifest SHA-256');
      return bytes;
    }
    case 'resumeRequest':
    case 'resumeAccept': {
      requireWindow(value.windowPackets, value.dataPayloadBytes);
      const message = value.type === 'resumeRequest' ? MESSAGE.resumeRequest : MESSAGE.resumeAccept;
      const bytes = encodeCommon(value.common, message, 96);
      putFixed(bytes, 12, value.uploadSessionUuid, 16, 'upload session UUID');
      putFixed(bytes, 28, value.recordingUuid, 16, 'recording UUID');
      bytes.writeUInt32LE(value.recordingGeneration, 44);
      bytes.writeUInt32LE(value.checkpointRevision, 48);
      bytes.writeBigUInt64LE(value.nextCiphertextOffset, 52);
      putFixed(bytes, 60, value.prefixSha256, 32, 'prefix SHA-256');
      bytes.writeUInt16LE(value.windowPackets, 92);
      bytes.writeUInt16LE(value.dataPayloadBytes, 94);
      return bytes;
    }
    case 'resumeReject': {
      const bytes = encodeCommon(value.common, MESSAGE.resumeReject, 60);
      bytes.writeUInt16LE(value.reason, 12);
      bytes.writeUInt32LE(value.checkpointRevision, 16);
      bytes.writeBigUInt64LE(value.nextCiphertextOffset, 20);
      putFixed(bytes, 28, value.prefixSha256, 32, 'prefix SHA-256');
      return bytes;
    }
    case 'confirm': {
      const bytes = encodeCommon(value.common, MESSAGE.confirm, 84);
      putFixed(bytes, 12, value.uploadSessionUuid, 16, 'upload session UUID');
      putFixed(bytes, 28, value.recordingUuid, 16, 'recording UUID');
      bytes.writeUInt32LE(value.recordingGeneration, 44);
      bytes.writeUInt32LE(value.ownerRevision, 48);
      putFixed(bytes, 52, value.receiptSha256, 32, 'receipt SHA-256');
      return bytes;
    }
    case 'abort': {
      const bytes = encodeCommon(value.common, MESSAGE.abort, 16);
      bytes.writeUInt16LE(value.reason, 12);
      return bytes;
    }
    case 'error': {
      const bytes = encodeCommon(value.common, MESSAGE.error, 20);
      bytes.writeUInt16LE(value.result, 12);
      bytes[14] = value.failedMessageType;
      bytes.writeUInt32LE(value.checkpointRevision, 16);
      return bytes;
    }
  }
}
