import { Buffer } from 'buffer';

import {
  decodeEncryptedUploadV2Transfer,
  encodeEncryptedUploadV2Transfer,
} from './encryptedUploadV2';

export interface EncryptedUploadV2Checkpoint {
  revision: number;
  nextCiphertextOffset: bigint;
  prefixSha256: Buffer;
  highestContiguousSequence?: number;
}

export interface EncryptedUploadV2TransferEvidence {
  ciphertextLength: bigint;
  ciphertextSha256: Buffer;
  manifestLength: 580;
  manifestSha256: Buffer;
  blockCount: number;
}

/**
 * Opaque ciphertext destination. Implementations may use memory or a protected
 * native file, but must never decrypt or reinterpret the bytes.
 */
export interface EncryptedUploadV2CiphertextSink {
  prepare(checkpoint: EncryptedUploadV2Checkpoint, signal?: AbortSignal): Promise<void>;
  write(offset: bigint, bytes: Buffer, signal?: AbortSignal): Promise<void>;
  byteLength(signal?: AbortSignal): Promise<bigint>;
  sha256Prefix(length: bigint, signal?: AbortSignal): Promise<Buffer>;
}

export type EncryptedUploadV2ReceiverAction =
  | { type: 'none' }
  | { type: 'control'; frame: Buffer }
  | {
      type: 'complete';
      manifest: Buffer;
      evidence: EncryptedUploadV2TransferEvidence;
    };

export type EncryptedUploadV2RuntimeErrorCode =
  | 'encrypted_upload_v2_invalid_configuration'
  | 'encrypted_upload_v2_operation_in_progress'
  | 'encrypted_upload_v2_cancelled'
  | 'encrypted_upload_v2_not_prepared'
  | 'encrypted_upload_v2_session_mismatch'
  | 'encrypted_upload_v2_packet_conflict'
  | 'encrypted_upload_v2_malformed_window'
  | 'encrypted_upload_v2_too_many_missing_sequences'
  | 'encrypted_upload_v2_checkpoint_mismatch'
  | 'encrypted_upload_v2_confirmation_uncertain'
  | 'encrypted_upload_v2_manifest_conflict'
  | 'encrypted_upload_v2_integrity_mismatch'
  | 'encrypted_upload_v2_unexpected_message'
  | 'encrypted_upload_v2_device_error';

export class EncryptedUploadV2RuntimeError extends Error {
  constructor(
    readonly code: EncryptedUploadV2RuntimeErrorCode,
    readonly protocolStatus?: number,
    readonly underlyingError?: unknown
  ) {
    super(code);
    this.name = 'EncryptedUploadV2RuntimeError';
  }
}

interface PacketMetadata {
  offset: bigint;
  length: bigint;
  sha256: Buffer;
}

interface PendingWindow {
  windowIndex: number;
  firstSequence: number;
  lastSequence: number;
  checkpointRevision: number;
  nextCiphertextOffset: bigint;
  prefixSha256: Buffer;
  missingSequences: number[];
}

interface ReceiverOptions {
  transportSessionId: bigint;
  expectedCiphertextLength: bigint;
  expectedCiphertextSha256: Buffer;
  maximumDataPayloadBytes: number;
  maximumWindowPackets: number;
  maximumMissingSequences: number;
  checkpoint: EncryptedUploadV2Checkpoint;
  sink: EncryptedUploadV2CiphertextSink;
  signal?: AbortSignal;
  persistCheckpoint: (checkpoint: EncryptedUploadV2Checkpoint) => Promise<void>;
}

const MANIFEST_LENGTH = 580;

/** Stateful batch-v2 receiver. It owns framing checks, window repair, and the
 * persist-before-ACK invariant; BLE subscription ownership stays in
 * ProtocolHandler. */
export class EncryptedUploadV2TransferReceiver {
  private checkpoint: EncryptedUploadV2Checkpoint;
  private readonly packets = new Map<number, PacketMetadata>();
  private pendingWindow?: PendingWindow;
  private readonly manifest = Buffer.alloc(MANIFEST_LENGTH);
  private readonly manifestPresent = new Array<boolean>(MANIFEST_LENGTH).fill(false);
  private manifestSha256?: Buffer;
  private prepared = false;
  private terminal = false;

