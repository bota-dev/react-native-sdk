/**
 * Status and configuration type definitions
 */

import type { DeviceStatus, StorageInfo } from './Device';
import type { SyncProgress, UploadTask } from './Recording';

/**
 * SDK log level
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

/**
 * SDK configuration options
 */
export interface BotaConfig {
  /** Environment for API endpoint (development, gamma, or production) */
  environment?: 'development' | 'gamma' | 'production';
  /** Enable background sync (default: true) */
  backgroundSyncEnabled?: boolean;
  /** Only upload on WiFi (default: false) */
  wifiOnlyUpload?: boolean;
  /** Logging level (default: 'warn') */
  logLevel?: LogLevel;
  /** Enable debug mode with verbose logging */
  debug?: boolean;
}

/**
 * SDK state
 */
export type SdkState = 'uninitialized' | 'initializing' | 'ready' | 'error';

/**
 * Bluetooth state
 */
export type BluetoothState =
  | 'unknown'
  | 'resetting'
  | 'unsupported'
  | 'unauthorized'
  | 'poweredOff'
  | 'poweredOn';

/**
 * SDK status information
 */
export interface SdkStatus {
  /** Current SDK state */
  state: SdkState;
  /** Bluetooth state */
  bluetoothState: BluetoothState;
  /** Whether Bluetooth is ready for operations */
  isBluetoothReady: boolean;
  /** Number of connected devices */
  connectedDevicesCount: number;
  /** Number of pending uploads in queue */
  pendingUploadsCount: number;
}

// Re-export for convenience
export type { DeviceStatus, StorageInfo, SyncProgress, UploadTask };

/**
 * Event types emitted by DeviceManager
 */
export interface DeviceManagerEvents {
  /** Emitted when a device is discovered during scan */
  deviceDiscovered: (device: import('./Device').DiscoveredDevice) => void;
  /** Emitted when a device is connected */
  deviceConnected: (device: import('./Device').ConnectedDevice) => void;
  /** Emitted when a device is disconnected */
  deviceDisconnected: (deviceId: string, error?: Error) => void;
  /** Emitted when device status is updated */
  deviceStatusUpdated: (
    deviceId: string,
    status: import('./Device').DeviceStatus
  ) => void;
  /** Emitted when scan starts */
  scanStarted: () => void;
  /** Emitted when scan stops */
  scanStopped: () => void;
  /** Emitted on scan error */
  scanError: (error: Error) => void;
  /** Emitted on connection state change */
  connectionStateChanged: (
    deviceId: string,
    state: import('./Device').ConnectionState
  ) => void;
  /** Emitted when Bluetooth powers back on (off → on transition) */
  bluetoothReady: () => void;
}

/**
 * Event types emitted by RecordingManager
 */
export interface RecordingManagerEvents {
  /** Emitted when sync starts for a recording */
  syncStarted: (deviceRecordingUuid: string) => void;
  /** Emitted on sync progress update */
  syncProgress: (deviceRecordingUuid: string, progress: SyncProgress) => void;
  /** Emitted when sync completes successfully */
  syncCompleted: (deviceRecordingUuid: string, recordingId: string) => void;
  /** Emitted when sync fails */
  syncFailed: (deviceRecordingUuid: string, error: Error) => void;
  /** Emitted when upload queue changes */
  queueUpdated: (tasks: UploadTask[]) => void;
  /** Emitted when an upload starts */
  uploadStarted: (taskId: string) => void;
  /** Emitted on upload progress */
  uploadProgress: (taskId: string, progress: number) => void;
  /** Emitted when an upload completes */
  uploadCompleted: (taskId: string, recordingId: string) => void;
  /** Emitted when an upload fails */
  uploadFailed: (taskId: string, error: Error) => void;
}

/**
 * Event types emitted by BotaClient
 */
export interface BotaClientEvents {
  /** Emitted when SDK state changes */
  stateChanged: (state: SdkState) => void;
  /** Emitted when Bluetooth state changes */
  bluetoothStateChanged: (state: BluetoothState) => void;
  /** Emitted on SDK error */
  error: (error: Error) => void;
}
