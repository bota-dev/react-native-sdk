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
  /** True if the file is stored encrypted at rest on the device (P4). False/undefined = legacy plaintext. */
  isEncrypted?: boolean;
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
  /** P10: when present AND the transferred audio bytes are BLE-e2e ciphertext
   *  (device encrypted before BLE relay), the SDK POSTs the raw bytes to this
   *  endpoint instead of the presigned S3 PUT. Backend decrypts server-side
   *  and writes plaintext to S3. Use the bind-time `cert`-flavored auth
   *  token (or any valid Bearer for the project). */
  relay?: {
    /** Full URL of `/v1/recordings/{id}/upload-relay` */
    url: string;
    /** Bearer token (typically sk_*, rk_*, or dtok_*) */
    bearerToken: string;
  };
}

/**
 * Sync progress stages
 */
export type SyncStage =
  | 'preparing'
  | 'transferring'
  | 'uploading'
  | 'device_uploading'
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
  /** P9.F2 BLE integrity hash. SHA-256 (64-char hex) the device computed over
   *  the SD-file bytes. Set on the `transferring` and `completed` stages when
   *  P9.F2+ firmware emitted a BOTA_PKT_TYPE_SHA256 packet after EOF. Forward
   *  to your backend's /upload-complete (or equivalent) so server-side stitch
   *  can verify integrity. Undefined on pre-P9.F2 firmware. */
  contentSha256?: string;
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
  /** P9.F2 BLE integrity hash. SHA-256 (64-char hex) the device computed over
   *  the SD-file bytes — forwarded to the host app's backend in the
   *  /upload-complete body so server-side stitch+SHA can verify integrity. */
  contentSha256?: string;
  /** P10: when set, the file at `localPath` is BLE-e2e ciphertext that must
   *  be POSTed to this relay endpoint (with the bearer token) instead of
   *  PUT to the presigned `uploadUrl`. The backend decrypts and writes
   *  plaintext to S3 on receipt. */
  relay?: {
    url: string;
    bearerToken: string;
  };
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
  /** Packet type. P10 adds:
   *   - 'e2e_start'      session header (ephemeral_pk + salt)
   *   - 'encrypted_data' DATA with ciphertext + tag payload
   *   - 'encrypted_eof'  EOF for an encrypted transfer (no CRC) */
  type: 'data' | 'eof' | 'paused' | 'error' | 'sha256' | 'e2e_start' | 'encrypted_data' | 'encrypted_eof';
  /** Sequence number */
  sequenceNumber: number;
  /** Audio data (for data packets) */
  data?: Uint8Array;
  /** CRC32 checksum (for EOF packets) */
  checksum?: number;
  /** Bytes sent so far (for paused packets — streaming mode) */
  bytesSent?: number;
  /** Error code (for error packets) */
  errorCode?: number;
  /** P10 e2e_start only: ephemeral X25519 pubkey (32 bytes). */
  e2eEphemeralPk?: Uint8Array;
  /** P10 e2e_start only: session salt (4 bytes) for per-chunk nonce. */
  e2eSalt?: Uint8Array;
  /** P10 encrypted_data only: full payload (ciphertext + 16-byte tag). */
  e2eChunk?: Uint8Array;
  /** P9.F2 sha256 only: device's SHA-256 over the SD-file bytes (32 raw bytes). */
  sha256?: Uint8Array;
}

/**
 * Options for startStreamingSync()
 */
export interface StreamingSyncOptions {
  /**
   * Size of each upload chunk in KB (64-1024).
   * Smaller = more real-time (lower latency, higher HTTP overhead).
   * Larger = less real-time (higher latency, lower overhead).
   * Default: 256 (from device settings.upload.streaming_chunk_kb)
   */
  chunkSizeKb?: number;
  /**
   * Time-based flush interval in milliseconds. Buffered data is uploaded
   * as a partial chunk even if chunkSizeKb hasn't been reached yet.
   * Mirrors firmware's streaming_flush_interval_seconds behaviour.
   * 0 = disabled (flush on chunk full only). Default: 60000 (60s).
   */
  flushIntervalMs?: number;
}

/**
 * Streaming sync state
 */
export type StreamingState =
  | 'idle'
  | 'streaming'    // Receiving live audio data from device
  | 'paused'       // Device caught up to recording write position, waiting
  | 'uploading'    // Uploading final chunks to S3
  | 'completing'   // Finalizing upload
  | 'completed'
  | 'disconnected' // Bluetooth dropped — falls back to batch sync later
  | 'failed';

/**
 * Streaming sync progress event
 */
export interface StreamingSyncProgress {
  /** Current streaming state */
  state: StreamingState;
  /** Bytes received from device so far */
  bytesReceived: number;
  /** Chunks uploaded to S3 so far */
  chunksUploaded: number;
  /** Recording ID from backend (set after first chunk upload) */
  recordingId?: string;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Upload provider for streaming sync.
 * Called by StreamingSession to create the backend record and upload chunks
 * concurrently with Bluetooth transfer — same pattern as firmware WiFi/4G upload.
 */
export interface StreamingUploadProvider {
  /**
   * Create backend record at session start to obtain recordingId for chunk URLs.
   *
   * Optionally return `relay` info so the SDK can route P10 e2e-encrypted
   * chunks (when the device delivers ciphertext) to the per-chunk streaming
   * relay endpoints instead of trying to push them to S3 presigned URLs.
   * Required when the project has a backend pubkey provisioned and the
   * device emits encrypted streaming packets; without it, the SDK cannot
   * deliver the recording.
   *
   * Per-chunk model (foundation for real-time downstream features):
   *   chunkUrl(seq)  → POST [eph_pk||salt||ct+tag] for seq=0, [ct+tag] for seq>0
   *   finalizeUrl    → POST { total_chunks, ... } once EOF received
   */
  createRecording: (info: { startedAt: Date }) => Promise<{
    recordingId: string;
    relay?: {
      /** Build the per-chunk POST URL for chunk `seq` (0-indexed). */
      chunkUrl: (seq: number) => string;
      /** POST URL for the finalize call after all chunks have been POSTed. */
      finalizeUrl: string;
      /** Bearer token used for both chunkUrl and finalizeUrl. */
      bearerToken: string;
    };
  }>;
  /** Get pre-signed S3 URL for a specific chunk (1-indexed) */
  getChunkUrl: (recordingId: string, chunkIndex: number) => Promise<string>;
  /** Finalize after all chunks uploaded — triggers backend stitching + transcription */
  finalizeRecording: (recordingId: string, info: {
    totalChunks: number;
    durationMs?: number;
    fileSizeBytes?: number;
  }) => Promise<void>;
}

/**
 * Streaming session — represents an active streaming sync of the current recording.
 * Event-based because it's long-lived (entire recording duration).
 */
export interface StreamingSessionEvents {
  /** Emitted when a new chunk of audio data is received */
  chunk: (progress: StreamingSyncProgress) => void;
  /** Emitted when device has caught up to recording write position */
  paused: () => void;
  /** Emitted when device resumes sending data after pause */
  resumed: () => void;
  /** Emitted when recording stops and all data has been uploaded */
  completed: (result: { recordingId: string; totalBytes: number }) => void;
  /** Emitted when Bluetooth disconnects — recording continues on device, batch sync later */
  disconnected: () => void;
  /** Emitted on error */
  error: (err: Error) => void;
}