  constructor(private readonly options: ReceiverOptions) {
    this.checkpoint = copyCheckpoint(options.checkpoint);
    if (
      options.transportSessionId === 0n ||
      options.expectedCiphertextLength <= 0n ||
      options.expectedCiphertextSha256.length !== 32 ||
      options.maximumDataPayloadBytes <= 0 ||
      options.maximumWindowPackets <= 0 ||
      options.maximumMissingSequences <= 0 ||
      options.checkpoint.nextCiphertextOffset > options.expectedCiphertextLength ||
      options.checkpoint.prefixSha256.length !== 32 ||
      ((options.checkpoint.nextCiphertextOffset === 0n) !==
        (options.checkpoint.highestContiguousSequence === undefined))
    ) {
      fail('encrypted_upload_v2_invalid_configuration');
    }
  }

  async prepare(): Promise<void> {
    throwIfEncryptedUploadV2Cancelled(this.options.signal);
    await this.options.sink.prepare(copyCheckpoint(this.checkpoint), this.options.signal);
    throwIfEncryptedUploadV2Cancelled(this.options.signal);
    if (
      (await this.options.sink.byteLength(this.options.signal)) !== this.checkpoint.nextCiphertextOffset ||
      !secureEqual(
        await this.options.sink.sha256Prefix(
          this.checkpoint.nextCiphertextOffset,
          this.options.signal
        ),
        this.checkpoint.prefixSha256
      )
    ) {
      fail('encrypted_upload_v2_integrity_mismatch');
    }
    this.prepared = true;
  }

  async receive(rawValue: Uint8Array): Promise<EncryptedUploadV2ReceiverAction> {
    throwIfEncryptedUploadV2Cancelled(this.options.signal);
    if (!this.prepared || this.terminal) {
      fail('encrypted_upload_v2_not_prepared');
    }
    try {
      const value = decodeEncryptedUploadV2Transfer(rawValue);
      if (value.common.transportSessionId !== this.options.transportSessionId) {
        fail('encrypted_upload_v2_session_mismatch');
      }
      switch (value.type) {
        case 'data':
          await this.receiveData(value.sequence, value.offset, value.data);
          return { type: 'none' };
        case 'windowEnd':
          return this.receiveWindowEnd(value);
        case 'manifestChunk':
          this.receiveManifest(
            value.totalManifestLength,
            value.chunkOffset,
            value.manifestSha256,
            value.chunk
          );
          return { type: 'none' };
        case 'eof':
          return this.receiveEof(
            value.finalSequence,
            value.blockCount,
            value.ciphertextLength,
            value.ciphertextSha256,
            value.manifestSha256
          );
        case 'error':
          throw new EncryptedUploadV2RuntimeError(
            'encrypted_upload_v2_device_error',
            value.result
          );
        default:
          fail('encrypted_upload_v2_unexpected_message');
      }
    } catch (error) {
      this.terminal = true;
      throw error;
    }
  }

  private async receiveData(sequence: number, offset: bigint, data: Buffer): Promise<void> {
    const endOffset = offset + BigInt(data.length);
    if (
      data.length === 0 ||
      data.length > this.options.maximumDataPayloadBytes ||
      offset < this.checkpoint.nextCiphertextOffset ||
      endOffset > this.options.expectedCiphertextLength
    ) {
      fail('encrypted_upload_v2_unexpected_message');
    }
    const metadata: PacketMetadata = {
      offset,
      length: BigInt(data.length),
      sha256: await sha256FromSinkBytes(data),
    };
    const existing = this.packets.get(sequence);
    if (existing) {
      if (
        existing.offset !== metadata.offset ||
        existing.length !== metadata.length ||
        !secureEqual(existing.sha256, metadata.sha256)
      ) {
        fail('encrypted_upload_v2_packet_conflict');
      }
      return;
    }
    if (
      this.packets.size >= this.options.maximumWindowPackets ||
      [...this.packets.values()].some((packet) => overlaps(packet, metadata))
    ) {
      fail('encrypted_upload_v2_packet_conflict');
    }
    await this.options.sink.write(offset, Buffer.from(data), this.options.signal);
    throwIfEncryptedUploadV2Cancelled(this.options.signal);
    this.packets.set(sequence, metadata);
  }

