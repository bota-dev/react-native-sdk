/**
 * Device-related type definitions
 */

/**
 * Device type identifier
 */
export type DeviceType = 'bota_pin' | 'bota_pin_4g' | 'bota_note';

/**
 * Pairing state of a device
 */
export type PairingState = 'unpaired' | 'pairing' | 'paired' | 'error';

/**
 * Connection state of a device
 */
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'bonding'
  | 'discovering'
  | 'connected'
  | 'disconnecting';

/**
 * Device operational state
 */
export type DeviceState =
  | 'idle'
  | 'recording'
  | 'syncing'
  | 'uploading'
  | 'charging'
  | 'lowBattery'
  | 'storageFull'
  | 'error';

/**
 * Device status flags (1-byte bitmask)
 * See: FIRMWARE_INTEGRATION_GUIDE_ZH.md section 3.1 — DeviceFlags enum
 */
export interface DeviceFlags {
  charging: boolean;
  lowBattery: boolean;
  storageFull: boolean;
  wifiConnected: boolean;
  lteConnected: boolean;
  syncActive: boolean;
}

/**
 * LTE/4G modem status
 */
export type LteStatus =
  | 'off'
  | 'searching'
  | 'registered'
  | 'connected'
  | 'denied'
  | 'noSim'
  | 'error'
  | 'lowVoltage'
  | 'disabled';

/**
 * WiFi radio status
 */
export type WifiStatus =
  | 'off'
  | 'scanning'
  | 'connecting'
  | 'connected'
  | 'connectFailed'
  | 'noCredentials'
  | 'disabled'
  | 'error';

/**
 * Device discovered during Bluetooth scan (not yet connected)
 */
export interface DiscoveredDevice {
  /** Bluetooth device identifier (platform-specific UUID) */
  id: string;
  /** Device name from advertisement (e.g., "Bota-Pin-A1B2C3") */
  name: string;
  /** Device type parsed from advertisement */
  deviceType: DeviceType;
  /** Firmware version from manufacturer data */
  firmwareVersion: string;
  /** MAC address parsed from manufacturer data (null if firmware doesn't include it) */
  macAddress: string | null;
  /** Pairing state from manufacturer data */
  pairingState: PairingState;
  /** Signal strength (RSSI) */
  rssi: number;
  /** Raw manufacturer data bytes */
  manufacturerData?: Uint8Array;
  /** Timestamp when discovered */
  discoveredAt: Date;
}

/**
 * Device capabilities (bitmask)
 */
export interface DeviceCapabilities {
  /** Supports Bluetooth Sync (BLE transfer) */
  bleSync: boolean;
  /** Supports WiFi Upload */
  wifiUpload: boolean;
  /** Supports Cellular Upload (4G/LTE) */
  lteUpload: boolean;
  /** Supports Remote Recording Control */
  remoteRecord: boolean;
}

/**
 * Device after successful Bluetooth connection
 */
export interface ConnectedDevice {
  /** Bluetooth device identifier */
  id: string;
  /** Device serial number (read from Device Info service) */
  serialNumber: string;
  /** Device type */
  deviceType: DeviceType;
  /** Firmware version */
  firmwareVersion: string;
  /** Hardware revision (if available) */
  hardwareRevision?: string;
  /** Whether device has been provisioned with a token */
  isProvisioned: boolean;
  /** Current connection state */
  connectionState: ConnectionState;
  /** Negotiated MTU size */
  mtu: number;
  /** Device capabilities */
  capabilities?: DeviceCapabilities;
}

/**
 * 4G modem debug information (parsed from extended device status)
 */
export interface ModemInfo {
  imei?: string;
  iccid?: string;
  operator?: string;
  rat?: string;
  band?: string;
  apn?: string;
  simStatus?: string;
  csq?: number;
  ipAddress?: string;
  modemVoltage?: number;
  modemFirmware?: string;
  roaming?: boolean;
}

/**
 * Device status information
 */
