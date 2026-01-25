/**
 * Recording-related type definitions
 */

/**
 * Audio codec type
 */
export type AudioCodec = 'pcm_16k' | 'pcm_8k' | 'opus_16k' | 'opus_8k';

/**
 * Recording metadata from device
 */
export interface DeviceRecording {
  /** Unique identifier on device (UUID) */
  uuid: string;
  /** Recording start timestamp */
  startedAt: Date;
  /** Duration in milliseconds */
  durationMs: number;
  /** File size in bytes */
  fileSizeBytes: number;
  /** Audio codec used */
  codec: AudioCodec;
}

/**
 * Upload information provided by customer backend
 * (obtained by calling customer's API, not Bota API directly)
 */
export interface UploadInfo {
  /** Pre-signed S3 URL for upload */
  uploadUrl: string;
  /** Recording ID assigned by Bota API (rec_*) */
  recordingId: string;
  /** Upload token (up_*) for verification - optional if using custom completion flow */
  uploadToken?: string;
  /** URL to call when upload is complete - optional if using custom completion flow */
  completeUrl?: string;
  /** Expiration time of the upload URL */
  expiresAt?: Date;
  /** Content type for S3 upload (e.g., 'audio/opus', 'audio/wav') */
  contentType?: string;
}

/**
 * Sync progress stages
 */
export type SyncStage =
  | 'preparing'
  | 'transferring'
  | 'uploading'
  | 'completing'
  | 'completed'
  | 'failed';

/**
 * Sync progress information
 */
export interface SyncProgress {
  /** Current stage */
  stage: SyncStage;
  /** Progress within current stage (0.0 - 1.0) */
  progress: number;
  /** Bytes transferred so far (for transferring stage) */
  bytesTransferred?: number;
  /** Total bytes to transfer */
  totalBytes?: number;
  /** Bytes uploaded so far (for uploading stage) */
  bytesUploaded?: number;
  /** Recording ID (set when completed) */
  recordingId?: string;
  /** Error message (set when failed) */
  error?: string;
}

/**
 * Upload task status
 */
export type UploadTaskStatus = 'pending' | 'uploading' | 'completed' | 'failed';

/**
 * Upload task in the queue
 */
export interface UploadTask {
  /** Unique task identifier */
  id: string;
  /** Recording ID from Bota API */
  recordingId: string;
  /** Device ID the recording came from */
  deviceId: string;
  /** Local file path */
  localPath: string;
  /** Pre-signed S3 upload URL */
  uploadUrl: string;
  /** Upload token - optional if using custom completion flow */
  uploadToken?: string;
  /** Complete URL to call after upload - optional if using custom completion flow */
  completeUrl?: string;
  /** Content type for S3 upload (e.g., 'audio/opus', 'audio/wav') */
  contentType?: string;
  /** Current status */
  status: UploadTaskStatus;
  /** Number of retry attempts */
  retryCount: number;
  /** Error message if failed */
  errorMessage?: string;
  /** Task creation time */
  createdAt: Date;
  /** Last update time */
  updatedAt: Date;
}

/**
 * Transfer packet from device
 */
export interface TransferPacket {
  /** Packet type: data, eof, or error */
  type: 'data' | 'eof' | 'error';
  /** Sequence number */
  sequenceNumber: number;
  /** Audio data (for data packets) */
  data?: Uint8Array;
  /** CRC32 checksum (for EOF packets) */
  checksum?: number;
  /** Error code (for error packets) */
  errorCode?: number;
}
