/**
 * BLE data parsers for Bota device protocol
 */

import { Buffer } from 'buffer';

import type {
  DeviceType,
  PairingState,
  DeviceState,
  DeviceStatus,
  DeviceFlags,
  StorageInfo,
} from '../models/Device';
import type { DeviceRecording, AudioCodec, TransferPacket } from '../models/Recording';
import {
  DEVICE_TYPE_PIN,
  DEVICE_TYPE_PIN_4G,
  DEVICE_TYPE_NOTE,
  PAIRING_STATE_UNPAIRED,
  PAIRING_STATE_PAIRING,
  PAIRING_STATE_PAIRED,
  PAIRING_STATE_ERROR,
  DEVICE_STATE_IDLE,
  DEVICE_STATE_RECORDING,
  DEVICE_STATE_SYNCING,
  DEVICE_STATE_UPLOADING,
  DEVICE_STATE_CHARGING,
  DEVICE_STATE_LOW_BATTERY,
  DEVICE_STATE_STORAGE_FULL,
  DEVICE_STATE_ERROR,
  FLAG_CHARGING,
  FLAG_USB_CONNECTED,
  FLAG_LOW_BATTERY,
  FLAG_CRITICAL_BATTERY,
  FLAG_STORAGE_WARNING,
  FLAG_STORAGE_FULL,
  FLAG_CELLULAR_AVAILABLE,
  FLAG_CELLULAR_ROAMING,
  FLAG_WIFI_CONNECTED,
  FLAG_RECORDING_ACTIVE,
  FLAG_SYNC_REQUIRED,
  FLAG_UPDATE_AVAILABLE,
  CODEC_PCM_16K,
  CODEC_PCM_8K,
  CODEC_OPUS_16K,
  CODEC_OPUS_8K,
  PACKET_TYPE_DATA,
  PACKET_TYPE_EOF,
  PACKET_TYPE_ERROR,
} from './constants';

/**
 * Parse device type from manufacturer data byte
 */
export function parseDeviceType(byte: number): DeviceType {
  switch (byte) {
    case DEVICE_TYPE_PIN:
      return 'bota_pin';
    case DEVICE_TYPE_PIN_4G:
      return 'bota_pin_4g';
    case DEVICE_TYPE_NOTE:
      return 'bota_note';
    default:
      return 'bota_pin';
  }
}

/**
 * Parse pairing state from manufacturer data byte
 */
export function parsePairingState(byte: number): PairingState {
  switch (byte) {
    case PAIRING_STATE_UNPAIRED:
      return 'unpaired';
    case PAIRING_STATE_PAIRING:
      return 'pairing';
    case PAIRING_STATE_PAIRED:
      return 'paired';
    case PAIRING_STATE_ERROR:
      return 'error';
    default:
      return 'unpaired';
  }
}

/**
 * Parse firmware version from major/minor bytes
 */
export function parseFirmwareVersion(major: number, minor: number): string {
  return `${major}.${minor}.0`;
}

/**
 * Parse device state from status byte
 */
export function parseDeviceState(byte: number): DeviceState {
  switch (byte) {
    case DEVICE_STATE_IDLE:
      return 'idle';
    case DEVICE_STATE_RECORDING:
      return 'recording';
    case DEVICE_STATE_SYNCING:
      return 'syncing';
    case DEVICE_STATE_UPLOADING:
      return 'uploading';
    case DEVICE_STATE_CHARGING:
      return 'charging';
    case DEVICE_STATE_LOW_BATTERY:
      return 'lowBattery';
    case DEVICE_STATE_STORAGE_FULL:
      return 'storageFull';
    case DEVICE_STATE_ERROR:
      return 'error';
    default:
      return 'idle';
  }
}

/**
 * Parse device flags from 16-bit value
 */
