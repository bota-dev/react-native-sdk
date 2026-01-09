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
 * Device status flags
 */
export interface DeviceFlags {
  charging: boolean;
  usbConnected: boolean;
  lowBattery: boolean;
  criticalBattery: boolean;
  storageWarning: boolean;
  storageFull: boolean;
  cellularAvailable: boolean;
  cellularRoaming: boolean;
  wifiConnected: boolean;
  recordingActive: boolean;
  syncRequired: boolean;
  updateAvailable: boolean;
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
}

/**
 * Device status information
 */
export interface DeviceStatus {
  /** Battery level (0-100) */
  batteryLevel: number;
  /** Storage used percentage (0-100) */
  storageUsedPercent: number;
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