export interface DeviceStatus {
  /** Battery level (0-100) */
  batteryLevel: number;
  /** Battery voltage in millivolts (e.g., 3700 = 3.7V) */
  batteryMv?: number;
  /** Total storage capacity in MB (uint16LE, max 65535) */
  storageTotalMb: number;
  /** Storage used in MB (uint16LE, max 65535) */
  storageUsedMb: number;
  /** Current operational state */
  state: DeviceState;
  /** Number of pending recordings to sync */
  pendingRecordings: number;
  /** Last clock-sync timestamp (when the device's RTC was last set
   *  from a time source — NTP, 4G QLTS/CCLK, or app Bluetooth time-sync).
   *  This is NOT the last recording-upload timestamp. */
  lastTimeSyncAt: Date | null;
  /** Signal strength (for 4G devices, 0-5) */
  signalStrength?: number;
  /** Status flags */
  flags: DeviceFlags;
  /** Raw timestamp from device */
  timestamp: number;
  /** LTE/4G modem status (for 4G devices) */
  lteStatus?: LteStatus;
  /** LTE signal quality — raw CSQ value 0-31 (99 = unknown) */
  lteSignalQuality?: number;
  /** WiFi radio status (for WiFi devices) */
  wifiStatus?: WifiStatus;
  /** 4G modem debug info (from extended device status read) */
  modemInfo?: ModemInfo;
}

/** A decoded line from the device's debug BLE log stream. */
export interface DeviceLogEvent {
  level: 'debug' | 'warn';
  message: string;
  isBacklog: boolean;
}

/**
 * Storage information from device
 */
export interface StorageInfo {
  /** Total storage in KB */
  totalKb: number;
  /** Used storage in KB */
  usedKb: number;
  /** Total recording count */
  totalRecordings: number;
  /** Pending sync count */
  pendingSyncCount: number;
}

/**
 * Options for reconnecting to a previously paired device by serial number
 */
export interface ReconnectOptions {
  /** Scan timeout in milliseconds (default: 10000) */
  scanTimeout?: number;
}

/**
 * Configuration for device scanning
 */
export interface ScanOptions {
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Filter by device types */
  deviceTypes?: DeviceType[];
  /** Filter by pairing state */
  pairingState?: PairingState;
  /** Minimum RSSI to include */
  minRssi?: number;
  /** Allow duplicates (same device reported multiple times) */
  allowDuplicates?: boolean;
}

/**
 * Environment for API endpoint configuration
 */
export type Environment = 'development' | 'gamma' | 'production';

/**
 * Provisioning result
 */
export interface ProvisioningResult {
  success: boolean;
  error?: 'invalid_token' | 'storage_error' | 'chunk_error' | 'already_paired' | 'unknown';
  /** Present on the three-byte authenticated factory-reset success result. */
  localRecordingsDeleted?: number;
}

/** Result returned by the authenticated BLE factory-reset close-loop. */
export type BleFactoryResetResult =
  | {
      success: true;
      localRecordingsDeleted: number;
    }
  | {
      success: false;
      error: NonNullable<ProvisioningResult['error']>;
    };

/**
 * Called after firmware reports a successful wipe and before the SDK sends
 * the explicit result receipt. Reject to leave firmware in its replayable
 * WIPED phase.
 */
export type BleFactoryResetResultPersister = (
  result: Extract<BleFactoryResetResult, { success: true }>
) => Promise<void>;

// ============================================================================
// Remote Recording Control Types
// ============================================================================

/**
 * Recording command type
 */
export type RecordingCommandType = 'start_recording' | 'stop_recording';

/**
 * Recording command status
 */
export type RecordingCommandStatus =
  | 'pending'
  | 'delivered'
  | 'executed'
  | 'failed'
  | 'expired'
  | 'cancelled';

/**
 * Options for starting recording remotely
 */
export interface StartRecordingOptions {
  /** Maximum recording duration in seconds (auto-stop) */
  maxDurationSec?: number;
  /** Metadata to attach to the recording */
  metadata?: Record<string, unknown>;
}

/**
 * Options for stopping recording remotely
 */
export interface StopRecordingOptions {
  /** Whether to trigger immediate upload after stopping */
  uploadImmediately?: boolean;
}

/**
 * Recording command result
 */
export interface RecordingCommandResult {
  /** Command ID from backend */
  commandId: string;
  /** Recording ID (for start_recording) */
  recordingId?: string;
  /** When recording started */
  startedAt?: Date;
  /** When recording stopped */
  stoppedAt?: Date;
  /** Recording duration in seconds */
  durationSeconds?: number;
}

