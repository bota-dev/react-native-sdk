/**
 * Managers module exports
 */

export { DeviceManager } from './DeviceManager';
export {
  RecordingManager,
  StreamingSession,
  type UploadInfoProvider,
  type EncryptedUploadV2Provider,
  type EncryptedUploadV2ProviderContext,
  type EncryptedUploadV2Material,
  type EncryptedUploadV2SyncOptions,
} from './RecordingManager';
export {
  OTAManager,
  type FirmwareInfo,
  type FirmwareDownloadProgressCallback,
  type OtaStage,
  type OtaProgress,
} from './OTAManager';
