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
export { DeviceManager, RecordingManager, OTAManager } from './managers';
export type { UploadInfoProvider, FirmwareInfo, OtaStage, OtaProgress } from './managers';

// Models - Device
export type {
  DeviceType,
  PairingState,
  ConnectionState,
  DeviceState,
  DeviceFlags,
  DiscoveredDevice,
  ConnectedDevice,
  DeviceStatus,
  StorageInfo,
  ScanOptions,
  ReconnectOptions,
  Environment,
  ProvisioningResult,
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
} from './models/Recording';

// Models - Status & Events
export type {
  LogLevel,
  SdkStatus,
  DeviceManagerEvents,
  RecordingManagerEvents,
  BotaClientEvents,
} from './models/Status';

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
