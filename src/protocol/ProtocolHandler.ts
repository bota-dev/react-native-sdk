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
  DEFAULT_WINDOW_SIZE,
  MAX_RETRANSMIT_ROUNDS,
  MAX_MISSING_PER_WINDOW,
  PACKET_TYPE_START_ACK,
} from '../ble/constants';
import {
  parseStorageInfo,
  parseRecordingList,
  parseTransferPacket,
  parseStartAck,
  createAckPacket,
  createTransferCommand,
  createTransferStartV2,
  createWindowAck,
  createRetransmitRequest,
} from '../ble/parsers';
import type { StorageInfo } from '../models/Device';
import type { DeviceRecording } from '../models/Recording';
import { TransferError, DeviceError } from '../utils/errors';
import { logger } from '../utils/logger';

const log = logger.tag('ProtocolHandler');

/**
 * Transfer state for tracking ongoing transfers
 */
interface TransferState {
  recordingUuid: string;
  expectedSequence: number;
  receivedPackets: Map<number, Buffer>;
  totalBytes: number;
  isComplete: boolean;
  checksum?: number;
  subscription?: Subscription;
  timeoutId?: number;
  // v2 windowed transfer fields
  protocolVersion: 1 | 2;
  negotiated: boolean; // true after START_ACK received (v2) or first DATA (v1)
  windowSize: number;
  totalPackets: number;
  fileSize: number;
  windowStartSeq: number;
  retransmitRound: number;
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
   * Transfer a recording from device.
   * Negotiates v2 windowed protocol if device supports it, falls back to v1.
   */
  async transferRecording(
    deviceId: string,
    recordingUuid: string,
    onProgress?: TransferProgressCallback
  ): Promise<Buffer> {
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

    log.info('Starting recording transfer', { deviceId, recordingUuid });

    return new Promise((resolve, reject) => {
      const state: TransferState = {
        recordingUuid,
        expectedSequence: 0,
        receivedPackets: new Map(),
        totalBytes: 0,
        isComplete: false,
        protocolVersion: 1,
        negotiated: false,
        windowSize: DEFAULT_WINDOW_SIZE,
        totalPackets: 0,
        fileSize: 0,
        windowStartSeq: 0,
        retransmitRound: 0,
      };

      this.activeTransfers.set(recordingUuid, state);

      const cleanup = () => {
        if (state.timeoutId) clearTimeout(state.timeoutId);
        state.subscription?.remove();
        this.activeTransfers.delete(recordingUuid);
      };

      const resetTimeout = (ms?: number) => {
        if (state.timeoutId) clearTimeout(state.timeoutId);
        state.timeoutId = setTimeout(() => {
          cleanup();
          reject(TransferError.timeout(recordingUuid));
        }, ms ?? TRANSFER_PACKET_TIMEOUT);
      };

      /** Detect gaps in a sequence range [start..end] */
      const findMissing = (start: number, end: number): number[] => {
        const missing: number[] = [];
        for (let s = start; s <= end; s++) {
          if (!state.receivedPackets.has(s)) {
            missing.push(s);
          }
        }
        return missing;
      };

      /** Send WINDOW_ACK to device via TRANSFER_CONTROL */
      const sendWindowAck = async (lastGoodSeq: number, missingSeqs: number[]) => {
        const pkt = createWindowAck(lastGoodSeq, missingSeqs);
        await this.bleManager.writeCharacteristic(
          deviceId, SERVICE_BOTA_STORAGE, CHAR_TRANSFER_CONTROL, pkt, true
        );
      };

      /** Send RETRANSMIT request to device */
      const sendRetransmit = async (missingSeqs: number[]) => {
        const pkt = createRetransmitRequest(missingSeqs);
        await this.bleManager.writeCharacteristic(
          deviceId, SERVICE_BOTA_STORAGE, CHAR_TRANSFER_CONTROL, pkt, true
        );
      };

      /** Handle v2 WINDOW_END: check for gaps, send WINDOW_ACK */
      const handleWindowEnd = async (windowIndex: number, lastSeq: number) => {
        const missing = findMissing(state.windowStartSeq, lastSeq);

        if (missing.length === 0) {
          // All packets received — advance window
          log.debug(`Window ${windowIndex} OK (seq ${state.windowStartSeq}-${lastSeq})`);
          await sendWindowAck(lastSeq, []);
          state.windowStartSeq = lastSeq + 1;
          state.retransmitRound = 0;
          resetTimeout(30000); // wait for next window
        } else if (missing.length > MAX_MISSING_PER_WINDOW) {
          // Too many gaps — connection is bad, abort
          log.error(`Window ${windowIndex}: ${missing.length} missing (>${MAX_MISSING_PER_WINDOW}), aborting`);
          await this.sendAck(deviceId, 'abort', 0);
          cleanup();
          reject(new TransferError(
            `Too many missing packets in window ${windowIndex}`,
            'TRANSFER_TOO_MANY_GAPS',
            recordingUuid
          ));
        } else if (state.retransmitRound >= MAX_RETRANSMIT_ROUNDS) {
          log.error(`Window ${windowIndex}: ${missing.length} still missing after ${MAX_RETRANSMIT_ROUNDS} retransmit rounds`);
          await this.sendAck(deviceId, 'abort', 0);
          cleanup();
          reject(new TransferError(
            `Retransmit limit exceeded for window ${windowIndex}`,
            'TRANSFER_RETRANSMIT_LIMIT',
            recordingUuid
          ));
        } else {
          // Request retransmission
          state.retransmitRound++;
          log.debug(`Window ${windowIndex}: ${missing.length} missing, retransmit round ${state.retransmitRound}`);
          await sendWindowAck(lastSeq, missing);
          resetTimeout(30000);
        }
      };

      /** Handle EOF: verify CRC, send ACK or RETRANSMIT */
      const handleEof = async (finalSeq: number, checksum: number) => {
        // Check for any remaining gaps across the entire transfer
        const missing = findMissing(0, finalSeq);

        if (missing.length > 0 && missing.length <= MAX_MISSING_PER_WINDOW) {
          if (state.retransmitRound >= MAX_RETRANSMIT_ROUNDS) {
            log.error(`EOF: ${missing.length} still missing after ${MAX_RETRANSMIT_ROUNDS} rounds`);
            await this.sendAck(deviceId, 'nack', 0);
            cleanup();
            reject(TransferError.checksumMismatch(recordingUuid));
            return;
          }
          state.retransmitRound++;
          log.debug(`EOF: ${missing.length} missing, requesting retransmit round ${state.retransmitRound}`);
          await sendRetransmit(missing);
          state.isComplete = false; // wait for retransmitted packets + new EOF
          resetTimeout(30000);
          return;
        }

        if (missing.length > MAX_MISSING_PER_WINDOW) {
          log.error(`EOF: ${missing.length} missing packets, too many to recover`);
          await this.sendAck(deviceId, 'nack', 0);
          cleanup();
          reject(TransferError.checksumMismatch(recordingUuid));
          return;
        }

        // All packets present — verify CRC
        const audioData = this.assembleAudioData(state);
        const calculatedChecksum = this.calculateCrc32(audioData);

        if (calculatedChecksum !== checksum) {
          log.error(`CRC mismatch: expected=${checksum.toString(16)} calculated=${calculatedChecksum.toString(16)} bytes=${audioData.length}`);
          await this.sendAck(deviceId, 'nack', 0);
          cleanup();
          reject(TransferError.checksumMismatch(recordingUuid));
          return;
        }

        // Success
        await this.sendAck(deviceId, 'ack', 0);
        cleanup();
        log.info('Transfer completed', { recordingUuid, size: audioData.length, protocol: `v${state.protocolVersion}` });
        resolve(audioData);
      };

      // Subscribe to transfer data notifications
      state.subscription = this.bleManager.subscribeToCharacteristic(
        deviceId,
        SERVICE_BOTA_STORAGE,
        CHAR_RECORDING_TRANSFER,
        async (data) => {
          try {
            resetTimeout(state.protocolVersion === 2 ? 30000 : TRANSFER_PACKET_TIMEOUT);

            const firstByte = data.readUInt8(0);

            // Skip ACK echo-back packets
            if (firstByte >= 0x10 && firstByte <= 0x14) {
              return;
            }

            // v2 negotiation: first packet after START
            if (!state.negotiated) {
              if (firstByte === PACKET_TYPE_START_ACK && data.length >= 11) {
                // Device supports v2 — parse START_ACK
                const ack = parseStartAck(data);
                state.protocolVersion = 2;
                state.negotiated = true;
                state.windowSize = ack.windowSize;
                state.totalPackets = ack.totalPackets;
                state.fileSize = ack.fileSize;
                log.info(`v2 negotiated: window=${ack.windowSize} packets=${ack.totalPackets} size=${ack.fileSize}`);
                resetTimeout(30000); // wait for first window
                return;
              }
              // Not a START_ACK — device is v1, process as DATA
              state.protocolVersion = 1;
              state.negotiated = true;
              log.info('v1 fallback (no START_ACK)');
            }

            const packet = parseTransferPacket(data);

            switch (packet.type) {
              case 'data':
                if (packet.data) {
                  state.receivedPackets.set(packet.sequenceNumber, Buffer.from(packet.data));
                  state.totalBytes += packet.data.length;
                  onProgress?.(state.totalBytes, state.fileSize || undefined);
                }
                break;

              case 'window_end':
                if (state.protocolVersion === 2 && packet.windowIndex !== undefined && packet.lastSeq !== undefined) {
                  await handleWindowEnd(packet.windowIndex, packet.lastSeq);
                }
                break;

              case 'eof':
                if (state.protocolVersion === 2 && packet.checksum !== undefined) {
                  await handleEof(packet.sequenceNumber, packet.checksum);
                } else {
                  // v1: same as before
                  state.checksum = packet.checksum;
                  state.isComplete = true;
                }
                break;

              case 'error':
                throw TransferError.deviceError(state.recordingUuid, packet.errorCode ?? 0xff);
            }

            // v1 completion path
            if (state.protocolVersion === 1 && state.isComplete) {
              const audioData = this.assembleAudioData(state);

              if (state.checksum !== undefined) {
                const calculatedChecksum = this.calculateCrc32(audioData);
                if (calculatedChecksum !== state.checksum) {
                  const missing = findMissing(0, Math.max(...state.receivedPackets.keys()));
                  log.error(`v1 CRC mismatch: expected=${state.checksum.toString(16)} calculated=${calculatedChecksum.toString(16)} missing=${missing.length}`);
                  await this.sendAck(deviceId, 'nack', 0);
                  cleanup();
                  reject(TransferError.checksumMismatch(recordingUuid));
                  return;
                }
              }

              await this.sendAck(deviceId, 'ack', 0);
              cleanup();
              log.info('Transfer completed', { recordingUuid, size: audioData.length, protocol: 'v1' });
              resolve(audioData);
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

      // Send v2 START command (backward compatible — v1 devices ignore extra 2 bytes)
      const command = createTransferStartV2(recordingUuid, DEFAULT_WINDOW_SIZE);
      this.bleManager
        .writeCharacteristic(deviceId, SERVICE_BOTA_STORAGE, CHAR_TRANSFER_CONTROL, command)
        .then(() => resetTimeout(30000))
        .catch((error) => { cleanup(); reject(error); });
    });
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
   * Assemble audio data from received packets
   */
  private assembleAudioData(state: TransferState): Buffer {
    // Sort packets by sequence number and concatenate
    const sortedSequences = Array.from(state.receivedPackets.keys()).sort(
      (a, b) => a - b
    );

    const chunks: Buffer[] = [];
    for (const seq of sortedSequences) {
      const data = state.receivedPackets.get(seq);
      if (data) {
        chunks.push(data);
      }
    }

    return Buffer.concat(chunks);
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
  ): Promise<{ totalBytes: number; checksum: number }> {
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

      const state: TransferState = {
        recordingUuid,
        expectedSequence: 0,
        receivedPackets: new Map(), // Not used for streaming — data is forwarded via callback
        totalBytes: 0,
        isComplete: false,
      };

      this.activeTransfers.set(recordingUuid, state);

      const cleanup = () => {
        if (state.timeoutId) clearTimeout(state.timeoutId);
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
                cleanup();
                log.info('Streaming transfer completed', {
                  recordingUuid,
                  totalBytes,
                  checksum: packet.checksum,
                });
                // Send final ACK
                await this.sendAck(deviceId, 'ack', 0);
                resolve({
                  totalBytes,
                  checksum: packet.checksum ?? 0,
                });
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