export function parseDeviceFlags(value: number): DeviceFlags {
  return {
    charging: (value & FLAG_CHARGING) !== 0,
    usbConnected: (value & FLAG_USB_CONNECTED) !== 0,
    lowBattery: (value & FLAG_LOW_BATTERY) !== 0,
    criticalBattery: (value & FLAG_CRITICAL_BATTERY) !== 0,
    storageWarning: (value & FLAG_STORAGE_WARNING) !== 0,
    storageFull: (value & FLAG_STORAGE_FULL) !== 0,
    cellularAvailable: (value & FLAG_CELLULAR_AVAILABLE) !== 0,
    cellularRoaming: (value & FLAG_CELLULAR_ROAMING) !== 0,
    wifiConnected: (value & FLAG_WIFI_CONNECTED) !== 0,
    recordingActive: (value & FLAG_RECORDING_ACTIVE) !== 0,
    syncRequired: (value & FLAG_SYNC_REQUIRED) !== 0,
    updateAvailable: (value & FLAG_UPDATE_AVAILABLE) !== 0,
  };
}

/**
 * Parse device status from 16-byte characteristic value
 *
 * Format:
 * Bytes 0-3:   Timestamp (Unix seconds)
 * Byte 4:     Battery % (0-100)
 * Byte 5:     State
 * Byte 6:     Storage % (0-100)
 * Byte 7:     Signal (0-5)
 * Bytes 8-9:  Pending recordings count
 * Bytes 10-13: Last sync time (Unix seconds)
 * Bytes 14-15: Flags
 */
export function parseDeviceStatus(data: Buffer): DeviceStatus {
  if (data.length < 16) {
    throw new Error(`Invalid status data length: ${data.length}`);
  }

  const timestamp = data.readUInt32LE(0);
  const batteryLevel = data.readUInt8(4);
  const state = parseDeviceState(data.readUInt8(5));
  const storageUsedPercent = data.readUInt8(6);
  const signalStrength = data.readUInt8(7);
  const pendingRecordings = data.readUInt16LE(8);
  const lastSyncTimestamp = data.readUInt32LE(10);
  const flagsValue = data.readUInt16LE(14);
  const flags = parseDeviceFlags(flagsValue);

  return {
    batteryLevel,
    storageUsedPercent,
    state,
    pendingRecordings,
    lastSyncAt: lastSyncTimestamp > 0 ? new Date(lastSyncTimestamp * 1000) : null,
    signalStrength,
    flags,
    timestamp,
  };
}

/**
 * Parse storage info from 16-byte characteristic value
 *
 * Format:
 * Bytes 0-3:   Total storage (KB)
 * Bytes 4-7:   Used storage (KB)
 * Bytes 8-9:   Total recording count
 * Bytes 10-11: Pending sync count
 * Bytes 12-15: Reserved
 */
export function parseStorageInfo(data: Buffer): StorageInfo {
  if (data.length < 12) {
    throw new Error(`Invalid storage info length: ${data.length}`);
  }

  return {
    totalKb: data.readUInt32LE(0),
    usedKb: data.readUInt32LE(4),
    totalRecordings: data.readUInt16LE(8),
    pendingSyncCount: data.readUInt16LE(10),
  };
}

/**
 * Parse audio codec from byte value
 */
export function parseAudioCodec(byte: number): AudioCodec {
  switch (byte) {
    case CODEC_PCM_16K:
      return 'pcm_16k';
    case CODEC_PCM_8K:
      return 'pcm_8k';
    case CODEC_OPUS_16K:
      return 'opus_16k';
    case CODEC_OPUS_8K:
      return 'opus_8k';
    default:
      return 'opus_16k';
  }
}

/**
 * Parse recording list from notification data
 * Each recording entry is typically 24 bytes:
 * - UUID: 16 bytes
 * - Timestamp: 4 bytes (Unix seconds)
 * - Duration: 2 bytes (seconds)
 * - Size: 2 bytes (KB, or needs scaling)
 */
export function parseRecordingList(data: Buffer): DeviceRecording[] {
  const recordings: DeviceRecording[] = [];
  const entrySize = 24;

  // First byte might be count
  let offset = 0;
  if (data.length > 0 && data.length % entrySize !== 0) {
    // Skip count byte
    offset = 1;
  }

  while (offset + entrySize <= data.length) {
    const uuid = formatUuid(data.slice(offset, offset + 16));
    const timestamp = data.readUInt32LE(offset + 16);
    const durationSeconds = data.readUInt16LE(offset + 20);
    const sizeKb = data.readUInt16LE(offset + 22);

    recordings.push({
      uuid,
      startedAt: new Date(timestamp * 1000),
      durationMs: durationSeconds * 1000,
      fileSizeBytes: sizeKb * 1024,
      codec: 'opus_16k', // Default, actual codec read separately
    });

    offset += entrySize;
  }

  return recordings;
}