/**
 * Recording command error
 */
export interface RecordingCommandError {
  code: string;
  message: string;
}

/**
 * Full recording command response
 */
export interface RecordingCommand {
  id: string;
  deviceId: string;
  type: RecordingCommandType;
  status: RecordingCommandStatus;
  grantToken: string;
  result?: RecordingCommandResult;
  error?: RecordingCommandError;
  expiresAt?: Date;
  createdAt: Date;
}

/**
 * Current recording state of the device
 */
export interface RecordingState {
  /** Whether device is currently recording */
  active: boolean;
  /** Current recording ID (if recording) */
  recordingId?: string;
  /** When recording started */
  startedAt?: Date;
  /** Duration in seconds (updated periodically) */
  durationSeconds?: number;
  /** Who initiated the recording */
  initiatedBy?: 'local' | 'remote';
}

// ============================================================================
// Connection Settings Types
// ============================================================================

/**
 * Connection type for network preference ordering
 */
export type ConnectionType = 'wifi' | 'ble' | 'cellular';

/**
 * Per-device connection settings read/written via Bluetooth DEVICE_SETTINGS characteristic
 */
export interface DeviceConnectionSettings {
  enabled_connections: {
    wifi: boolean;
    cellular: boolean;
  };
  heartbeat_enabled_connections?: {
    wifi: boolean;
    cellular: boolean;
  };
  upload_network_preference: ConnectionType[];
  power_management?: {
    wifi_idle_timeout_seconds?: number | null;      // null/omitted=180, -1=always-on, 0=immediate, legacy 1-9=>10, 10-2540=custom
    cellular_idle_timeout_seconds?: number | null;  // null/omitted=180, -1=always-on, 0=immediate, legacy 1-9=>10, 10-2540=custom
  };
  streaming_enabled?: boolean;  // Upload-while-recording (default: true)
  streaming_flush_interval_seconds?: number;  // 0=disabled, 1-128=seconds (default: 60)
}

// ============================================================================
// WiFi Upload Configuration Types
// ============================================================================

/**
 * WiFi security type
 */
export type WiFiSecurityType = 'WPA2' | 'WPA3' | 'WEP' | 'OPEN';

/**
 * WiFi connection status
 */
export type WiFiStatus = 'idle' | 'connecting' | 'connected' | 'failed' | 'disconnected';

/**
 * WiFi configuration grant from backend
 */
export interface WiFiConfigGrant {
  /** Grant blob (JWT token) */
  grantBlob: string;
  /** Expiration timestamp */
  expiresAt: Date;
}

/**
 * WiFi credentials to configure
 */
export interface WiFiCredentials {
  /** WiFi network SSID */
  ssid: string;
  /** WiFi password */
  password: string;
  /** Security type (default: WPA2) */
  securityType?: WiFiSecurityType;
}

/**
 * WiFi configuration result from device
 */
export interface WiFiConfigResult {
  /** Whether configuration was successful */
  success: boolean;
  /** Error code if failed */
  error?: 'invalid_grant' | 'grant_expired' | 'decryption_error' | 'storage_error' | 'unknown';
}

/**
 * WiFi status information from device
 */
export interface WiFiStatusInfo {
  /** Current WiFi connection status */
  status: WiFiStatus;
  /** Connected SSID (if connected) */
  ssid?: string;
  /** Signal strength (0-100) */
  signalStrength?: number;
  /** Last connection error (if failed) */
  lastError?: string;
}

// ============================================================================
// Device-Side WiFi Scanning Types
// ============================================================================

/**
 * A WiFi network discovered by the device's WiFi radio
 */
export interface WiFiScanNetwork {
  /** Network SSID */
  ssid: string;
  /** Signal quality 0-100 */
  quality: number;
  /** Whether this is the currently connected network */
  isCurrent: boolean;
  /** Open network (no password required) */
  isOpen?: boolean;
}

/**
 * Result of a device-side WiFi scan
 */
export interface DeviceWiFiScanResult {
  /** Discovered networks sorted by signal quality */
  networks: WiFiScanNetwork[];
  /** SSID of the currently connected network, if any */
  currentSsid: string | null;
}
