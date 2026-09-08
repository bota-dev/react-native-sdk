import { Buffer } from 'buffer';
import type { Hash } from 'crypto';
import {
  EncryptedUploadV2RuntimeError,
  throwIfEncryptedUploadV2Cancelled,
  type EncryptedUploadV2Checkpoint,
  type EncryptedUploadV2CiphertextSink,
} from '../protocol/encryptedUploadV2Runtime';

/** Host-owned, app-private file. flush MUST durably synchronize previous writes
 * (fsync/FileHandle.synchronize/FileDescriptor.sync), not just close a JS stream.
 * Calls are serialized by the transfer receiver. Never back this with plaintext. */
export interface EncryptedUploadV2File {
  size(): Promise<number>;
  truncate(length: number): Promise<void>;
  write(offset: number, bytes: Buffer): Promise<void>;
  read(offset: number, length: number): Promise<Buffer>;
  flush(): Promise<void>;
}

const HASH_CHUNK_BYTES = 64 * 1024;

/** Bounded-memory ciphertext sink. The host retains the file through uncertain
 * confirmation and removes it only after SDK completion or explicit cancellation. */
export class EncryptedUploadV2FileSink implements EncryptedUploadV2CiphertextSink {
  private prepared = false;
  private hash?: Hash;
  private hashedLength = 0;

  constructor(
    private readonly file: EncryptedUploadV2File,
    private readonly maximumLength: bigint
  ) {
    if (maximumLength <= 0n || maximumLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new EncryptedUploadV2RuntimeError('encrypted_upload_v2_invalid_configuration');
    }
  }

  private offset(value: bigint): number {
    if (value < 0n || value > this.maximumLength) {
      throw new EncryptedUploadV2RuntimeError('encrypted_upload_v2_integrity_mismatch');
    }
    return Number(value);
  }

  async prepare(checkpoint: EncryptedUploadV2Checkpoint, signal?: AbortSignal): Promise<void> {
    this.prepared = false;
    throwIfEncryptedUploadV2Cancelled(signal);
    const length = this.offset(checkpoint.nextCiphertextOffset);
    const size = await this.byteLength(signal);
    if (size < checkpoint.nextCiphertextOffset || checkpoint.prefixSha256.length !== 32) {
      throw new EncryptedUploadV2RuntimeError('encrypted_upload_v2_checkpoint_mismatch');
    }
    const digest = await this.sha256Prefix(checkpoint.nextCiphertextOffset, signal);
    if (!digest.equals(checkpoint.prefixSha256)) {
      throw new EncryptedUploadV2RuntimeError('encrypted_upload_v2_checkpoint_mismatch');
    }
    throwIfEncryptedUploadV2Cancelled(signal);
    if (size !== checkpoint.nextCiphertextOffset) await this.file.truncate(length);
    await this.file.flush();
    throwIfEncryptedUploadV2Cancelled(signal);
    this.prepared = true;
  }

  async write(offset: bigint, bytes: Buffer, signal?: AbortSignal): Promise<void> {
    throwIfEncryptedUploadV2Cancelled(signal);
    if (!this.prepared) {
      throw new EncryptedUploadV2RuntimeError('encrypted_upload_v2_not_prepared');
    }
    this.offset(offset + BigInt(bytes.length));
    if (offset < BigInt(this.hashedLength)) this.hash = undefined;
    await this.file.write(this.offset(offset), bytes);
    throwIfEncryptedUploadV2Cancelled(signal);
  }

  async byteLength(signal?: AbortSignal): Promise<bigint> {
    throwIfEncryptedUploadV2Cancelled(signal);
    const size = await this.file.size();
    throwIfEncryptedUploadV2Cancelled(signal);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new EncryptedUploadV2RuntimeError('encrypted_upload_v2_integrity_mismatch');
    }
    this.offset(BigInt(size));
    return BigInt(size);
  }

  async sha256Prefix(length: bigint, signal?: AbortSignal): Promise<Buffer> {
    throwIfEncryptedUploadV2Cancelled(signal);
    const count = this.offset(length);
    if (length > await this.byteLength(signal)) {
      throw new EncryptedUploadV2RuntimeError('encrypted_upload_v2_integrity_mismatch');
    }
    // The digest is returned to the receiver before it persists the checkpoint
    // and sends WINDOW_ACK, so durable file synchronization belongs HERE.
    await this.file.flush();
    throwIfEncryptedUploadV2Cancelled(signal);
    if (!this.hash || count < this.hashedLength) {
      const crypto = require('react-native-quick-crypto') as typeof import('crypto');
      this.hash = crypto.createHash('sha256');
      this.hashedLength = 0;
    }
    // Windows extend a proven prefix. Keep an incremental hash instead of
    // rereading the entire file at every ACK (quadratic work on long recordings).
    for (let offset = this.hashedLength; offset < count; offset += HASH_CHUNK_BYTES) {
      const size = Math.min(HASH_CHUNK_BYTES, count - offset);
      const bytes = await this.file.read(offset, size);
      throwIfEncryptedUploadV2Cancelled(signal);
      if (bytes.length !== size) {
        throw new EncryptedUploadV2RuntimeError('encrypted_upload_v2_integrity_mismatch');
      }
      this.hash.update(bytes);
      this.hashedLength += size;
    }
    return Buffer.from(this.hash.copy().digest());
  }
}
