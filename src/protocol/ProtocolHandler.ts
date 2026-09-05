/**
 * Protocol Handler - Implements Device-App Protocol for recording transfer
 */

// React Native provides these globals but they're not in "lib": ["ES2020"]
declare function setTimeout(callback: () => void, ms: number): number;
declare function clearTimeout(id: number | undefined): void;

import { Buffer } from 'buffer';
import { Subscription } from 'react-native-ble-plx';

import { getBleManager, BleManager } from '../ble/BleManager';
import {
  SERVICE_BOTA_STORAGE,
  CHAR_STORAGE_INFO,
  CHAR_RECORDING_LIST,
  CHAR_RECORDING_TRANSFER,
  CHAR_TRANSFER_CONTROL,
  CHAR_TRANSFER_STATUS,
  CHAR_STORAGE_TRANSFER_CAPABILITIES_V2,
  CHAR_TRANSFER_SIGNED_BLOB_V2,
  CHAR_TRANSFER_CONTROL_V2,
  CHAR_RECORDING_TRANSFER_V2,
  CHAR_TRANSFER_STATUS_V2,
  CHAR_RECORDING_LIST_V2,
  TRANSFER_PACKET_TIMEOUT,
  STREAMING_PAUSED_TIMEOUT,
} from '../ble/constants';
import {
  parseStorageInfo,
  parseRecordingList,
  parseTransferPacket,
  createAckPacket,
  createTransferCommand,
  parseTriggerDeviceUploadResponse,
} from '../ble/parsers';
import type { TriggerDeviceUploadResponse } from '../ble/parsers';
import type { StorageInfo } from '../models/Device';
import type { DeviceRecording, TransferPacket } from '../models/Recording';
import { TransferError, DeviceError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  decodeEncryptedUploadV2Capabilities,
  decodeEncryptedUploadV2Document,
  decodeEncryptedUploadV2SignedBlob,
  decodeEncryptedUploadV2Transfer,
  encodeEncryptedUploadV2SignedBlob,
  encodeEncryptedUploadV2Transfer,
  type EncryptedUploadV2Capabilities,
  type EncryptedUploadV2Transfer,
} from './encryptedUploadV2';
import {
  EncryptedUploadV2TransferReceiver,
  EncryptedUploadV2RuntimeError,
  hashEncryptedUploadV2Bytes,
  type EncryptedUploadV2Checkpoint,
  type EncryptedUploadV2CiphertextSink,
  type EncryptedUploadV2TransferEvidence,
  throwIfEncryptedUploadV2Cancelled,
} from './encryptedUploadV2Runtime';

const log = logger.tag('ProtocolHandler');

/** Time to wait after EOF for the optional P9.F2 SHA-256 packet to arrive before
 *  finalizing the transfer. Firmware sends it back-to-back with EOF on the same
 *  characteristic; a tight window keeps the resolve fast on old firmware (which
 *  never sends one) while reliably catching the packet on new firmware. */
const SHA256_GRACE_WINDOW_MS = 200;
const ENCRYPTED_UPLOAD_V2_TIMEOUT_MS = 10000;

export interface EncryptedUploadV2CapabilitySnapshot {
  rawValue: Buffer;
  sha256: Buffer;
  capabilities: EncryptedUploadV2Capabilities;
}

export interface EncryptedUploadV2Recording {
  uuid: string;
  generation: number;
  storageFormat: 3;
  startedAt: Date;
  durationMs: number;
  plaintextLength: bigint;
  ciphertextLength: bigint;
  ciphertextSha256: Buffer;
}

export interface EncryptedUploadV2ConfirmRequest {
  transportSessionId: bigint;
  uploadSessionUuid: string;
  recordingUuid: string;
  recordingGeneration: number;
  ownerRevision: number;
  receipt: Buffer;
  maximumSignedBlobBytes: number;
  writeId: number;
  signal?: AbortSignal;
}

export interface EncryptedUploadV2TransferRequest {
  transportSessionId: bigint;
  uploadSessionUuid: string;
  recording: EncryptedUploadV2Recording;
  authorizationSha256: Buffer;
  windowPackets: number;
  dataPayloadBytes: number;
  checkpointIntervalBlocks: number;
  maximumMissingSequences: number;
  checkpoint: EncryptedUploadV2Checkpoint;
  sink: EncryptedUploadV2CiphertextSink;
  signal?: AbortSignal;
  persistCheckpoint: (checkpoint: EncryptedUploadV2Checkpoint) => Promise<void>;
}

export interface EncryptedUploadV2TransferResult {
  manifest: Buffer;
  evidence: EncryptedUploadV2TransferEvidence;
}

/**
 * Transfer state for tracking ongoing transfers
 */
interface TransferState {
  recordingUuid: string;
  expectedSequence: number;
  chunks: Buffer[];
  totalBytes: number;
  isComplete: boolean;
  checksum?: number;
  subscription?: Subscription;
  timeoutId?: number;
  /** P10: set when device sent BOTA_PKT_TYPE_E2E_START at transfer start.
   *  When true, `chunks` holds ciphertext+tag pairs (per chunk) and the
   *  final assembled body is the streaming-AEAD wire format the backend
   *  `/upload-relay` endpoint decrypts. */
  e2eEncrypted?: boolean;
  e2eEphemeralPk?: Buffer;
  e2eSalt?: Buffer;
  /** P9.F2 BLE integrity hash. Set when device sent BOTA_PKT_TYPE_SHA256 after
   *  EOF. Forwarded to the backend on /upload-complete so the server can verify
   *  the assembled S3 object matches the file the device hashed. */
  sha256Hex?: string;
  /** Set to true when EOF arrived. SHA (if any) arrives ≤200ms after EOF; we
   *  hold completion until SHA lands or the grace window expires. */
  eofReceived?: boolean;
  /** Timer that closes the EOF-SHA grace window if no SHA packet arrives. */
  shaGraceTimerId?: number;
}

/**
 * Transfer progress callback
 */
export type TransferProgressCallback = (
  bytesReceived: number,
  totalBytes?: number
) => void;

/**
 * Protocol Handler class
 */
export class ProtocolHandler {
  private bleManager: BleManager;
  private activeTransfers: Map<string, TransferState> = new Map();
  private activeEncryptedUploadV2Transfers: Map<bigint, Subscription> = new Map();

  constructor() {
    this.bleManager = getBleManager();
  }

  /**
   * Get storage info from device
   */
  async getStorageInfo(deviceId: string): Promise<StorageInfo> {
    if (!this.bleManager.isConnected(deviceId)) {
      throw DeviceError.notConnected(deviceId);
    }

    const data = await this.bleManager.readCharacteristic(
      deviceId,
      SERVICE_BOTA_STORAGE,
      CHAR_STORAGE_INFO
    );

    return parseStorageInfo(data);
  }

  /** Read a fresh batch-v2 capability value from its dedicated characteristic. */
  async getEncryptedUploadV2Capabilities(
    deviceId: string
  ): Promise<EncryptedUploadV2CapabilitySnapshot | undefined> {
    if (!this.bleManager.isConnected(deviceId)) {
      throw DeviceError.notConnected(deviceId);
    }
    const present = await this.bleManager.hasCharacteristic(
      deviceId,
      SERVICE_BOTA_STORAGE,
      CHAR_STORAGE_TRANSFER_CAPABILITIES_V2
    );
    if (!present) return undefined;
    const rawValue = await this.bleManager.readCharacteristic(
      deviceId,
      SERVICE_BOTA_STORAGE,
      CHAR_STORAGE_TRANSFER_CAPABILITIES_V2
    );
    return {
      rawValue: Buffer.from(rawValue),
      sha256: hashEncryptedUploadV2Bytes(rawValue),
      capabilities: decodeEncryptedUploadV2Capabilities(rawValue),
    };
  }

