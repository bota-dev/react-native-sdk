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
  EncryptedUploadV2Provider,
  EncryptedUploadV2ProviderContext,
  EncryptedUploadV2Material,
  EncryptedUploadV2SyncOptions,
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
  DeviceLogEvent,
  StorageInfo,
  ScanOptions,
  ReconnectOptions,
  Environment,
  ProvisioningResult,
  BleFactoryResetResult,
  BleFactoryResetResultPersister,
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

export { DeviceLogDecoder } from './ble/deviceLogs';

// Models - Recording
export type {
  AudioCodec,
  DeviceRecording,
  UploadInfo,
  SyncStage,
  SyncProgress,
  UploadTaskStatus,
  UploadTask,
  PersistedEncryptedUploadV2Checkpoint,
  TransferPacket,
  StreamingState,
  StreamingSyncProgress,
  StreamingSyncOptions,
  StreamingSessionEvents,
} from './models/Recording';

export type {
  EncryptedUploadV2CapabilitySnapshot,
  EncryptedUploadV2Recording,
} from './protocol/ProtocolHandler';
export {
  EncryptedUploadV2RuntimeError,
} from './protocol/encryptedUploadV2Runtime';
export {
  EncryptedUploadProfileSelectionError,
} from './protocol/encryptedUploadV2Selection';
export type {
  EncryptedUploadV2Checkpoint,
  EncryptedUploadV2CiphertextSink,
  EncryptedUploadV2TransferEvidence,
  EncryptedUploadV2RuntimeErrorCode,
} from './protocol/encryptedUploadV2Runtime';
export type {
  EncryptedUploadProfileSelectionErrorCode,
  UploadSecurityPolicy,
} from './protocol/encryptedUploadV2Selection';

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
