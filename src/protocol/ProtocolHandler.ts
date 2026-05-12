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

const log = logger.tag('ProtocolHandler');

/** Time to wait after EOF for the optional P9.F2 SHA-256 packet to arrive before
 *  finalizing the transfer. Firmware sends it back-to-back with EOF on the same
 *  characteristic; a tight window keeps the resolve fast on old firmware (which
 *  never sends one) while reliably catching the packet on new firmware. */
const SHA256_GRACE_WINDOW_MS = 200;

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
          lenHdr.writeUInt16BE(plainLen);
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
    }
  ): Promise<{ totalBytes: number; checksum: number; sha256?: string }> {
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

      /** Streaming-transfer finalize — idempotent; called from SHA arrival or
       *  the grace-window timer. Sends ACK and resolves. */
      const finalize = async (): Promise<void> => {
        if (state.isComplete) return;
        state.isComplete = true;
        if (state.shaGraceTimerId) {
          clearTimeout(state.shaGraceTimerId);
          state.shaGraceTimerId = undefined;
        }
        try {
          await this.sendAck(deviceId, 'ack', 0);
          cleanup();
          log.info('Streaming transfer completed', {
            recordingUuid,
            totalBytes,
            checksum: eofChecksum,
            sha256Prefix: state.sha256Hex?.slice(0, 16) ?? null,
          });
          resolve({
            totalBytes,
            checksum: eofChecksum,
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
    const subscription = this.bleManager.subscribeToCharacteristic(
      deviceId,
      SERVICE_BOTA_STORAGE,
      CHAR_TRANSFER_STATUS,
      (data: Buffer) => {
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
        const timer = setTimeout(() => {
          statusHandler = null;
          reject(new TransferError('Firmware upload status timeout', 'FW_UPLOAD_TIMEOUT'));
        }, timeoutMs);

        statusHandler = (data: Buffer) => {
          const result = filter(data);
          if (result !== null) {
            clearTimeout(timer);
            statusHandler = null;
            resolve(result);
          }
        };
      });
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

        bytesSent = chunkEnd;
        seq++;

        onProgress?.(bytesSent, totalSize);

        // Wait for ACK every 8 packets for flow control
        if (seq % 8 === 0) {
          try {
            await waitForStatus<boolean>((data) => {
              if (data.length >= 3 && data[0] === 0x10) {
                return true;
              }
              return null;
            }, 5000);
          } catch {
            // ACK timeout — device may still be processing, continue
            log.warn('ACK timeout at seq', { seq });
          }
        }
      }

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
  }
}