  private async receiveWindowEnd(value: {
    windowIndex: number;
    firstSequence: number;
    lastSequence: number;
    nextCiphertextOffset: bigint;
    prefixSha256: Buffer;
    checkpointRevision: number;
  }): Promise<EncryptedUploadV2ReceiverAction> {
    const expectedFirst = this.checkpoint.highestContiguousSequence === undefined
      ? value.firstSequence
      : this.checkpoint.highestContiguousSequence + 1;
    const span = value.lastSequence - value.firstSequence + 1;
    if (
      value.firstSequence > value.lastSequence ||
      value.firstSequence !== expectedFirst ||
      value.checkpointRevision <= this.checkpoint.revision ||
      value.nextCiphertextOffset <= this.checkpoint.nextCiphertextOffset ||
      value.nextCiphertextOffset > this.options.expectedCiphertextLength ||
      value.prefixSha256.length !== 32 ||
      span > this.options.maximumWindowPackets ||
      [...this.packets.keys()].some(
        (sequence) => sequence < value.firstSequence || sequence > value.lastSequence
      )
    ) {
      fail('encrypted_upload_v2_malformed_window');
    }

    const missingSequences: number[] = [];
    for (let sequence = value.firstSequence; sequence <= value.lastSequence; sequence += 1) {
      if (!this.packets.has(sequence)) missingSequences.push(sequence);
    }
    if (missingSequences.length > this.options.maximumMissingSequences) {
      fail('encrypted_upload_v2_too_many_missing_sequences');
    }

    let contiguousOffset = this.checkpoint.nextCiphertextOffset;
    let highestContiguousSequence = value.firstSequence === 0 ? 0 : value.firstSequence - 1;
    for (let sequence = value.firstSequence; sequence <= value.lastSequence; sequence += 1) {
      const packet = this.packets.get(sequence);
      if (!packet) break;
      if (packet.offset !== contiguousOffset) {
        fail('encrypted_upload_v2_malformed_window');
      }
      contiguousOffset += packet.length;
      highestContiguousSequence = sequence;
    }
    const contiguousSha256 = await this.options.sink.sha256Prefix(
      contiguousOffset,
      this.options.signal
    );
    throwIfEncryptedUploadV2Cancelled(this.options.signal);
    this.pendingWindow = {
      ...value,
      missingSequences,
    };

    if (missingSequences.length > 0) {
      return {
        type: 'control',
        frame: encodeEncryptedUploadV2Transfer({
          type: 'windowAck',
          common: common(0x21, this.options.transportSessionId),
          windowIndex: value.windowIndex,
          highestContiguousSequence,
          nextCiphertextOffset: contiguousOffset,
          prefixSha256: contiguousSha256,
          checkpointRevision: this.checkpoint.revision,
          missingSequences,
        }),
      };
    }
    if (
      contiguousOffset !== value.nextCiphertextOffset ||
      !secureEqual(contiguousSha256, value.prefixSha256)
    ) {
      fail('encrypted_upload_v2_integrity_mismatch');
    }
    const nextCheckpoint: EncryptedUploadV2Checkpoint = {
      revision: value.checkpointRevision,
      nextCiphertextOffset: value.nextCiphertextOffset,
      prefixSha256: Buffer.from(value.prefixSha256),
      highestContiguousSequence: value.lastSequence,
    };
    await this.options.persistCheckpoint(copyCheckpoint(nextCheckpoint));
    throwIfEncryptedUploadV2Cancelled(this.options.signal);
    this.checkpoint = nextCheckpoint;
    this.packets.clear();
    this.pendingWindow = undefined;
    return {
      type: 'control',
      frame: encodeEncryptedUploadV2Transfer({
        type: 'windowAck',
        common: common(0x21, this.options.transportSessionId),
        windowIndex: value.windowIndex,
        highestContiguousSequence: value.lastSequence,
        nextCiphertextOffset: value.nextCiphertextOffset,
        prefixSha256: value.prefixSha256,
        checkpointRevision: value.checkpointRevision,
        missingSequences: [],
      }),
    };
  }

