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
 * Device discovered during BLE scan (not yet connected)
 */
export interface DiscoveredDevice {
  /** BLE device identifier (platform-specific UUID) */
  id: string;
  /** Device name from advertisement (e.g., "Bota-Pin-A1B2C3") */
  name: string;
  /** Device type parsed from advertisement */
  deviceType: DeviceType;
  /** Firmware version from manufacturer data */
  firmwareVersion: string;
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
 * Device after successful BLE connection
 */
export interface ConnectedDevice {
  /** BLE device identifier */
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
 * Device status information
 */
export interface DeviceStatus {
  /** Battery level (0-100) */
  batteryLevel: number;
  /** Total storage capacity in MB (uint16LE, max 65535) */
  storageTotalMb: number;
  /** Storage used in MB (uint16LE, max 65535) */
  storageUsedMb: number;
  /** Current operational state */
  state: DeviceState;
  /** Number of pending recordings to sync */
  pendingRecordings: number;
  /** Last sync timestamp */
  lastSyncAt: Date | null;
  /** Signal strength (for 4G devices, 0-5) */
  signalStrength?: number;
  /** Status flags */
  flags: DeviceFlags;
  /** Raw timestamp from device */
  timestamp: number;
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
export type Environment = 'production' | 'sandbox';

/**
 * Provisioning result
 */
export interface ProvisioningResult {
  success: boolean;
  error?: 'invalid_token' | 'storage_error' | 'chunk_error' | 'unknown';
}

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