/**
 * Format 16-byte UUID buffer to string
 */
function formatUuid(data: Buffer): string {
  const hex = data.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Parse transfer packet from device
 *
 * Format:
 * Byte 0:     Packet type (0x01=data, 0x02=EOF, 0xFF=error)
 * Bytes 1-2:  Sequence number
 * Bytes 3-4:  Chunk size (data) or CRC32 start (EOF)
 * Bytes 5+:   Audio data (data) or CRC32 remainder (EOF)
 */
export function parseTransferPacket(data: Buffer): TransferPacket {
  if (data.length < 3) {
    throw new Error(`Invalid transfer packet length: ${data.length}`);
  }

  const type = data.readUInt8(0);
  const sequenceNumber = data.readUInt16LE(1);

  switch (type) {
    case PACKET_TYPE_DATA:
      return {
        type: 'data',
        sequenceNumber,
        data: data.slice(5), // Skip header
      };

    case PACKET_TYPE_EOF:
      return {
        type: 'eof',
        sequenceNumber,
        checksum: data.readUInt32LE(3),
      };

    case PACKET_TYPE_ERROR:
      return {
        type: 'error',
        sequenceNumber,
        errorCode: data.length > 3 ? data.readUInt8(3) : 0xff,
      };

    default:
      throw new Error(`Unknown packet type: ${type}`);
  }
}

/**
 * Create time sync data buffer
 *
 * Format:
 * Bytes 0-3:  Unix timestamp (seconds)
 * Bytes 4-5:  Milliseconds (0-999)
 * Bytes 6-7:  Timezone offset (signed, minutes from UTC)
 */
export function createTimeSyncData(date: Date = new Date()): Buffer {
  const buffer = Buffer.alloc(8);
  const unixSeconds = Math.floor(date.getTime() / 1000);
  const milliseconds = date.getMilliseconds();
  const timezoneOffset = -date.getTimezoneOffset(); // getTimezoneOffset returns opposite sign

  buffer.writeUInt32LE(unixSeconds, 0);
  buffer.writeUInt16LE(milliseconds, 4);
  buffer.writeInt16LE(timezoneOffset, 6);

  return buffer;
}

/**
 * Create ACK packet for transfer
 *
 * Format:
 * Byte 0:    ACK type (0x10=ACK, 0x11=NACK, 0x12=Abort)
 * Bytes 1-2: Sequence number
 */
export function createAckPacket(
  ackType: 'ack' | 'nack' | 'abort',
  sequenceNumber: number
): Buffer {
  const buffer = Buffer.alloc(3);

  switch (ackType) {
    case 'ack':
      buffer.writeUInt8(0x10, 0);
      break;
    case 'nack':
      buffer.writeUInt8(0x11, 0);
      break;
    case 'abort':
      buffer.writeUInt8(0x12, 0);
      break;
  }

  buffer.writeUInt16LE(sequenceNumber, 1);
  return buffer;
}

/**
 * Create transfer control command
 *
 * Format:
 * Byte 0: Command (0x01=list, 0x02=start, 0x07=confirm)
 * Bytes 1+: Recording UUID (for start/confirm)
 */
export function createTransferCommand(
  command: 'list' | 'start' | 'confirm',
  recordingUuid?: string
): Buffer {
  let cmdByte: number;
  switch (command) {
    case 'list':
      cmdByte = 0x01;
      break;
    case 'start':
      cmdByte = 0x02;
      break;
    case 'confirm':
      cmdByte = 0x07;
      break;
  }

  if (recordingUuid) {
    const uuidBuffer = Buffer.from(recordingUuid.replace(/-/g, ''), 'hex');
    const buffer = Buffer.alloc(1 + uuidBuffer.length);
    buffer.writeUInt8(cmdByte, 0);
    uuidBuffer.copy(buffer, 1);
    return buffer;
  }

  return Buffer.from([cmdByte]);
}
