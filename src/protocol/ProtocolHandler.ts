/**
 * Protocol Handler - Implements Device-App Protocol for recording transfer
 */

import { Buffer } from 'buffer';
import { Subscription } from 'react-native-ble-plx';

import { getBleManager, BleManager } from '../ble/BleManager';
import {
  SERVICE_BOTA_STORAGE,
  CHAR_STORAGE_INFO,
  CHAR_RECORDING_LIST,
  CHAR_RECORDING_TRANSFER,
  CHAR_TRANSFER_CONTROL,
  TRANSFER_PACKET_TIMEOUT,
} from '../ble/constants';
import {
  parseStorageInfo,
  parseRecordingList,
  parseTransferPacket,
  createAckPacket,
  createTransferCommand,
} from '../ble/parsers';
import type { StorageInfo } from '../models/Device';
import type { DeviceRecording, TransferPacket } from '../models/Recording';
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
  timeoutId?: NodeJS.Timeout;
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
      let timeoutId: NodeJS.Timeout | undefined;

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
  ): Promise<Buffer> {
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
        receivedPackets: new Map(),
        totalBytes: 0,
        isComplete: false,
      };

      this.activeTransfers.set(recordingUuid, state);

      const cleanup = () => {
        if (state.timeoutId) clearTimeout(state.timeoutId);
        state.subscription?.remove();
        this.activeTransfers.delete(recordingUuid);
      };

      const resetTimeout = () => {
        if (state.timeoutId) clearTimeout(state.timeoutId);
        state.timeoutId = setTimeout(() => {
          log.debug('Transfer timeout', { recordingUuid, totalBytes: state.totalBytes });
          cleanup();
          reject(TransferError.timeout(recordingUuid));
        }, TRANSFER_PACKET_TIMEOUT);
      };

      // Subscribe to transfer data notifications
      log.debug('Subscribing to RECORDING_TRANSFER');
      state.subscription = this.bleManager.subscribeToCharacteristic(
        deviceId,
        SERVICE_BOTA_STORAGE,
        CHAR_RECORDING_TRANSFER,
        async (data) => {
          try {
            log.debug('Transfer notify', {
              len: data.length,
              first: data[0]?.toString(16),
            });
            resetTimeout();

            // Skip ACK echo-back packets (App→Device only, may be echoed by BLE stack)
            const firstByte = data.readUInt8(0);
            if (firstByte >= 0x10 && firstByte <= 0x12) {
              log.debug('Skipping ACK echo-back', { firstByte: firstByte.toString(16) });
              return;
            }

            const packet = parseTransferPacket(data);
            log.debug('Parsed packet', {
              type: packet.type,
              seq: packet.sequenceNumber,
              dataLen: packet.data?.length,
            });
            await this.handleTransferPacket(
              deviceId,
              state,
              packet,
              onProgress
            );

            if (state.isComplete) {
              cleanup();

              // Assemble the audio data
              const audioData = this.assembleAudioData(state);

              // Verify checksum if available
              if (state.checksum !== undefined) {
                const calculatedChecksum = this.calculateCrc32(audioData);
                if (calculatedChecksum !== state.checksum) {
                  reject(TransferError.checksumMismatch(recordingUuid));
                  return;
                }
              }

              log.info('Transfer completed', {
                recordingUuid,
                size: audioData.length,
              });

              resolve(audioData);
            }
          } catch (error) {
            log.error('Transfer notify error', error as Error);
            cleanup();
            reject(error);
          }
        },
        (error) => {
          log.error('Transfer subscription error', error);
          cleanup();
          reject(TransferError.interrupted(recordingUuid, error));
        }
      );

      // Send start transfer command
      log.debug('Sending START command', { recordingUuid });
      const command = createTransferCommand('start', recordingUuid);
      this.bleManager
        .writeCharacteristic(
          deviceId,
          SERVICE_BOTA_STORAGE,
          CHAR_TRANSFER_CONTROL,
          command
        )
        .then(() => {
          log.debug('START command sent OK');
          resetTimeout();
        })
        .catch((error) => {
          log.error('START command failed', error as Error);
          cleanup();
          reject(error);
        });
    });
  }

  /**
   * Handle a transfer packet from device
   */
  private async handleTransferPacket(
    deviceId: string,
    state: TransferState,
    packet: TransferPacket,
    onProgress?: TransferProgressCallback
  ): Promise<void> {
    switch (packet.type) {
      case 'data':
        if (packet.data) {
          // Store packet data
          state.receivedPackets.set(packet.sequenceNumber, Buffer.from(packet.data));
          state.totalBytes += packet.data.length;

          // Send ACK
          await this.sendAck(deviceId, 'ack', packet.sequenceNumber);

          // Report progress
          onProgress?.(state.totalBytes);

          log.debug('Received data packet', {
            seq: packet.sequenceNumber,
            size: packet.data.length,
            total: state.totalBytes,
          });
        }
        break;

      case 'eof':
        state.checksum = packet.checksum;
        state.isComplete = true;

        // Send final ACK
        await this.sendAck(deviceId, 'ack', packet.sequenceNumber);

        log.debug('Received EOF packet', {
          seq: packet.sequenceNumber,
          checksum: packet.checksum,
        });
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
