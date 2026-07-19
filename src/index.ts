/**
 * Bota React Native SDK
 *
 * SDK for communicating with Bota wearable devices via BLE.
 *
 * @packageDocumentation
 */

// Main client
export { BotaClient } from './BotaClient';
export type { BotaConfig, SdkState, BluetoothState } from './BotaClient';

// Managers
export { DeviceManager, RecordingManager, StreamingSession, OTAManager } from './managers';
export type {
  UploadInfoProvider,
  FirmwareInfo,
  FirmwareDownloadProgressCallback,
  OtaStage,
  OtaProgress,
} from './managers';

// Device-state cache (in-memory, SN-keyed; consumers persist if needed)
export type {
  CachedDeviceState,
  DeviceStatePatch,
  DeviceStateCacheEvents,
} from './cache/DeviceStateCache';

// Models - Device
export type {
  DeviceType,
  PairingState,
  ConnectionState,
  DeviceState,
  DeviceFlags,
  LteStatus,
  WifiStatus,
  ModemInfo,
  DiscoveredDevice,
  ConnectedDevice,
  DeviceStatus,
  StorageInfo,
  ScanOptions,
  ReconnectOptions,
  Environment,
  ProvisioningResult,
  DeviceCapabilities,
  WiFiSecurityType,
  WiFiStatus,
  WiFiConfigGrant,
  WiFiCredentials,
  WiFiConfigResult,
  WiFiStatusInfo,
  WiFiScanNetwork,
  DeviceWiFiScanResult,
  ConnectionType,
  DeviceConnectionSettings,
} from './models/Device';

// Models - Recording
export type {
  AudioCodec,
  DeviceRecording,
  UploadInfo,
  SyncStage,
  SyncProgress,
  UploadTaskStatus,
  UploadTask,
  TransferPacket,
  StreamingState,
  StreamingSyncProgress,
  StreamingSyncOptions,
  StreamingSessionEvents,
} from './models/Recording';

// Models - Status & Events
export type {
  LogLevel,
  SdkStatus,
  DeviceManagerEvents,
  RecordingManagerEvents,
  BotaClientEvents,
} from './models/Status';

// Sync status — centralized derivation of "what's happening with recordings".
// Pure function; consumers wire their stores/hooks to call it.
export { deriveSyncStatus } from './sync/syncStatus';
export type {
  SyncStatus,
  SyncStatusInputs,
  SyncKind,
  SyncChannel,
} from './sync/syncStatus';

// Logger types
export type { LogHandler, SdkLogEntry, SdkLogLevel } from './utils/logger';

// Errors
export {
  BotaError,
  BluetoothError,
  DeviceError,
  ProvisioningError,
  TransferError,
  UploadError,
  SdkError,
  isBotaError,
} from './utils/errors';
