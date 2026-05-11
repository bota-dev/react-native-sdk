/**
 * Bluetooth data parsers for Bota device protocol
 */

import { Buffer } from 'buffer';

import type {
  DeviceType,
  PairingState,
  DeviceState,
  DeviceStatus,
  DeviceFlags,
  LteStatus,
  WifiStatus,
  StorageInfo,
  DeviceCapabilities,
  WiFiStatus,
  WiFiStatusInfo,
  WiFiConfigResult,
  WiFiScanNetwork,
  DeviceWiFiScanResult,
  ConnectionType,
  DeviceConnectionSettings,
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
  FLAG_LOW_BATTERY,
  FLAG_STORAGE_FULL,
  FLAG_WIFI_CONNECTED,
  FLAG_LTE_CONNECTED,
  FLAG_SYNC_ACTIVE,
  CODEC_PCM_16K,
  CODEC_PCM_8K,
  CODEC_OPUS_16K,
  CODEC_OPUS_8K,
  PACKET_TYPE_DATA,
  PACKET_TYPE_EOF,
  PACKET_TYPE_PAUSED,
  PACKET_TYPE_E2E_START,
  PACKET_TYPE_ENCRYPTED_DATA,
  PACKET_TYPE_ENCRYPTED_EOF,
  PACKET_TYPE_ERROR,
  CAP_BLE_SYNC,
  CAP_WIFI_UPLOAD,
  CAP_LTE_UPLOAD,
  CAP_REMOTE_RECORD,
  WIFI_STATUS_IDLE,
  WIFI_STATUS_CONNECTING,
  WIFI_STATUS_CONNECTED,
  WIFI_STATUS_FAILED,
  WIFI_STATUS_DISCONNECTED,
  WIFI_CONFIG_SUCCESS,
  WIFI_CONFIG_INVALID_GRANT,
  WIFI_CONFIG_GRANT_EXPIRED,
  WIFI_CONFIG_DECRYPTION_ERROR,
  WIFI_CONFIG_STORAGE_ERROR,
  WIFI_SCAN_CMD_START,
  WIFI_SCAN_STATUS_DONE,
  WIFI_SCAN_STATUS_ERROR,
  LTE_STATUS_OFF,
  LTE_STATUS_SEARCHING,
  LTE_STATUS_REGISTERED,
  LTE_STATUS_CONNECTED,
  LTE_STATUS_DENIED,
  LTE_STATUS_NO_SIM,
  LTE_STATUS_ERROR,
  LTE_STATUS_LOW_VOLTAGE,
  LTE_STATUS_DISABLED,
  WIFI_RADIO_OFF,
  WIFI_RADIO_SCANNING,
  WIFI_RADIO_CONNECTING,
  WIFI_RADIO_CONNECTED,
  WIFI_RADIO_CONNECT_FAILED,
  WIFI_RADIO_NO_CREDENTIALS,
  WIFI_RADIO_DISABLED,
  WIFI_RADIO_ERROR,
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
 * Parse device flags from 1-byte bitmask
 * See: FIRMWARE_INTEGRATION_GUIDE_ZH.md section 3.1 — DeviceFlags enum
 */
export function parseDeviceFlags(value: number): DeviceFlags {
  return {
    charging: (value & FLAG_CHARGING) !== 0,
    lowBattery: (value & FLAG_LOW_BATTERY) !== 0,
    storageFull: (value & FLAG_STORAGE_FULL) !== 0,
    wifiConnected: (value & FLAG_WIFI_CONNECTED) !== 0,
    lteConnected: (value & FLAG_LTE_CONNECTED) !== 0,
    syncActive: (value & FLAG_SYNC_ACTIVE) !== 0,
  };
}

/**
 * Parse LTE/4G modem status from byte value
 */
export function parseLteStatus(byte: number): LteStatus {
  switch (byte) {
    case LTE_STATUS_OFF:
      return 'off';
    case LTE_STATUS_SEARCHING:
      return 'searching';
    case LTE_STATUS_REGISTERED:
      return 'registered';
    case LTE_STATUS_CONNECTED:
      return 'connected';
    case LTE_STATUS_DENIED:
      return 'denied';
    case LTE_STATUS_NO_SIM:
      return 'noSim';
    case LTE_STATUS_ERROR:
      return 'error';
    case LTE_STATUS_LOW_VOLTAGE:
      return 'lowVoltage';
    case LTE_STATUS_DISABLED:
      return 'disabled';
    default:
      return 'off';
  }
}

/**
 * Parse WiFi radio status from byte value
 */
export function parseWifiStatus(byte: number): WifiStatus {
  switch (byte) {
    case WIFI_RADIO_OFF:
      return 'off';
    case WIFI_RADIO_SCANNING:
      return 'scanning';
    case WIFI_RADIO_CONNECTING:
      return 'connecting';
    case WIFI_RADIO_CONNECTED:
      return 'connected';
    case WIFI_RADIO_CONNECT_FAILED:
      return 'connectFailed';
    case WIFI_RADIO_NO_CREDENTIALS:
      return 'noCredentials';
    case WIFI_RADIO_DISABLED:
      return 'disabled';
    case WIFI_RADIO_ERROR:
      return 'error';
    default:
      return 'off';
  }
}

/**
 * Parse device status from characteristic value
 *
 * Firmware format (15 bytes, backwards-compatible with 14):
 * Byte 0:      Battery % (0-100)
 * Byte 1:      LTE status (BOTA_LTE_* code)
 * Byte 2:      Device state
 * Byte 3:      Pending recordings count
 * Bytes 4-7:   Last sync timestamp (Unix seconds)
 * Byte 8:      Flags (1-byte bitmask)
 * Bytes 9-10:  Storage total MB (uint16LE)
 * Bytes 11-12: Storage used MB (uint16LE)
 * Byte 13:     LTE signal quality (CSQ 0-31, 99=unknown)
 * Byte 14:     WiFi status (BOTA_WIFI_* code) — optional, firmware >= 1.1
 */
export function parseDeviceStatus(data: Buffer): DeviceStatus {
  if (data.length < 14) {
    throw new Error(`Invalid status data length: ${data.length}`);
  }

  const batteryLevel = data.readUInt8(0);
  const lteStatusByte = data.readUInt8(1);
  const state = parseDeviceState(data.readUInt8(2));
  const pendingRecordings = data.readUInt8(3);
  const lastTimeSyncTimestamp = data.readUInt32LE(4);
  const flagsValue = data.readUInt8(8);
  const flags = parseDeviceFlags(flagsValue);
  const storageTotalMb = data.readUInt16LE(9);
  const storageUsedMb = data.readUInt16LE(11);
  const lteSignalByte = data.readUInt8(13);

  const lteStatus = parseLteStatus(lteStatusByte);
  const lteSignalQuality = lteSignalByte !== 99 && lteSignalByte !== 0xFF
    ? lteSignalByte : undefined;

  // Byte 14: WiFi radio status (added in firmware 1.1, backwards-compatible)
  const wifiStatusByte = data.length >= 15 ? data.readUInt8(14) : undefined;
  const wifiStatus = wifiStatusByte !== undefined ? parseWifiStatus(wifiStatusByte) : undefined;

  // Bytes 15-16: Battery voltage in millivolts (uint16LE)
  const batteryMv = data.length >= 17 ? data.readUInt16LE(15) : undefined;

  // Modem info string starts at byte 17 (was byte 14 in older firmware)
  let modemInfo: import('../models/Device').ModemInfo | undefined;
  if (data.length > 17) {
    const raw = Buffer.from(data.subarray(17)).toString('utf8');
    modemInfo = parseModemInfoString(raw);
  }

  return {
    batteryLevel,
    batteryMv: batteryMv && batteryMv > 0 ? batteryMv : undefined,
    storageTotalMb,
    storageUsedMb,
    state,
    pendingRecordings,
    lastTimeSyncAt: lastTimeSyncTimestamp > 0 ? new Date(lastTimeSyncTimestamp * 1000) : null,
    signalStrength: 0,
    flags,
    timestamp: lastTimeSyncTimestamp,
    /* Always emit the parsed LTE status — including 'off'. Suppressing
     * 'off' here makes downstream consumers (e.g. BLE-relay heartbeat)
     * unable to clear stale "connected" state on the backend after the
     * modem idles down. */
    lteStatus,
    lteSignalQuality,
    wifiStatus,
    modemInfo,
  };
}

function parseModemInfoString(raw: string): import('../models/Device').ModemInfo | undefined {
  const info: import('../models/Device').ModemInfo = {};
  let hasAny = false;
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.substring(0, eq);
    const val = line.substring(eq + 1).replace(/\0/g, '');
    if (!val) continue;
    hasAny = true;
    switch (key) {
      case 'IMEI': info.imei = val; break;
      case 'ICCID': info.iccid = val; break;
      case 'OP': info.operator = val; break;
      case 'RAT': info.rat = val; break;
      case 'BAND': info.band = val; break;
      case 'APN': info.apn = val; break;
      case 'SIM': info.simStatus = val; break;
      case 'CSQ': { const n = parseInt(val, 10); if (!isNaN(n)) info.csq = n; break; }
      case 'IP': info.ipAddress = val; break;
      case 'MV': { const n = parseInt(val, 10); if (!isNaN(n) && n > 0) info.modemVoltage = n; break; }
      case 'FW': info.modemFirmware = val; break;
      case 'ROAM': info.roaming = val === '1'; break;
    }
  }
  return hasAny ? info : undefined;
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
 * Each recording entry is 24 bytes:
 * - file_id:    bytes [0:4]   (4-byte file ID, bytes [4:16] zero-padded)
 * - flags:      byte  [4]     (bit 0 = encrypted at rest, P4)
 * - reserved:   bytes [5:16]
 * - timestamp:  bytes [16:20] (u32 LE, Unix seconds)
 * - duration:   bytes [20:22] (u16 LE, seconds)
 * - size_kb:    bytes [22:24] (u16 LE, kilobytes)
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
    const flags = data.readUInt8(offset + 4);
    const isEncrypted = (flags & 0x01) !== 0;
    const timestamp = data.readUInt32LE(offset + 16);
    const durationSeconds = data.readUInt16LE(offset + 20);
    const sizeKb = data.readUInt16LE(offset + 22);

    recordings.push({
      uuid,
      startedAt: timestamp > 0 ? new Date(timestamp * 1000) : new Date(),
      durationMs: durationSeconds * 1000,
      fileSizeBytes: sizeKb * 1024,
      codec: 'opus_16k', // Default, actual codec read separately
      isEncrypted,
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

    case PACKET_TYPE_PAUSED:
      return {
        type: 'paused',
        sequenceNumber,
        bytesSent: data.length >= 7 ? data.readUInt32LE(3) : undefined,
      };

    case PACKET_TYPE_E2E_START: {
      // [type=0x05, eph_pk[32], salt[4]] = 37 bytes. P10 streaming AEAD session.
      if (data.length < 1 + 32 + 4) {
        throw new Error(`E2E_START packet too short: ${data.length}`);
      }
      return {
        type: 'e2e_start',
        sequenceNumber: 0,
        e2eEphemeralPk: data.slice(1, 33),
        e2eSalt: data.slice(33, 37),
      };
    }

    case PACKET_TYPE_ENCRYPTED_DATA:
      // Same header as DATA: [type, seq(LE), wire_len(LE), ciphertext..., tag(16)].
      // wire_len at bytes 3..4 covers the entire payload (ciphertext + tag).
      return {
        type: 'encrypted_data',
        sequenceNumber,
        e2eChunk: data.slice(5),
      };

    case PACKET_TYPE_ENCRYPTED_EOF:
      // [type=0x82, seq(LE), 0u32]. CRC field unused — per-chunk tags cover integrity.
      return {
        type: 'encrypted_eof',
        sequenceNumber,
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
 * Parse trigger device upload response from TRANSFER_STATUS notification.
 * Format: [0x03, status_code]
 * Returns null if not a trigger response (different opcode).
 */
export interface TriggerDeviceUploadResponse {
  accepted: boolean;
  errorCode?: number; // 0x01=no_network, 0x02=busy, 0x03=no_token
}

export function parseTriggerDeviceUploadResponse(
  data: Buffer,
): TriggerDeviceUploadResponse | null {
  if (data.length < 2 || data.readUInt8(0) !== 0x03) {
    return null;
  }
  const code = data.readUInt8(1);
  return {
    accepted: code === 0x00,
    errorCode: code === 0x00 ? undefined : code,
  };
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
  command: 'list' | 'start' | 'triggerDeviceUpload' | 'confirm',
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
    case 'triggerDeviceUpload':
      cmdByte = 0x03;
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

// ============================================================================
// WiFi Upload Configuration Parsers
// ============================================================================

/**
 * Parse device capabilities from byte value
 */
export function parseDeviceCapabilities(byte: number): DeviceCapabilities {
  return {
    bleSync: (byte & CAP_BLE_SYNC) !== 0,
    wifiUpload: (byte & CAP_WIFI_UPLOAD) !== 0,
    lteUpload: (byte & CAP_LTE_UPLOAD) !== 0,
    remoteRecord: (byte & CAP_REMOTE_RECORD) !== 0,
  };
}

/**
 * Parse WiFi status from byte value
 */
export function parseWiFiStatus(byte: number): WiFiStatus {
  switch (byte) {
    case WIFI_STATUS_IDLE:
      return 'idle';
    case WIFI_STATUS_CONNECTING:
      return 'connecting';
    case WIFI_STATUS_CONNECTED:
      return 'connected';
    case WIFI_STATUS_FAILED:
      return 'failed';
    case WIFI_STATUS_DISCONNECTED:
      return 'disconnected';
    default:
      return 'idle';
  }
}

/**
 * Parse WiFi status information from characteristic value
 *
 * Format:
 * Byte 0:      Status (0x00=idle, 0x01=connecting, 0x02=connected, 0x03=failed, 0x04=disconnected)
 * Byte 1:      Signal strength (0-100)
 * Byte 2:      SSID length
 * Bytes 3-34:  SSID (max 32 bytes)
 * Bytes 35+:   Error message (if status=failed)
 */
export function parseWiFiStatusInfo(data: Buffer): WiFiStatusInfo {
  if (data.length < 1) {
    throw new Error(`Invalid WiFi status data length: ${data.length}`);
  }

  const status = parseWiFiStatus(data.readUInt8(0));

  // Short notifications (1-2 bytes) come from config result codes — return status only
  if (data.length < 3) {
    return { status };
  }

  const signalStrength = data.readUInt8(1);
  const ssidLength = data.readUInt8(2);

  let ssid: string | undefined;
  let lastError: string | undefined;

  if (ssidLength > 0 && data.length >= 3 + ssidLength) {
    ssid = data.slice(3, 3 + ssidLength).toString('utf-8');
  }

  if (status === 'failed' && data.length > 3 + ssidLength) {
    lastError = data.slice(3 + ssidLength).toString('utf-8');
  }

  return {
    status,
    signalStrength: signalStrength > 0 ? signalStrength : undefined,
    ssid,
    lastError,
  };
}

/**
 * Parse WiFi configuration result from characteristic value
 *
 * Format:
 * Byte 0: Result code (0x00=success, 0x01=invalid_grant, 0x02=grant_expired, 0x03=decryption_error, 0x04=storage_error)
 */
export function parseWiFiConfigResult(data: Buffer): WiFiConfigResult {
  if (data.length < 1) {
    throw new Error(`Invalid WiFi config result length: ${data.length}`);
  }

  const code = data.readUInt8(0);

  switch (code) {
    case WIFI_CONFIG_SUCCESS:
      return { success: true };
    case WIFI_CONFIG_INVALID_GRANT:
      return { success: false, error: 'invalid_grant' };
    case WIFI_CONFIG_GRANT_EXPIRED:
      return { success: false, error: 'grant_expired' };
    case WIFI_CONFIG_DECRYPTION_ERROR:
      return { success: false, error: 'decryption_error' };
    case WIFI_CONFIG_STORAGE_ERROR:
      return { success: false, error: 'storage_error' };
    default:
      return { success: false, error: 'unknown' };
  }
}

/**
 * Create WiFi grant submission packet
 *
 * Format:
 * Bytes 0-N: Grant blob (JWT token as UTF-8 string)
 */
export function createWiFiGrantPacket(grantBlob: string): Buffer {
  return Buffer.from(grantBlob, 'utf-8');
}

// ============================================================================
// Device-Side WiFi Scanning Parsers
// ============================================================================

/**
 * Create WiFi scan start command
 */
export function createWiFiScanCommand(): Buffer {
  return Buffer.from([WIFI_SCAN_CMD_START]);
}

/**
 * Parse device-side WiFi scan result from characteristic notification.
 *
 * Format:
 * Byte 0:      Status (0x01=scanning, 0x02=done, 0x03=error)
 * Byte 1:      Network count (when status=done)
 * For each network:
 *   Byte 0:    SSID length
 *   Bytes 1-N: SSID (UTF-8)
 *   Byte N+1:  Signal quality (0-100)
 *   Byte N+2:  Flags (bit 0 = isCurrent)
 *
 * Returns null if status is not 'done' (still scanning).
 */
export function parseWiFiScanResult(data: Buffer): DeviceWiFiScanResult | null {
  if (data.length < 1) {
    throw new Error(`Invalid WiFi scan result length: ${data.length}`);
  }

  const status = data.readUInt8(0);

  if (status === WIFI_SCAN_STATUS_ERROR) {
    throw new Error('Device WiFi scan failed');
  }

  if (status !== WIFI_SCAN_STATUS_DONE) {
    return null; // Still scanning (single-byte status is valid)
  }

  if (data.length < 2) {
    throw new Error(`Invalid WiFi scan done result length: ${data.length}`);
  }

  const count = data.readUInt8(1);
  const networks: WiFiScanNetwork[] = [];
  let currentSsid: string | null = null;
  let offset = 2;

  for (let i = 0; i < count && offset < data.length; i++) {
    const ssidLen = data.readUInt8(offset);
    offset += 1;

    if (offset + ssidLen + 2 > data.length) break;

    const ssid = data.slice(offset, offset + ssidLen).toString('utf-8');
    offset += ssidLen;

    const quality = data.readUInt8(offset);
    offset += 1;

    const flags = data.readUInt8(offset);
    offset += 1;

    const isCurrent = (flags & 0x01) !== 0;
    const isOpen = (flags & 0x02) !== 0;
    if (isCurrent) currentSsid = ssid;

    networks.push({ ssid, quality, isCurrent, isOpen });
  }

  return { networks, currentSsid };
}

// ============================================================================
// Connection Settings Serialization
// ============================================================================

const CONN_ID_WIFI = 1;
const CONN_ID_BLE = 2;
const CONN_ID_4G = 3;

function connectionTypeToId(type: ConnectionType): number {
  switch (type) {
    case 'wifi': return CONN_ID_WIFI;
    case 'ble': return CONN_ID_BLE;
    case 'cellular': return CONN_ID_4G;
  }
}

function idToConnectionType(id: number): ConnectionType | null {
  switch (id) {
    case CONN_ID_WIFI: return 'wifi';
    case CONN_ID_BLE: return 'ble';
    case CONN_ID_4G: return 'cellular';
    default: return null;
  }
}

/**
 * Serialize connection settings to 12-byte buffer for Bluetooth DEVICE_SETTINGS characteristic.
 *
 * Layout (v0x02):
 * Byte 0: version (0x02)
 * Byte 1: enabled_mask — bit 0: WiFi, bit 1: 4G (BLE always on)
 * Byte 2: upload_network_preference[0] — 1=WiFi, 2=BLE, 3=4G, 0=end
 * Byte 3: upload_network_preference[1]
 * Byte 4: upload_network_preference[2]
 * Byte 5: power_cfg_4g — 0=default(180s), 1-254=value×10s, 255=always-on
 * Byte 6: power_cfg_wifi — 0=default(180s), 1-254=value×10s, 255=always-on
 * Byte 7: streaming_enabled (0x00=off, 0x01=on)
 * Byte 8: chunk_flush_interval_s (0=disabled, 1-128=seconds, default 60)
 * Bytes 9-11: reserved (0x00)
 */
export function serializeConnectionSettings(settings: DeviceConnectionSettings): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt8(0x02, 0); // version

  let mask = 0;
  if (settings.enabled_connections.wifi) mask |= 0x01;
  if (settings.enabled_connections.cellular) mask |= 0x02;
  buf.writeUInt8(mask, 1);

  for (let i = 0; i < 3; i++) {
    if (i < settings.upload_network_preference.length) {
      buf.writeUInt8(connectionTypeToId(settings.upload_network_preference[i]), 2 + i);
    } else {
      buf.writeUInt8(0, 2 + i); // end marker
    }
  }

  const pm = settings.power_management;
  if (pm) {
    buf.writeUInt8(pm.cellular_idle_timeout_seconds === 0 ? 0xFF :
      Math.round(pm.cellular_idle_timeout_seconds / 10), 5);
    buf.writeUInt8(pm.wifi_idle_timeout_seconds === 0 ? 0xFF :
      Math.round(pm.wifi_idle_timeout_seconds / 10), 6);
  }
  // else bytes 5-6 stay 0x00 (firmware default 180s)

  buf.writeUInt8(settings.streaming_enabled === false ? 0x00 : 0x01, 7);

  const flush = settings.streaming_flush_interval_seconds ?? 60;
  buf.writeUInt8(Math.max(0, Math.min(128, flush)), 8);

  return buf;
}

/**
 * Parse buffer from Bluetooth DEVICE_SETTINGS characteristic into connection settings.
 * Accepts v0x01 (8 bytes) and v0x02 (12 bytes). Returns defaults for unknown versions.
 */
export function parseConnectionSettings(data: Buffer): DeviceConnectionSettings {
  const version = data.length >= 1 ? data.readUInt8(0) : 0;
  if (data.length < 8 || (version !== 0x01 && version !== 0x02)) {
    // Unknown version or empty — return defaults
    return {
      enabled_connections: { wifi: true, cellular: true },
      upload_network_preference: ['wifi', 'ble', 'cellular'],
    };
  }

  const mask = data.readUInt8(1);
  const enabled_connections = {
    wifi: (mask & 0x01) !== 0,
    cellular: (mask & 0x02) !== 0,
  };

  const upload_network_preference: ConnectionType[] = [];
  for (let i = 0; i < 3; i++) {
    const id = data.readUInt8(2 + i);
    if (id === 0) break;
    const type = idToConnectionType(id);
    if (type) upload_network_preference.push(type);
  }

  const raw4g = data.readUInt8(5);
  const rawWifi = data.readUInt8(6);
  const power_management = {
    cellular_idle_timeout_seconds: raw4g === 0xFF ? 0 : (raw4g === 0 ? 180 : raw4g * 10),
    wifi_idle_timeout_seconds: rawWifi === 0xFF ? 0 : (rawWifi === 0 ? 180 : rawWifi * 10),
  };

  const streaming_enabled = data.readUInt8(7) !== 0x00;

  const streaming_flush_interval_seconds =
    version === 0x02 && data.length >= 9 ? data.readUInt8(8) : 60;

  return { enabled_connections, upload_network_preference, power_management, streaming_enabled, streaming_flush_interval_seconds };
}