  /** List committed bota_enc_v2 recordings with full UUID and generation. */
  async listEncryptedUploadV2Recordings(
    deviceId: string,
    transportSessionId: bigint
  ): Promise<EncryptedUploadV2Recording[]> {
    if (!this.bleManager.isConnected(deviceId)) {
      throw DeviceError.notConnected(deviceId);
    }
    if (transportSessionId === 0n) {
      throw new EncryptedUploadV2RuntimeError(
        'encrypted_upload_v2_invalid_configuration'
      );
    }

    return new Promise((resolve, reject) => {
      const recordings: EncryptedUploadV2Recording[] = [];
      const entryBodies: Buffer[] = [];
      let subscription: Subscription | undefined;
      let timer: number | undefined;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        subscription?.remove();
      };
      const failList = (error: unknown) => {
        cleanup();
        reject(error);
      };

      try {
        subscription = this.bleManager.subscribeToCharacteristic(
          deviceId,
          SERVICE_BOTA_STORAGE,
          CHAR_RECORDING_LIST_V2,
          (rawValue) => {
            try {
              const value = decodeEncryptedUploadV2Transfer(rawValue);
              if (value.common.transportSessionId !== transportSessionId) {
                throw new EncryptedUploadV2RuntimeError(
                  'encrypted_upload_v2_session_mismatch'
                );
              }
              if (value.type === 'recordingEntry') {
                entryBodies.push(Buffer.from(rawValue.subarray(12)));
                recordings.push({
                  uuid: formatFullUuid(value.recordingUuid),
                  generation: value.recordingGeneration,
                  storageFormat: 3,
                  startedAt: new Date(Number(value.startedAt) * 1000),
                  durationMs: value.durationSeconds * 1000,
                  plaintextLength: value.plaintextLength,
                  ciphertextLength: value.ciphertextLength,
                  ciphertextSha256: Buffer.from(value.ciphertextSha256),
                });
                return;
              }
              if (value.type !== 'recordingListEnd') {
                throw new EncryptedUploadV2RuntimeError(
                  'encrypted_upload_v2_unexpected_message'
                );
              }
              const listDigest = hashEncryptedUploadV2Bytes(Buffer.concat(entryBodies));
              if (
                value.count !== recordings.length ||
                !constantTimeEqual(listDigest, value.listSha256)
              ) {
                throw new EncryptedUploadV2RuntimeError(
                  'encrypted_upload_v2_integrity_mismatch'
                );
              }
              cleanup();
              resolve(recordings);
            } catch (error) {
              failList(error);
            }
          },
          (error) => failList(error)
        );
        const frame = encodeEncryptedUploadV2Transfer({
          type: 'list',
          common: { messageType: 0x25, flags: 0, transportSessionId },
          requestFlags: 0,
        });
        timer = setTimeout(() => {
          failList(new TransferError(
            'Timeout waiting for encrypted upload v2 recording list',
            'ENCRYPTED_UPLOAD_V2_LIST_TIMEOUT'
          ));
        }, ENCRYPTED_UPLOAD_V2_TIMEOUT_MS);
        this.bleManager.writeCharacteristic(
          deviceId,
          SERVICE_BOTA_STORAGE,
          CHAR_TRANSFER_CONTROL_V2,
          frame,
          true
        ).catch(failList);
      } catch (error) {
        failList(error);
      }
    });
  }

  /** Deliver one exact signed authorization or receipt over 0407. */
  async sendEncryptedUploadV2Document(
    deviceId: string,
    kind: 1 | 2,
    writeId: number,
    document: Buffer,
    maximumDocumentBytes: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.bleManager.isConnected(deviceId)) {
      throw DeviceError.notConnected(deviceId);
    }
    const documentKind = kind === 1 ? 'authorization' : 'receipt';
    throwIfEncryptedUploadV2Cancelled(signal);
    decodeEncryptedUploadV2Document(documentKind, document);
    if (document.length > maximumDocumentBytes) {
      throw new EncryptedUploadV2RuntimeError(
        'encrypted_upload_v2_invalid_configuration'
      );
    }

    const mtu = await this.bleManager.getMtu(deviceId);
    const maximumFrameBytes = Math.min(512, mtu - 3);
    if (maximumFrameBytes < 42) {
      throw new EncryptedUploadV2RuntimeError(
        'encrypted_upload_v2_invalid_configuration'
      );
    }
    const chunkBytes = maximumFrameBytes - 12;
    let subscription: Subscription | undefined;
    let timer: number | undefined;
    let began = false;
    let resultFinished = false;
    let rejectResult: (error: unknown) => void = () => undefined;

    const result = new Promise<void>((resolve, reject) => {
      rejectResult = reject;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        subscription?.remove();
        resultFinished = true;
      };
      try {
        subscription = this.bleManager.subscribeToCharacteristic(
          deviceId,
          SERVICE_BOTA_STORAGE,
          CHAR_TRANSFER_SIGNED_BLOB_V2,
          (rawValue) => {
            try {
              const value = decodeEncryptedUploadV2SignedBlob(rawValue);
              if (
                value.type !== 'blobResult' ||
                value.kind !== kind ||
                value.writeId !== writeId
              ) return;
              cleanup();
              if (value.result !== 0) {
                reject(new EncryptedUploadV2RuntimeError(
                  'encrypted_upload_v2_device_error',
                  value.result
                ));
                return;
              }
              resolve();
            } catch (error) {
              cleanup();
              reject(error);
            }
          },
          (error) => {
            cleanup();
            reject(error);
          }
        );
      } catch (error) {
        cleanup();
        reject(error);
      }
    });

    try {
      began = true;
      throwIfEncryptedUploadV2Cancelled(signal);
      await this.bleManager.writeCharacteristic(
        deviceId,
        SERVICE_BOTA_STORAGE,
        CHAR_TRANSFER_SIGNED_BLOB_V2,
        encodeEncryptedUploadV2SignedBlob({
          type: 'blobBegin',
          kind,
          writeId,
          totalLength: document.length,
          sha256: hashEncryptedUploadV2Bytes(document),
        }),
        true
      );
      throwIfEncryptedUploadV2Cancelled(signal);
      for (let offset = 0; offset < document.length; offset += chunkBytes) {
        throwIfEncryptedUploadV2Cancelled(signal);
        await this.bleManager.writeCharacteristic(
          deviceId,
          SERVICE_BOTA_STORAGE,
          CHAR_TRANSFER_SIGNED_BLOB_V2,
          encodeEncryptedUploadV2SignedBlob({
            type: 'blobData',
            kind,
            writeId,
            offset,
            data: Buffer.from(document.subarray(offset, offset + chunkBytes)),
          }),
          true
        );
        throwIfEncryptedUploadV2Cancelled(signal);
      }
      await this.bleManager.writeCharacteristic(
        deviceId,
        SERVICE_BOTA_STORAGE,
        CHAR_TRANSFER_SIGNED_BLOB_V2,
        encodeEncryptedUploadV2SignedBlob({ type: 'blobCommit', kind, writeId }),
        true
      );
      throwIfEncryptedUploadV2Cancelled(signal);
      if (!resultFinished) {
        timer = setTimeout(() => {
          subscription?.remove();
          resultFinished = true;
          rejectResult(new TransferError(
            'Timeout waiting for encrypted upload v2 signed document result',
            'ENCRYPTED_UPLOAD_V2_DOCUMENT_TIMEOUT'
          ));
        }, ENCRYPTED_UPLOAD_V2_TIMEOUT_MS);
      }
      await result;
    } catch (error) {
      subscription?.remove();
      if (timer !== undefined) clearTimeout(timer);
      if (began) {
        try {
          await this.bleManager.writeCharacteristic(
            deviceId,
            SERVICE_BOTA_STORAGE,
            CHAR_TRANSFER_SIGNED_BLOB_V2,
            encodeEncryptedUploadV2SignedBlob({ type: 'blobAbort', kind, writeId }),
            true
          );
        } catch {
          // The operation already failed; the caller must reconnect if cleanup is uncertain.
        }
      }
      throw error;
    }
  }

  /** Run one dedicated batch-v2 ciphertext transfer after authorization. */
  async transferEncryptedUploadV2(
    deviceId: string,
    request: EncryptedUploadV2TransferRequest,
    onProgress?: TransferProgressCallback
  ): Promise<EncryptedUploadV2TransferResult> {
    if (!this.bleManager.isConnected(deviceId)) {
      throw DeviceError.notConnected(deviceId);
    }
    if (
      this.activeEncryptedUploadV2Transfers.has(request.transportSessionId) ||
      request.authorizationSha256.length !== 32 ||
      request.recording.storageFormat !== 3
    ) {
      throw new EncryptedUploadV2RuntimeError(
        'encrypted_upload_v2_invalid_configuration'
      );
    }

    const receiver = new EncryptedUploadV2TransferReceiver({
      transportSessionId: request.transportSessionId,
      expectedCiphertextLength: request.recording.ciphertextLength,
      expectedCiphertextSha256: request.recording.ciphertextSha256,
      maximumDataPayloadBytes: request.dataPayloadBytes,
      maximumWindowPackets: request.windowPackets,
      maximumMissingSequences: request.maximumMissingSequences,
      checkpoint: request.checkpoint,
      sink: request.sink,
      signal: request.signal,
      persistCheckpoint: request.persistCheckpoint,
    });
    await receiver.prepare();

    return new Promise((resolve, reject) => {
      let subscription: Subscription | undefined;
      let timer: number | undefined;
      let opened = false;
      let stopping = false;
      let settled = false;
      let processing = Promise.resolve();
      let openingWrite = Promise.resolve();
      let finishOpeningWrite: () => void = () => undefined;
      let pendingNotifications = 0;
      let abortListener: (() => void) | undefined;

      const stopIntake = () => {
        if (timer !== undefined) clearTimeout(timer);
        subscription?.remove();
        if (abortListener) request.signal?.removeEventListener('abort', abortListener);
      };
      const releaseOwnership = () => {
        stopIntake();
        this.activeEncryptedUploadV2Transfers.delete(request.transportSessionId);
      };
      const resetTimer = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          failTransfer(new TransferError(
            'Timeout waiting for encrypted upload v2 transfer data',
            'ENCRYPTED_UPLOAD_V2_TRANSFER_TIMEOUT'
          ));
        }, ENCRYPTED_UPLOAD_V2_TIMEOUT_MS);
      };
      const failTransfer = (error: unknown) => {
        if (stopping || settled) return;
        stopping = true;
        stopIntake();
        void Promise.all([openingWrite, processing]).then(async () => {
          const abort = encodeEncryptedUploadV2Transfer({
            type: 'abort',
            common: {
              messageType: 0x24,
              flags: 0,
              transportSessionId: request.transportSessionId,
            },
            reason: 0x00ff,
          });
          try {
            await this.bleManager.writeCharacteristic(
              deviceId,
              SERVICE_BOTA_STORAGE,
              CHAR_TRANSFER_CONTROL_V2,
              abort,
              true
            );
          } catch {
            // The transfer remains failed; reconnect before starting another owner.
          }
          if (settled) return;
          settled = true;
          releaseOwnership();
          reject(error);
        });
      };

      try {
        subscription = this.bleManager.subscribeToCharacteristic(
          deviceId,
          SERVICE_BOTA_STORAGE,
          CHAR_RECORDING_TRANSFER_V2,
          (rawValue) => {
            if (stopping || settled) return;
            pendingNotifications += 1;
            if (timer !== undefined) {
              clearTimeout(timer);
              timer = undefined;
            }
            processing = processing.then(async () => {
              if (stopping || settled) return;
              const value = decodeEncryptedUploadV2Transfer(rawValue);
              if (value.common.transportSessionId !== request.transportSessionId) {
                throw new EncryptedUploadV2RuntimeError(
                  'encrypted_upload_v2_session_mismatch'
                );
              }
              if (!opened) {
                const resuming = request.checkpoint.nextCiphertextOffset > 0n;
                if (
                  (resuming && value.type !== 'resumeAccept') ||
                  (!resuming && value.type !== 'startAck')
                ) {
                  if (value.type === 'resumeReject') {
                    throw new EncryptedUploadV2RuntimeError(
                      'encrypted_upload_v2_checkpoint_mismatch',
                      value.reason
                    );
                  }
                  if (value.type === 'error') {
                    throw new EncryptedUploadV2RuntimeError(
                      'encrypted_upload_v2_device_error',
                      value.result
                    );
                  }
                  throw new EncryptedUploadV2RuntimeError(
                    'encrypted_upload_v2_unexpected_message'
                  );
                }
                if (value.type !== 'startAck' && value.type !== 'resumeAccept') {
                  throw new EncryptedUploadV2RuntimeError(
                    'encrypted_upload_v2_unexpected_message'
                  );
                }
                validateEncryptedUploadV2Opening(value, request);
                opened = true;
                return;
              }

              const action = await receiver.receive(rawValue);
              if (stopping || settled) return;
              if (value.type === 'data') {
                onProgress?.(
                  Number(value.offset + BigInt(value.data.length)),
                  Number(request.recording.ciphertextLength)
                );
              }
              if (action.type === 'control') {
                await this.bleManager.writeCharacteristic(
                  deviceId,
                  SERVICE_BOTA_STORAGE,
                  CHAR_TRANSFER_CONTROL_V2,
                  action.frame,
                  true
                );
              } else if (action.type === 'complete') {
                if (stopping || settled) return;
                settled = true;
                releaseOwnership();
                resolve({ manifest: action.manifest, evidence: action.evidence });
              }
            }).then(() => {
              pendingNotifications -= 1;
              if (!stopping && !settled && pendingNotifications === 0) resetTimer();
            }).catch((error) => {
              pendingNotifications -= 1;
              failTransfer(error);
            });
          },
          (error) => failTransfer(error),
          { logNotifications: false }
        );
        this.activeEncryptedUploadV2Transfers.set(
          request.transportSessionId,
          subscription
        );
        abortListener = () => failTransfer(
          new EncryptedUploadV2RuntimeError('encrypted_upload_v2_cancelled')
        );
        request.signal?.addEventListener('abort', abortListener, { once: true });
        if (request.signal?.aborted) {
          abortListener();
          return;
        }
        resetTimer();

        const commonHeader = {
          flags: 0,
          transportSessionId: request.transportSessionId,
        };
        const frame = request.checkpoint.nextCiphertextOffset > 0n
          ? encodeEncryptedUploadV2Transfer({
              type: 'resumeRequest',
              common: { ...commonHeader, messageType: 0x22 },
              uploadSessionUuid: parseFullUuid(request.uploadSessionUuid),
              recordingUuid: parseFullUuid(request.recording.uuid),
              recordingGeneration: request.recording.generation,
              checkpointRevision: request.checkpoint.revision,
              nextCiphertextOffset: request.checkpoint.nextCiphertextOffset,
              prefixSha256: request.checkpoint.prefixSha256,
              windowPackets: request.windowPackets,
              dataPayloadBytes: request.dataPayloadBytes,
            })
          : encodeEncryptedUploadV2Transfer({
              type: 'start',
              common: { ...commonHeader, messageType: 0x20 },
              uploadSessionUuid: parseFullUuid(request.uploadSessionUuid),
              recordingUuid: parseFullUuid(request.recording.uuid),
              recordingGeneration: request.recording.generation,
              authorizationSha256: request.authorizationSha256,
              checkpointRevision: request.checkpoint.revision,
              nextCiphertextOffset: request.checkpoint.nextCiphertextOffset,
              prefixSha256: request.checkpoint.prefixSha256,
              windowPackets: request.windowPackets,
              dataPayloadBytes: request.dataPayloadBytes,
            });
        openingWrite = new Promise<void>((resolveOpening) => {
          finishOpeningWrite = resolveOpening;
        });
        this.bleManager.writeCharacteristic(
          deviceId,
          SERVICE_BOTA_STORAGE,
          CHAR_TRANSFER_CONTROL_V2,
          frame,
          true
        ).then(
          () => finishOpeningWrite(),
          (error) => {
            finishOpeningWrite();
            failTransfer(error);
          }
        );
      } catch (error) {
        finishOpeningWrite();
        failTransfer(error);
      }
    });
  }

  async abortEncryptedUploadV2(
    deviceId: string,
    transportSessionId: bigint,
    reason: number = 0x00ff
  ): Promise<void> {
    const frame = encodeEncryptedUploadV2Transfer({
      type: 'abort',
      common: { messageType: 0x24, flags: 0, transportSessionId },
      reason,
    });
    await this.bleManager.writeCharacteristic(
      deviceId,
      SERVICE_BOTA_STORAGE,
      CHAR_TRANSFER_CONTROL_V2,
      frame,
      true
    );
    this.activeEncryptedUploadV2Transfers.get(transportSessionId)?.remove();
    this.activeEncryptedUploadV2Transfers.delete(transportSessionId);
  }

  /** Deliver the exact receipt, then CONFIRM, then wait for device acceptance. */
  async confirmEncryptedUploadV2(
    deviceId: string,
    request: EncryptedUploadV2ConfirmRequest
  ): Promise<void> {
    await this.sendEncryptedUploadV2Document(
      deviceId,
      2,
      request.writeId,
      request.receipt,
      request.maximumSignedBlobBytes,
      request.signal
    );
    throwIfEncryptedUploadV2Cancelled(request.signal);

    let confirmationAttempted = false;
    try {
      await new Promise<void>((resolve, reject) => {
      let subscription: Subscription | undefined;
      let timer: number | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        subscription?.remove();
      };
      try {
        subscription = this.bleManager.subscribeToCharacteristic(
          deviceId,
          SERVICE_BOTA_STORAGE,
          CHAR_TRANSFER_STATUS_V2,
          (status) => {
            try {
              const parsed = parseEncryptedUploadV2Status(status);
              if (parsed.transportSessionId !== request.transportSessionId) return;
              if (parsed.phase === 0x0a || parsed.result !== 0) {
                cleanup();
                reject(new EncryptedUploadV2RuntimeError(
                  'encrypted_upload_v2_device_error',
                  parsed.result
                ));
                return;
              }
              if (parsed.phase === 0x09) {
                cleanup();
                resolve();
              }
            } catch (error) {
              cleanup();
              reject(error);
            }
          },
          (error) => {
            cleanup();
            reject(error);
          }
        );
        const frame = encodeEncryptedUploadV2Transfer({
          type: 'confirm',
          common: {
            messageType: 0x23,
            flags: 0,
            transportSessionId: request.transportSessionId,
          },
          uploadSessionUuid: parseFullUuid(request.uploadSessionUuid),
          recordingUuid: parseFullUuid(request.recordingUuid),
          recordingGeneration: request.recordingGeneration,
          ownerRevision: request.ownerRevision,
          receiptSha256: hashEncryptedUploadV2Bytes(request.receipt),
        });
        throwIfEncryptedUploadV2Cancelled(request.signal);
        timer = setTimeout(() => {
          cleanup();
          reject(new TransferError(
            'Timeout waiting for encrypted upload v2 confirmation',
            'ENCRYPTED_UPLOAD_V2_CONFIRM_TIMEOUT'
          ));
        }, ENCRYPTED_UPLOAD_V2_TIMEOUT_MS);
        confirmationAttempted = true;
        this.bleManager.writeCharacteristic(
          deviceId,
          SERVICE_BOTA_STORAGE,
          CHAR_TRANSFER_CONTROL_V2,
          frame,
          true
        ).catch((error) => {
          cleanup();
          reject(error);
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
      });
    } catch (error) {
      if (
        !confirmationAttempted ||
        (error instanceof EncryptedUploadV2RuntimeError &&
          error.code === 'encrypted_upload_v2_device_error')
      ) {
        throw error;
      }
      throw new EncryptedUploadV2RuntimeError(
        'encrypted_upload_v2_confirmation_uncertain',
        undefined,
        error
      );
    }
  }

  /**
   * List recordings on device
   */
  async listRecordings(deviceId: string): Promise<DeviceRecording[]> {
    if (!this.bleManager.isConnected(deviceId)) {
      throw DeviceError.notConnected(deviceId);
    }

    log.debug('Listing recordings', { deviceId });

    return new Promise((resolve, reject) => {
      let recordings: DeviceRecording[] = [];
      let subscription: Subscription | undefined;
      let timeoutId: number | undefined;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        subscription?.remove();
      };

      // Set up timeout
      timeoutId = setTimeout(() => {
        cleanup();
        // If we received some data, return it; otherwise error
        if (recordings.length > 0) {
          resolve(recordings);
        } else {
          reject(new TransferError(
            'Timeout waiting for recording list',
            'LIST_TIMEOUT'
          ));
        }
      }, 5000);

      // Subscribe to recording list notifications
      log.debug('Subscribing to RECORDING_LIST');
      subscription = this.bleManager.subscribeToCharacteristic(
        deviceId,
        SERVICE_BOTA_STORAGE,
        CHAR_RECORDING_LIST,
        (data) => {
          try {
            log.debug('RecList notify', { len: data.length });
            const parsed = parseRecordingList(data);
            recordings = recordings.concat(parsed);

            // Check if this is the last packet (could check for end marker)
            // For now, wait for timeout or explicit end
          } catch (error) {
            log.error('Failed to parse recording list', error as Error);
          }
        },
        (error) => {
          cleanup();
          reject(error);
        }
      );

      // Send list command
      const command = createTransferCommand('list');
      this.bleManager
        .writeCharacteristic(
          deviceId,
          SERVICE_BOTA_STORAGE,
          CHAR_TRANSFER_CONTROL,
          command
        )
        .catch((error) => {
          cleanup();
          reject(error);
        });
    });
  }

  /**
   * Transfer a recording from device
   * Returns the audio data as a Buffer
   */
  async transferRecording(
    deviceId: string,
    recordingUuid: string,
    onProgress?: TransferProgressCallback
  ): Promise<{ data: Buffer; e2eEncrypted: boolean; sha256?: string }> {
    if (!this.bleManager.isConnected(deviceId)) {
      throw DeviceError.notConnected(deviceId);
    }

    // Check if transfer already in progress
    if (this.activeTransfers.has(recordingUuid)) {
      throw new TransferError(
        'Transfer already in progress for this recording',
        'TRANSFER_IN_PROGRESS',
        recordingUuid
      );
    }

    log.info('Starting recording transfer', { deviceId, recordingUuid });

    return new Promise((resolve, reject) => {
      const state: TransferState = {
        recordingUuid,
        expectedSequence: 0,
        chunks: [],
        totalBytes: 0,
        isComplete: false,
      };

      this.activeTransfers.set(recordingUuid, state);

      const cleanup = () => {
        if (state.timeoutId) clearTimeout(state.timeoutId);
        if (state.shaGraceTimerId) clearTimeout(state.shaGraceTimerId);
        state.subscription?.remove();
        this.activeTransfers.delete(recordingUuid);
      };

      const resetTimeout = () => {
        if (state.timeoutId) clearTimeout(state.timeoutId);
        state.timeoutId = setTimeout(() => {
          cleanup();
          reject(TransferError.timeout(recordingUuid));
        }, TRANSFER_PACKET_TIMEOUT);
      };

      /** Finalize the transfer: CRC-verify, ACK, resolve. Idempotent — guarded
       *  by state.isComplete so EOF-then-SHA and grace-timeout both invoke it
       *  safely. Called by complete() once SHA has landed (or after the grace
       *  window expires with no SHA). */
      const finalize = async (): Promise<void> => {
        if (state.isComplete) return;
        state.isComplete = true;
        if (state.shaGraceTimerId) {
          clearTimeout(state.shaGraceTimerId);
          state.shaGraceTimerId = undefined;
        }
        if (state.timeoutId) clearTimeout(state.timeoutId);

        try {
          const audioData = this.assembleAudioData(state);

          if (state.checksum !== undefined) {
            const calculatedChecksum = this.calculateCrc32(audioData);
            log.debug('CRC32 check', {
              recordingUuid,
              device: `0x${state.checksum.toString(16).padStart(8, '0')}`,
              calculated: `0x${calculatedChecksum.toString(16).padStart(8, '0')}`,
              assembledBytes: audioData.length,
              match: calculatedChecksum === state.checksum,
            });
            if (calculatedChecksum !== state.checksum) {
              await this.sendAck(deviceId, 'nack', 0);
              cleanup();
              reject(TransferError.checksumMismatch(recordingUuid));
              return;
            }
          }

          await this.sendAck(deviceId, 'ack', 0);
          cleanup();

          log.info('Transfer completed', {
            recordingUuid,
            size: audioData.length,
            e2eEncrypted: !!state.e2eEncrypted,
            sha256Prefix: state.sha256Hex?.slice(0, 16) ?? null,
          });

          resolve({
            data: audioData,
            e2eEncrypted: !!state.e2eEncrypted,
            sha256: state.sha256Hex,
          });
        } catch (error) {
          cleanup();
          reject(error);
        }
      };

      // Subscribe to transfer data notifications
      state.subscription = this.bleManager.subscribeToCharacteristic(
        deviceId,
        SERVICE_BOTA_STORAGE,
        CHAR_RECORDING_TRANSFER,
        async (data) => {
          try {
            resetTimeout();

            // Skip ACK echo-back packets (App→Device only, may be echoed by Bluetooth stack)
            const firstByte = data.readUInt8(0);
            if (firstByte >= 0x10 && firstByte <= 0x12) {
              return;
            }

            const packet = parseTransferPacket(data);

            // 'sha256' packet arrives ≤200ms after EOF on P9.F2+ firmware.
            // Store it and finalize immediately — no need to wait for the grace timer.
            if (packet.type === 'sha256' && packet.sha256) {
              state.sha256Hex = Buffer.from(packet.sha256).toString('hex');
              log.debug('SHA-256 packet received', {
                recordingUuid,
                sha256Prefix: state.sha256Hex.slice(0, 16),
              });
              if (state.eofReceived) {
                await finalize();
              }
              return;
            }

            this.handleTransferPacket(state, packet, onProgress);

            if (state.eofReceived && !state.isComplete && !state.shaGraceTimerId) {
              // EOF landed. Open a short grace window for the optional SHA packet
              // that P9.F2 firmware sends right after EOF. Old firmware never
              // sends it — the timer fires and we finalize without a hash.
              state.shaGraceTimerId = setTimeout(() => {
                state.shaGraceTimerId = undefined;
                finalize().catch((err) => {
                  cleanup();
                  reject(err);
                });
              }, SHA256_GRACE_WINDOW_MS);
            }
          } catch (error) {
            cleanup();
            reject(error);
          }
        },
        (error) => {
          cleanup();
          reject(TransferError.interrupted(recordingUuid, error));
        }
      );

      // Send start transfer command
      const command = createTransferCommand('start', recordingUuid);
      this.bleManager
        .writeCharacteristic(
          deviceId,
          SERVICE_BOTA_STORAGE,
          CHAR_TRANSFER_CONTROL,
          command
        )
        .then(() => {
          resetTimeout();
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
    });
  }

  /**
   * Handle a transfer packet from device
   */
  private handleTransferPacket(
    state: TransferState,
    packet: TransferPacket,
    onProgress?: TransferProgressCallback
  ): void {
    switch (packet.type) {
      case 'data':
        if (packet.data) {
          state.chunks.push(Buffer.from(packet.data));
          state.totalBytes += packet.data.length;
          onProgress?.(state.totalBytes);
        }
        break;

      case 'eof':
        state.checksum = packet.checksum;
        // Don't set isComplete here — finalize() runs after a brief grace
        // window so the optional SHA-256 packet (P9.F2 firmware) can land.
        state.eofReceived = true;
        break;

      /* P10 BLE-e2e streaming AEAD. The session-start packet carries the
       * device's ephemeral X25519 pubkey + 4-byte salt. Subsequent
       * encrypted-data packets each hold one ciphertext+tag chunk; we
       * frame them with a 2-byte length prefix so the backend can walk
       * the body without a separate per-chunk count. */
      case 'e2e_start':
        state.e2eEncrypted = true;
        state.e2eEphemeralPk = packet.e2eEphemeralPk
          ? Buffer.from(packet.e2eEphemeralPk)
          : undefined;
        state.e2eSalt = packet.e2eSalt
          ? Buffer.from(packet.e2eSalt)
          : undefined;
        break;

      case 'encrypted_data':
        if (packet.e2eChunk) {
          const ct = Buffer.from(packet.e2eChunk);
          const plainLen = ct.length - 16;  // last 16 bytes are the auth tag
          const lenHdr = Buffer.alloc(2);
          lenHdr.writeUInt16BE(plainLen, 0);
          state.chunks.push(Buffer.concat([lenHdr, ct]));
          state.totalBytes += plainLen;
          onProgress?.(state.totalBytes);
        }
        break;

      case 'encrypted_eof':
        // CRC field unused — per-chunk auth tags cover integrity. Same SHA-256
        // grace window as plaintext path.
        state.eofReceived = true;
        break;

      case 'error':
        throw TransferError.deviceError(
          state.recordingUuid,
          packet.errorCode ?? 0xff
        );
    }
  }

  /**
   * Send an ACK packet to device
   */
  private async sendAck(
    deviceId: string,
    type: 'ack' | 'nack' | 'abort',
    sequenceNumber: number
  ): Promise<void> {
    const ackPacket = createAckPacket(type, sequenceNumber);

    await this.bleManager.writeCharacteristic(
      deviceId,
      SERVICE_BOTA_STORAGE,
      CHAR_TRANSFER_CONTROL,
      ackPacket,
      true // Write with response — JieLi stack requires ATT Write Request
    );
  }

  /**
   * Assemble audio data from received packets.
   *
   * Plaintext path: concatenate chunks back-to-back.
   *
   * P10 encrypted path: prepend the streaming-AEAD header (ephemeral_pk[32]
   * + salt[4]); each accumulated chunk already includes its 2-byte
   * length prefix and 16-byte auth tag so the body matches the wire
   * format that `bleE2EService.decrypt()` parses server-side.
   */
  private assembleAudioData(state: TransferState): Buffer {
    if (state.e2eEncrypted) {
      if (!state.e2eEphemeralPk || !state.e2eSalt) {
        throw new TransferError(
          'E2E transfer missing session header',
          'E2E_NO_SESSION',
          state.recordingUuid
        );
      }
      return Buffer.concat([state.e2eEphemeralPk, state.e2eSalt, ...state.chunks]);
    }
    return Buffer.concat(state.chunks);
  }

  /**
   * Calculate CRC32 checksum
   */
  private calculateCrc32(data: Buffer): number {
    let crc = 0xffffffff;
    const table = this.getCrc32Table();

    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff];
    }

    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * Get CRC32 lookup table (lazy initialized)
   */
  private crc32Table: number[] | null = null;
  private getCrc32Table(): number[] {
    if (this.crc32Table) {
      return this.crc32Table;
    }

    const table: number[] = [];
    for (let i = 0; i < 256; i++) {
      let crc = i;
      for (let j = 0; j < 8; j++) {
        crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
      table.push(crc >>> 0);
    }

    this.crc32Table = table;
    return table;
  }

  /**
   * Confirm sync to device (allows device to delete local copy)
   */
  async confirmSync(deviceId: string, recordingUuid: string): Promise<void> {
    if (!this.bleManager.isConnected(deviceId)) {
      throw DeviceError.notConnected(deviceId);
    }

    log.debug('Confirming sync', { deviceId, recordingUuid });

    const command = createTransferCommand('confirm', recordingUuid);

    await this.bleManager.writeCharacteristic(
      deviceId,
      SERVICE_BOTA_STORAGE,
      CHAR_TRANSFER_CONTROL,
      command
    );
  }

  /**
   * Trigger device-side upload via WiFi/4G.
   * Sends opcode 0x03 to TRANSFER_CONTROL and waits for a 2-byte response
   * on TRANSFER_STATUS (byte[0]=0x03, byte[1]=status).
   * Returns null if firmware doesn't support this command (timeout).
   */
  async triggerDeviceUpload(
    deviceId: string,
  ): Promise<TriggerDeviceUploadResponse | null> {
    if (!this.bleManager.isConnected(deviceId)) {
      throw DeviceError.notConnected(deviceId);
    }

    log.debug('Triggering device-side upload', { deviceId });

    return new Promise<TriggerDeviceUploadResponse | null>(
      (resolve, reject) => {
        let subscription: Subscription | undefined;
        let timer: number | undefined;

        const cleanup = () => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          subscription?.remove();
        };

        // Subscribe to TRANSFER_STATUS for the response
        try {
          subscription = this.bleManager.subscribeToCharacteristic(
            deviceId,
            SERVICE_BOTA_STORAGE,
            CHAR_TRANSFER_STATUS,
            (data: Buffer) => {
              const response = parseTriggerDeviceUploadResponse(data);
              if (response) {
                cleanup();
                resolve(response);
              }
            },
          );

          // Send the trigger command
          const command = createTransferCommand('triggerDeviceUpload');
          this.bleManager
            .writeCharacteristic(
              deviceId,
              SERVICE_BOTA_STORAGE,
              CHAR_TRANSFER_CONTROL,
              command,
            )
            .catch((error: Error) => {
              cleanup();
              reject(error);
            });
        } catch (error) {
          cleanup();
          reject(error);
        }

        // 5s timeout — old firmware won't respond
        timer = setTimeout(() => {
          cleanup();
          log.debug('triggerDeviceUpload timeout (old firmware?)', {
            deviceId,
          });
          resolve(null);
        }, 5000);
      },
    );
  }

  /**
   * Cancel an ongoing transfer
   */
  async cancelTransfer(deviceId: string, recordingUuid: string): Promise<void> {
    const state = this.activeTransfers.get(recordingUuid);
    if (!state) {
      return;
    }

    log.info('Cancelling transfer', { recordingUuid });

    // Send abort
    try {
      await this.sendAck(deviceId, 'abort', state.expectedSequence);
    } catch {
      // Ignore errors during cancellation
    }

    // Clean up
    if (state.timeoutId) clearTimeout(state.timeoutId);
    state.subscription?.remove();
    this.activeTransfers.delete(recordingUuid);
  }

  /**
   * Check if a transfer is in progress
   */
  isTransferInProgress(recordingUuid: string): boolean {
    return this.activeTransfers.has(recordingUuid);
  }

  /**
   * Stream a live recording transfer from device.
   *
   * Unlike transferRecording() which waits for EOF and returns a complete Buffer,
   * this method calls back on every DATA packet and handles PAUSED packets
   * (device caught up to recording write position, waiting for more audio).
   *
   * The transfer completes when an EOF packet is received (recording stopped
   * and all data has been sent).
   *
   * @param onData  - called for each DATA packet with the audio chunk
   * @param onPaused - called when device sends PAUSED (caught up, more data coming)
   * @param onResumed - called when device resumes sending after PAUSED
   * @returns Promise that resolves with { totalBytes, checksum } on EOF
   */
  async streamTransfer(
    deviceId: string,
    recordingUuid: string,
    callbacks: {
      onData: (sequenceNumber: number, data: Buffer) => void;
      onPaused?: (bytesSent: number) => void;
      onResumed?: () => void;
      /** P10: called when the device emits the e2e session-start packet (eph_pk
       *  + salt). Foundation for real-time per-chunk relay — receivers stash
       *  the header and pass it (with chunkSeq) along with each subsequent
       *  encrypted chunk to the backend's /upload-relay/chunk/{seq} endpoint. */
      onE2eStart?: (ephemeralPk: Buffer, salt: Buffer) => void;
      /** P10: called for every encrypted_data packet. `ciphertextWithTag` is
       *  the ChaCha20-Poly1305 ciphertext immediately followed by the 16-byte
       *  AEAD tag. Receivers POST it (chunk 0 prepended with eph_pk + salt by
       *  the session, chunks 1..N raw) for inline backend decrypt + S3 write.
       *  `chunkSeq` is monotonically increasing from 0 across the session and
       *  must be passed to the backend (forms part of the AEAD nonce). */
      onE2eChunk?: (chunkSeq: number, ciphertextWithTag: Buffer) => void;
    }
  ): Promise<{
    totalBytes: number;
    checksum: number;
    sha256?: string;
    /** P10: true when device delivered the stream as e2e-encrypted chunks. */
    e2eEncrypted?: boolean;
    /** P10: number of encrypted_data packets the SDK actually received. */
    e2eChunkCount?: number;
    /** P10: highest packet.sequenceNumber observed (= firmware's last
     *  `g_transfer.e2e_chunk_seq`). Equals `e2eChunkCount - 1` when every
     *  notification arrived in order; less when a notification was silently
     *  dropped between firmware queue + host receive. Use `(e2eMaxSeq + 1)`
     *  as the finalize `total_chunks` — that's the firmware's intended count
     *  the backend stitcher should look for in S3. */
    e2eMaxSeq?: number;
  }> {
    if (!this.bleManager.isConnected(deviceId)) {
      throw DeviceError.notConnected(deviceId);
    }

    if (this.activeTransfers.has(recordingUuid)) {
      throw new TransferError(
        'Transfer already in progress for this recording',
        'TRANSFER_IN_PROGRESS',
        recordingUuid
      );
    }

    log.info('Starting streaming transfer', { deviceId, recordingUuid });

    return new Promise((resolve, reject) => {
      let totalBytes = 0;
      let isPaused = false;
      let eofChecksum = 0;

      const state: TransferState = {
        recordingUuid,
        expectedSequence: 0,
        chunks: [],
        totalBytes: 0,
        isComplete: false,
      };

      this.activeTransfers.set(recordingUuid, state);

      const cleanup = () => {
        if (state.timeoutId) clearTimeout(state.timeoutId);
        if (state.shaGraceTimerId) clearTimeout(state.shaGraceTimerId);
        state.subscription?.remove();
        this.activeTransfers.delete(recordingUuid);
      };

      const resetTimeout = (ms: number) => {
        if (state.timeoutId) clearTimeout(state.timeoutId);
        state.timeoutId = setTimeout(() => {
          cleanup();
          reject(TransferError.timeout(recordingUuid));
        }, ms);
      };

      // Per-chunk seq counter for the e2e callbacks (foundation for real-time
      // relay — chunks are pushed to backend the moment they arrive, not
      // accumulated and POSTed at EOF).
      let e2eChunkCount = 0;
      // Highest packet.sequenceNumber observed. Backend's AEAD nonce uses this
      // value (it's the firmware's `g_transfer.e2e_chunk_seq` at encrypt time),
      // so the chunk-URL seq MUST match it. A silent BLE notification drop
      // leaves a gap rather than shifting every subsequent chunk's URL down
      // by one — without that gap-tolerance the first post-drop chunk fails
      // AEAD and the SDK's serial uploadChain cascades.
      let e2eMaxSeq = -1;

      /** Streaming-transfer finalize — idempotent; called from SHA arrival or
       *  the grace-window timer. Sends ACK and resolves. */
      const finalize = async (): Promise<void> => {
        if (state.isComplete) return;
        state.isComplete = true;
        if (state.shaGraceTimerId) {
          clearTimeout(state.shaGraceTimerId);
          state.shaGraceTimerId = undefined;
        }
        // Belt-and-suspenders: also kill the data timeout. EOF cleared it
        // earlier; this guards against the race where sendAck-write delays
        // past the original 2s budget while concurrent BLE writes (heartbeat,
        // connection-settings) saturate the write queue.
        if (state.timeoutId) {
          clearTimeout(state.timeoutId);
          state.timeoutId = undefined;
        }
        try {
          await this.sendAck(deviceId, 'ack', 0);
          cleanup();

          // P10: validate the e2e session was well-formed (header arrived
          // before any chunks). Chunks themselves are already POSTed by the
          // session via the onE2eChunk callback; nothing to assemble here.
          if (state.e2eEncrypted && (!state.e2eEphemeralPk || !state.e2eSalt)) {
            reject(new TransferError(
              'E2E streaming missing ephemeral_pk/salt',
              'E2E_HEADER_MISSING',
              recordingUuid
            ));
            return;
          }

          log.info('Streaming transfer completed', {
            recordingUuid,
            totalBytes,
            checksum: eofChecksum,
            sha256Prefix: state.sha256Hex?.slice(0, 16) ?? null,
            e2eEncrypted: !!state.e2eEncrypted,
            e2eChunkCount: state.e2eEncrypted ? e2eChunkCount : null,
            e2eMaxSeq: state.e2eEncrypted && e2eMaxSeq >= 0 ? e2eMaxSeq : null,
            e2eDroppedNotifications:
              state.e2eEncrypted && e2eMaxSeq >= 0
                ? e2eMaxSeq + 1 - e2eChunkCount
                : null,
          });
          resolve({
            totalBytes,
            checksum: eofChecksum,
            sha256: state.sha256Hex,
            e2eEncrypted: !!state.e2eEncrypted,
            e2eChunkCount: state.e2eEncrypted ? e2eChunkCount : undefined,
            e2eMaxSeq:
              state.e2eEncrypted && e2eMaxSeq >= 0 ? e2eMaxSeq : undefined,
          });
        } catch (error) {
          cleanup();
          reject(error);
        }
      };

      // Subscribe to transfer data notifications
      state.subscription = this.bleManager.subscribeToCharacteristic(
        deviceId,
        SERVICE_BOTA_STORAGE,
        CHAR_RECORDING_TRANSFER,
        async (data) => {
          try {
            // Skip ACK echo-back packets
            const firstByte = data.readUInt8(0);
            if (firstByte >= 0x10 && firstByte <= 0x12) {
              return;
            }

            const packet = parseTransferPacket(data);

            switch (packet.type) {
              case 'data':
                if (packet.data) {
                  resetTimeout(TRANSFER_PACKET_TIMEOUT);
                  if (isPaused) {
                    isPaused = false;
                    callbacks.onResumed?.();
                  }
                  totalBytes += packet.data.length;
                  state.totalBytes = totalBytes;
                  callbacks.onData(packet.sequenceNumber, Buffer.from(packet.data));
                }
                break;

              case 'paused':
                isPaused = true;
                // Use longer timeout — recording may have long silence
                resetTimeout(STREAMING_PAUSED_TIMEOUT);
                callbacks.onPaused?.(packet.bytesSent ?? totalBytes);
                break;

              case 'eof':
                eofChecksum = packet.checksum ?? 0;
                state.eofReceived = true;
                // No more data packets after EOF — kill the inter-packet timeout.
                // SHA grace window below is the only deadline that still matters.
                // Without this, sendAck inside finalize() can race against the 2s
                // budget when concurrent BLE writes hog the write queue.
                if (state.timeoutId) {
                  clearTimeout(state.timeoutId);
                  state.timeoutId = undefined;
                }
                if (!state.shaGraceTimerId && !state.isComplete) {
                  state.shaGraceTimerId = setTimeout(() => {
                    state.shaGraceTimerId = undefined;
                    finalize().catch((err) => {
                      cleanup();
                      reject(err);
                    });
                  }, SHA256_GRACE_WINDOW_MS);
                }
                break;

              case 'sha256':
                if (packet.sha256) {
                  state.sha256Hex = Buffer.from(packet.sha256).toString('hex');
                }
                if (state.eofReceived) {
                  await finalize();
                }
                break;

              /* P10 BLE-e2e streaming — per-chunk relay model.
               *
               * Device emits e2e_start once, followed by encrypted_data chunks
               * (each fired through onE2eChunk so the streaming session can
               * POST it to backend in real time — foundation for streaming
               * transcription / translation). Terminated by encrypted_eof. */
              case 'e2e_start':
                state.e2eEncrypted = true;
                state.e2eEphemeralPk = packet.e2eEphemeralPk
                  ? Buffer.from(packet.e2eEphemeralPk)
                  : undefined;
                state.e2eSalt = packet.e2eSalt
                  ? Buffer.from(packet.e2eSalt)
                  : undefined;
                if (state.e2eEphemeralPk && state.e2eSalt) {
                  callbacks.onE2eStart?.(state.e2eEphemeralPk, state.e2eSalt);
                }
                resetTimeout(TRANSFER_PACKET_TIMEOUT);
                break;

              case 'encrypted_data':
                if (packet.e2eChunk) {
                  resetTimeout(TRANSFER_PACKET_TIMEOUT);
                  if (isPaused) {
                    isPaused = false;
                    callbacks.onResumed?.();
                  }
                  const ct = Buffer.from(packet.e2eChunk);
                  const plainLen = ct.length - 16;  // last 16 bytes are AEAD tag
                  totalBytes += plainLen;
                  state.totalBytes = totalBytes;
                  // DEBUG: log every encrypted_data dispatch with running count
                  // so we can correlate with firmware EOF `chunks=N`. If
                  // `count === N` we received them all; if not, the gap is on
                  // the wire / native BLE bridge — not in this dispatch layer.
                  log.debug('E2E chunk dispatch', {
                    count: e2eChunkCount + 1,
                    seq: packet.sequenceNumber,
                    plainLen,
                    cipherLen: ct.length,
                  });
                  // Per-chunk relay: hand the ciphertext to the session
                  // immediately. The session POSTs each chunk independently
                  // to /upload-relay/chunk/{seq} so the backend can decrypt
                  // and stream to S3 / future ASR pipelines as bytes arrive.
                  // Plaintext never enters app memory.
                  //
                  // Use `packet.sequenceNumber` (= firmware's `g_transfer.seq`,
                  // bumped in lockstep with `g_transfer.e2e_chunk_seq` which
                  // is the AEAD nonce) — NOT a local counter. If the BLE
                  // controller silently drops a notification (firmware's
                  // `app_send_user_data` returns 0 but iOS/Android never
                  // surfaces the packet), a local counter falls behind the
                  // firmware nonce by 1 and every chunk after the drop POSTs
                  // its ciphertext under the wrong URL → backend decrypts
                  // with the wrong nonce → AEAD tag mismatch on every
                  // remaining chunk. Using the wire seq makes the URL ↔
                  // ciphertext binding correct regardless of drops.
                  callbacks.onE2eChunk?.(packet.sequenceNumber, ct);
                  e2eChunkCount += 1;
                  if (packet.sequenceNumber > e2eMaxSeq) {
                    e2eMaxSeq = packet.sequenceNumber;
                  }
                }
                break;

              case 'encrypted_eof':
                // CRC field is unused for e2e (per-chunk AEAD tags cover integrity).
                state.eofReceived = true;
                if (state.timeoutId) {
                  clearTimeout(state.timeoutId);
                  state.timeoutId = undefined;
                }
                if (!state.shaGraceTimerId && !state.isComplete) {
                  state.shaGraceTimerId = setTimeout(() => {
                    state.shaGraceTimerId = undefined;
                    finalize().catch((err) => {
                      cleanup();
                      reject(err);
                    });
                  }, SHA256_GRACE_WINDOW_MS);
                }
                break;

              case 'error':
                cleanup();
                reject(
                  TransferError.deviceError(
                    recordingUuid,
                    packet.errorCode ?? 0xff
                  )
                );
                break;
            }
          } catch (error) {
            cleanup();
            reject(error);
          }
        },
        (error) => {
          cleanup();
          reject(TransferError.interrupted(recordingUuid, error));
        }
      );

      // Send start transfer command (same command — firmware detects streaming mode
      // based on whether the UUID matches the current recording)
      const command = createTransferCommand('start', recordingUuid);
      this.bleManager
        .writeCharacteristic(
          deviceId,
          SERVICE_BOTA_STORAGE,
          CHAR_TRANSFER_CONTROL,
          command
        )
        .then(() => {
          resetTimeout(TRANSFER_PACKET_TIMEOUT);
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
    });
  }

  // ---- Firmware Upload (app → device via BLE) ----

  /**
   * Upload firmware binary to device via BLE.
   * Device writes the file to SD card as update.ufw, verifies CRC32,
   * then reboots to apply the update.
   *
   * Protocol:
   * 1. Send UPLOAD_START (0x08) with file size → wait for ready notification
   * 2. Send firmware data in chunks via RECORDING_TRANSFER (0x20 + seq + data)
   * 3. Send UPLOAD_VERIFY (0x09) with CRC32 → wait for verify notification
   * 4. Device reboots automatically on success
   */
  async uploadFirmware(
    deviceId: string,
    firmwareData: Buffer,
    onProgress?: (bytesSent: number, totalBytes: number) => void
  ): Promise<void> {
    if (!this.bleManager.isConnected(deviceId)) {
      throw DeviceError.notConnected(deviceId);
    }

    const totalSize = firmwareData.length;
    log.info('Starting firmware upload', { deviceId, size: totalSize });

    // 1. Keep a single persistent subscription for the entire upload
    let statusHandler: ((data: Buffer) => void) | null = null;
    let statusReject: ((error: Error) => void) | null = null;
    let statusTimer: number | undefined;
    let uploadStarted = false;
    let latestAckSeq: number | null = null;
    let transferError: TransferError | null = null;

    const clearStatusWait = () => {
      if (statusTimer !== undefined) {
        clearTimeout(statusTimer);
        statusTimer = undefined;
      }
      statusHandler = null;
      statusReject = null;
    };

    const failTransfer = (error: TransferError) => {
      transferError = error;
      const reject = statusReject;
      clearStatusWait();
      reject?.(error);
    };

    const throwIfTransferFailed = () => {
      if (transferError) {
        throw transferError;
      }
    };

    const subscription = this.bleManager.subscribeToCharacteristic(
      deviceId,
      SERVICE_BOTA_STORAGE,
      CHAR_TRANSFER_STATUS,
      (data: Buffer) => {
        if (data.length >= 3 && data[0] === 0x10) {
          latestAckSeq = data.readUInt16LE(1);
        }

        if (uploadStarted && data.length >= 2 && data[0] === 0x08 && data[1] !== 0x00) {
          failTransfer(
            new TransferError(
              'Device storage write failed during firmware upload',
              'FW_STORAGE_WRITE_FAILED'
            )
          );
          return;
        }

        statusHandler?.(data);
      },
      (error: Error) => {
        log.error('Status subscription error', error);
      }
    );

    const waitForStatus = <T>(
      filter: (data: Buffer) => T | null,
      timeoutMs: number = 10000
    ): Promise<T> => {
      return new Promise<T>((resolve, reject) => {
        if (transferError) {
          reject(transferError);
          return;
        }

        statusTimer = setTimeout(() => {
          clearStatusWait();
          reject(new TransferError('Firmware upload status timeout', 'FW_UPLOAD_TIMEOUT'));
        }, timeoutMs);
        statusReject = reject;

        statusHandler = (data: Buffer) => {
          const result = filter(data);
          if (result !== null) {
            clearStatusWait();
            resolve(result);
          }
        };
      });
    };

    const waitForAck = async (expectedSeq: number): Promise<void> => {
      throwIfTransferFailed();
      if (latestAckSeq === expectedSeq) {
        return;
      }

      try {
        await waitForStatus<boolean>((data) => {
          if (data.length >= 3 && data[0] === 0x10 && data.readUInt16LE(1) === expectedSeq) {
            return true;
          }
          return null;
        }, 5000);
      } catch (error) {
        if (error instanceof TransferError && error.code === 'FW_UPLOAD_TIMEOUT') {
          throw new TransferError(
            `Device did not acknowledge firmware packet ${expectedSeq}`,
            'FW_UPLOAD_ACK_TIMEOUT'
          );
        }
        throw error;
      }
    };

    try {
      // 2. Send UPLOAD_START command
      const startCmd = Buffer.alloc(5);
      startCmd[0] = 0x08; // FIRMWARE_UPLOAD_START
      startCmd.writeUInt32LE(totalSize, 1);

      const readyPromise = waitForStatus<boolean>((data) => {
        if (data.length >= 2 && data[0] === 0x08) {
          return data[1] === 0x00; // true = ready, false = error
        }
        return null;
      });

      await this.bleManager.writeCharacteristic(
        deviceId,
        SERVICE_BOTA_STORAGE,
        CHAR_TRANSFER_CONTROL,
        startCmd,
        true
      );

      const ready = await readyPromise;
      if (!ready) {
        throw new TransferError('Device rejected firmware upload', 'FW_UPLOAD_REJECTED');
      }

      log.info('Device ready for firmware upload');
      uploadStarted = true;

      // 3. Send firmware data in chunks
      const CHUNK_SIZE = 500;
      let bytesSent = 0;
      let seq = 0;

      while (bytesSent < totalSize) {
        const chunkEnd = Math.min(bytesSent + CHUNK_SIZE, totalSize);
        const chunk = firmwareData.subarray(bytesSent, chunkEnd);

        // Build packet: [0x20, seq(u16LE), data...]
        const header = Buffer.alloc(3);
        header[0] = 0x20; // FIRMWARE_DATA
        header.writeUInt16LE(seq, 1);
        const packet = Buffer.concat([header, Buffer.from(chunk)]);

        // Write without response for speed
        await this.bleManager.writeCharacteristic(
          deviceId,
          SERVICE_BOTA_STORAGE,
          CHAR_RECORDING_TRANSFER,
          packet,
          false // writeWithoutResponse
        );

        throwIfTransferFailed();

        bytesSent = chunkEnd;
        seq++;

        onProgress?.(bytesSent, totalSize);

        // Wait for ACK every 8 packets for flow control
        if (seq % 8 === 0) {
          await waitForAck(seq - 1);
        }
      }

      throwIfTransferFailed();
      log.info('Firmware data sent, verifying CRC32');

      // 4. Compute CRC32 and send verify command
      const crc32 = this.calculateCrc32(firmwareData);
      const verifyCmd = Buffer.alloc(5);
      verifyCmd[0] = 0x09; // FIRMWARE_UPLOAD_VERIFY
      verifyCmd.writeUInt32LE(crc32, 1);

      const verifyPromise = waitForStatus<boolean>((data) => {
        if (data.length >= 2 && data[0] === 0x09) {
          return data[1] === 0x00; // true = match, false = mismatch
        }
        return null;
      }, 15000);

      await this.bleManager.writeCharacteristic(
        deviceId,
        SERVICE_BOTA_STORAGE,
        CHAR_TRANSFER_CONTROL,
        verifyCmd,
        true
      );

      const verified = await verifyPromise;
      if (!verified) {
        throw new TransferError('Firmware CRC32 verification failed', 'FW_CRC_MISMATCH');
      }

      log.info('Firmware verified, device will reboot to apply update');
    } finally {
      // Always clean up the persistent subscription
      clearStatusWait();
      subscription?.remove();
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    // Cancel all active transfers
    for (const [, state] of this.activeTransfers) {
      if (state.timeoutId) clearTimeout(state.timeoutId);
      state.subscription?.remove();
    }
    this.activeTransfers.clear();
    for (const subscription of this.activeEncryptedUploadV2Transfers.values()) {
      subscription.remove();
    }
    this.activeEncryptedUploadV2Transfers.clear();
  }
}

function parseFullUuid(value: string): Buffer {
  const canonical = value.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(canonical)) {
    throw new EncryptedUploadV2RuntimeError(
      'encrypted_upload_v2_invalid_configuration'
    );
  }
  return Buffer.from(canonical.replace(/-/g, ''), 'hex');
}

function validateEncryptedUploadV2Opening(
  value: EncryptedUploadV2Transfer,
  request: EncryptedUploadV2TransferRequest
): void {
  if (value.type !== 'startAck' && value.type !== 'resumeAccept') {
    throw new EncryptedUploadV2RuntimeError(
      'encrypted_upload_v2_unexpected_message'
    );
  }
  if (
    !constantTimeEqual(value.uploadSessionUuid, parseFullUuid(request.uploadSessionUuid)) ||
    !constantTimeEqual(value.recordingUuid, parseFullUuid(request.recording.uuid)) ||
    value.recordingGeneration !== request.recording.generation ||
    value.windowPackets !== request.windowPackets ||
    value.dataPayloadBytes !== request.dataPayloadBytes ||
    value.checkpointRevision !== request.checkpoint.revision ||
    value.nextCiphertextOffset !== request.checkpoint.nextCiphertextOffset ||
    !constantTimeEqual(value.prefixSha256, request.checkpoint.prefixSha256) ||
    (value.type === 'startAck' && (
      value.ciphertextLength !== request.recording.ciphertextLength ||
      !constantTimeEqual(value.ciphertextSha256, request.recording.ciphertextSha256) ||
      value.checkpointIntervalBlocks !== request.checkpointIntervalBlocks
    ))
  ) {
    throw new EncryptedUploadV2RuntimeError(
      'encrypted_upload_v2_integrity_mismatch'
    );
  }
}

function formatFullUuid(value: Uint8Array): string {
  if (value.length !== 16) {
    throw new EncryptedUploadV2RuntimeError(
      'encrypted_upload_v2_invalid_configuration'
    );
  }
  const hex = Buffer.from(value).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function parseEncryptedUploadV2Status(value: Buffer): {
  phase: number;
  result: number;
  transportSessionId: bigint;
} {
  const phase = value[1];
  const transportSessionId = value.length >= 12
    ? value.readBigUInt64LE(4)
    : 0n;
  const transportProfile = value[21];
  if (
    value.length !== 24 ||
    value[0] !== 2 ||
    value[20] > 100 ||
    value.readUInt16LE(22) !== 0 ||
    (phase === 0
      ? transportSessionId !== 0n || transportProfile !== 0
      : transportSessionId === 0n || transportProfile !== 3)
  ) {
    throw new EncryptedUploadV2RuntimeError(
      'encrypted_upload_v2_unexpected_message'
    );
  }
  return {
    phase,
    result: value.readUInt16LE(2),
    transportSessionId,
  };
}