  private receiveManifest(
    totalLength: number,
    offset: number,
    manifestSha256: Buffer,
    chunk: Buffer
  ): void {
    const end = offset + chunk.length;
    if (
      this.pendingWindow ||
      this.packets.size > 0 ||
      totalLength !== MANIFEST_LENGTH ||
      manifestSha256.length !== 32 ||
      chunk.length === 0 ||
      end > MANIFEST_LENGTH ||
      (this.manifestSha256 && !secureEqual(this.manifestSha256, manifestSha256))
    ) {
      fail('encrypted_upload_v2_manifest_conflict');
    }
    for (let index = 0; index < chunk.length; index += 1) {
      const target = offset + index;
      if (this.manifestPresent[target] && this.manifest[target] !== chunk[index]) {
        fail('encrypted_upload_v2_manifest_conflict');
      }
      this.manifest[target] = chunk[index];
      this.manifestPresent[target] = true;
    }
    this.manifestSha256 = Buffer.from(manifestSha256);
  }

  private async receiveEof(
    finalSequence: number,
    blockCount: number,
    ciphertextLength: bigint,
    ciphertextSha256: Buffer,
    manifestSha256: Buffer
  ): Promise<EncryptedUploadV2ReceiverAction> {
    const manifestDigest = await sha256FromSinkBytes(this.manifest);
    if (
      this.pendingWindow ||
      this.packets.size > 0 ||
      this.checkpoint.highestContiguousSequence !== finalSequence ||
      blockCount === 0 ||
      ciphertextLength !== this.options.expectedCiphertextLength ||
      !secureEqual(ciphertextSha256, this.options.expectedCiphertextSha256) ||
      !this.manifestSha256 ||
      !secureEqual(manifestSha256, this.manifestSha256) ||
      this.manifestPresent.some((present) => !present) ||
      !secureEqual(manifestDigest, manifestSha256) ||
      (await this.options.sink.byteLength(this.options.signal)) !== this.options.expectedCiphertextLength ||
      !secureEqual(
        await this.options.sink.sha256Prefix(
          this.options.expectedCiphertextLength,
          this.options.signal
        ),
        this.options.expectedCiphertextSha256
      )
    ) {
      fail('encrypted_upload_v2_integrity_mismatch');
    }
    this.terminal = true;
    return {
      type: 'complete',
      manifest: Buffer.from(this.manifest),
      evidence: {
        ciphertextLength,
        ciphertextSha256: Buffer.from(ciphertextSha256),
        manifestLength: MANIFEST_LENGTH,
        manifestSha256: Buffer.from(manifestSha256),
        blockCount,
      },
    };
  }
}

function common(messageType: number, transportSessionId: bigint) {
  return { messageType, flags: 0, transportSessionId };
}

function copyCheckpoint(value: EncryptedUploadV2Checkpoint): EncryptedUploadV2Checkpoint {
  return { ...value, prefixSha256: Buffer.from(value.prefixSha256) };
}

function overlaps(left: PacketMetadata, right: PacketMetadata): boolean {
  return left.offset < right.offset + right.length && right.offset < left.offset + left.length;
}

function secureEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function hashEncryptedUploadV2Bytes(value: Uint8Array): Buffer {
  try {
    // Optional peer dependency; v2 is unavailable when the host has not
    // installed the same crypto provider already used by WiFi provisioning.
    const crypto = require('react-native-quick-crypto') as typeof import('crypto');
    return crypto.createHash('sha256').update(value).digest();
  } catch {
    throw new EncryptedUploadV2RuntimeError('encrypted_upload_v2_invalid_configuration');
  }
}

export function randomEncryptedUploadV2TransportSessionId(): bigint {
  try {
    const crypto = require('react-native-quick-crypto') as typeof import('crypto');
    let value = 0n;
    while (value === 0n) {
      value = crypto.randomBytes(8).readBigUInt64LE(0);
    }
    return value;
  } catch {
    throw new EncryptedUploadV2RuntimeError('encrypted_upload_v2_invalid_configuration');
  }
}

export function randomEncryptedUploadV2WriteId(): number {
  try {
    const crypto = require('react-native-quick-crypto') as typeof import('crypto');
    let value = 0;
    while (value === 0) {
      value = crypto.randomBytes(4).readUInt32LE(0);
    }
    return value;
  } catch {
    throw new EncryptedUploadV2RuntimeError('encrypted_upload_v2_invalid_configuration');
  }
}

function sha256FromSinkBytes(value: Uint8Array): Promise<Buffer> {
  return Promise.resolve(hashEncryptedUploadV2Bytes(value));
}

function fail(code: EncryptedUploadV2RuntimeErrorCode): never {
  throw new EncryptedUploadV2RuntimeError(code);
}

export function throwIfEncryptedUploadV2Cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail('encrypted_upload_v2_cancelled');
}
