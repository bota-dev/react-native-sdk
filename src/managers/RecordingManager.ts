/**
 * Recording Manager - Handles recording sync and upload operations
 */

// React Native provides these globals but they're not in "lib": ["ES2020"]
declare function setTimeout(callback: () => void, ms: number): number;

import EventEmitter from 'eventemitter3';
import { Buffer } from 'buffer';

import { ProtocolHandler } from '../protocol/ProtocolHandler';
import { StorageManager } from '../storage/StorageManager';
import { UploadQueue } from '../upload/UploadQueue';
import type { ConnectedDevice, StorageInfo } from '../models/Device';
import type {
  DeviceRecording,
  UploadInfo,
  SyncProgress,
  UploadTask,
  StreamingState,
  StreamingSessionEvents,
  StreamingSyncOptions,
  StreamingUploadProvider,
} from '../models/Recording';
import type { RecordingManagerEvents } from '../models/Status';
import { DeviceError } from '../utils/errors';
import { logger } from '../utils/logger';
import { getBleManager } from '../ble/BleManager';
import {
  SERVICE_BOTA_CONTROL,
  CHAR_DEVICE_STATUS,
  DEVICE_UPLOAD_POLL_INTERVAL,
  DEVICE_UPLOAD_TIMEOUT,
  NETWORK_WARMUP_TIMEOUT,
  NETWORK_WARMUP_POLL_INTERVAL,
} from '../ble/constants';
import { parseDeviceStatus } from '../ble/parsers';

const log = logger.tag('RecordingManager');

/**
 * Upload info provider callback type
 */
export type UploadInfoProvider = (
  recording: DeviceRecording
) => Promise<UploadInfo>;

/**
 * Recording Manager class
 */
export class RecordingManager extends EventEmitter<RecordingManagerEvents> {
  private protocolHandler: ProtocolHandler;
  private storage: StorageManager;
  private uploadQueue: UploadQueue;
  private isInitialized = false;

  constructor() {
    super();
    this.protocolHandler = new ProtocolHandler();
    this.storage = new StorageManager();
    this.uploadQueue = new UploadQueue(this.storage, { autoStart: false });

    this.setupUploadQueueListeners();
  }

  /**
   * Initialize the recording manager
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    await this.storage.initialize();
    this.isInitialized = true;

    // Start processing any pending uploads
    this.uploadQueue.resume();

    log.info('RecordingManager initialized');
  }

  /**
   * Set up upload queue event listeners
   */
  private setupUploadQueueListeners(): void {
    this.uploadQueue.on('taskAdded', () => {
      this.emit('queueUpdated', this.uploadQueue.getAllTasks());
    });

    this.uploadQueue.on('taskUpdated', () => {
      this.emit('queueUpdated', this.uploadQueue.getAllTasks());
    });

    this.uploadQueue.on('taskCompleted', (taskId, recordingId) => {
      this.emit('uploadCompleted', taskId, recordingId);
      this.emit('queueUpdated', this.uploadQueue.getAllTasks());
    });

    this.uploadQueue.on('taskFailed', (taskId, error) => {
      this.emit('uploadFailed', taskId, error);
      this.emit('queueUpdated', this.uploadQueue.getAllTasks());
    });

    this.uploadQueue.on('uploadProgress', (taskId, progress) => {
      this.emit('uploadProgress', taskId, progress);
    });
  }

  /**
   * Get storage info from device
   */
  async getStorageInfo(device: ConnectedDevice): Promise<StorageInfo> {
    if (!getBleManager().isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    return this.protocolHandler.getStorageInfo(device.id);
  }

  /**
   * List recordings on a device
   */
  async listRecordings(device: ConnectedDevice): Promise<DeviceRecording[]> {
    if (!getBleManager().isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    log.info('Listing recordings', { deviceId: device.id });

    const recordings = await this.protocolHandler.listRecordings(device.id);

    log.info('Found recordings', {
      deviceId: device.id,
      count: recordings.length,
    });

    return recordings;
  }

  /**
   * Sync a single recording from device
   * Transfers from device, saves locally, and queues for upload
   */
  async *syncRecording(
    device: ConnectedDevice,
    recording: DeviceRecording,
    uploadInfo: UploadInfo
  ): AsyncGenerator<SyncProgress> {
    if (!getBleManager().isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    log.info('Starting recording sync', {
      deviceId: device.id,
      recordingUuid: recording.uuid,
    });

    this.emit('syncStarted', recording.uuid);

    try {
      // Stage: Preparing
      yield {
        stage: 'preparing',
        progress: 0,
        totalBytes: recording.fileSizeBytes,
      };

      // Stage: Transferring from device
      const { data: audioData, e2eEncrypted, sha256 } = await this.protocolHandler.transferRecording(
        device.id,
        recording.uuid,
        (_bytesReceived, _totalBytes) => {
          // Progress callback - can be used for real-time progress updates
        }
      );

      yield {
        stage: 'transferring',
        progress: 1,
        bytesTransferred: audioData.length,
        totalBytes: recording.fileSizeBytes,
        contentSha256: sha256,
      };

      // Save locally
      const localPath = await this.storage.saveRecordingData(
        device.id,
        recording.uuid,
        audioData
      );

      // Stage: Uploading
      yield {
        stage: 'uploading',
        progress: 0,
        bytesUploaded: 0,
        totalBytes: audioData.length,
      };

      // Queue for upload (this will process in background).
      // P10: when the device delivered the recording as encrypted chunks
      // (BOTA_PKT_TYPE_E2E_START + ENCRYPTED_DATA + ENCRYPTED_EOF), the
      // assembled body is the streaming-AEAD wire format that
      // `bleE2EService.decrypt()` parses server-side. Route it to the
      // /upload-relay endpoint; the caller MUST supply uploadInfo.relay
      // when it provisioned a backend pubkey on the device.
      const useRelay = e2eEncrypted && !!uploadInfo.relay;
      if (e2eEncrypted && !uploadInfo.relay) {
        log.warn('Device delivered ciphertext but caller did not provide UploadInfo.relay — upload will go to S3 presigned and fail to decrypt', {
          recordingUuid: recording.uuid,
        });
      }
      const task = await this.uploadQueue.enqueue({
        recordingId: uploadInfo.recordingId,
        deviceId: device.id,
        localPath,
        uploadUrl: uploadInfo.uploadUrl,
        uploadToken: uploadInfo.uploadToken,
        completeUrl: uploadInfo.completeUrl,
        contentType: uploadInfo.contentType,
        // P9.F2: forward the device-emitted SHA-256 (if any) so the host app's
        // completeUrl receives it. Skip on the E2E relay path — the server
        // decrypts and hashes plaintext on receipt, no client SHA in scope.
        contentSha256: useRelay ? undefined : sha256,
        relay: useRelay ? uploadInfo.relay : undefined,
      });

      // Wait for upload to complete
      await this.waitForUpload(task.id);

      // Stage: Completing - Confirm sync to device
      yield {
        stage: 'completing',
        progress: 0.5,
      };

      await this.protocolHandler.confirmSync(device.id, recording.uuid);

      // Update last sync time
      await this.storage.setLastSyncTime(device.id);

      // Stage: Completed
      yield {
        stage: 'completed',
        progress: 1,
        recordingId: uploadInfo.recordingId,
        contentSha256: sha256,
      };

      log.info('Recording sync completed', {
        deviceId: device.id,
        recordingUuid: recording.uuid,
        recordingId: uploadInfo.recordingId,
      });

      this.emit('syncCompleted', recording.uuid, uploadInfo.recordingId);
    } catch (error) {
      const err = error as Error;
      log.error('Recording sync failed', err, {
        deviceId: device.id,
        recordingUuid: recording.uuid,
      });

      yield {
        stage: 'failed',
        progress: 0,
        error: err.message,
      };

      this.emit('syncFailed', recording.uuid, err);
      throw error;
    }
  }

  /**
   * Wait for an upload task to complete
   */
  private async waitForUpload(taskId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const checkTask = () => {
        const task = this.storage.getUploadTask(taskId);
        if (!task) {
          reject(new Error('Upload task not found'));
          return true;
        }

        if (task.status === 'completed') {
          resolve();
          return true;
        }

        if (task.status === 'failed') {
          reject(new Error(task.errorMessage || 'Upload failed'));
          return true;
        }

        return false;
      };

      // Check immediately
      if (checkTask()) return;

      // Poll for completion
      const interval = setInterval(() => {
        if (checkTask()) {
          clearInterval(interval);
        }
      }, 500);

      // Also listen for events
      const onComplete = (completedTaskId: string) => {
        if (completedTaskId === taskId) {
          clearInterval(interval);
          this.uploadQueue.off('taskCompleted', onComplete);
          this.uploadQueue.off('taskFailed', onFailed);
          resolve();
        }
      };

      const onFailed = (failedTaskId: string, error: Error) => {
        if (failedTaskId === taskId) {
          clearInterval(interval);
          this.uploadQueue.off('taskCompleted', onComplete);
          this.uploadQueue.off('taskFailed', onFailed);
          reject(error);
        }
      };

      this.uploadQueue.on('taskCompleted', onComplete);
      this.uploadQueue.on('taskFailed', onFailed);
    });
  }

  /**
   * Read device status once (for smart sync decision).
   */
  private async readDeviceStatus(device: ConnectedDevice) {
    try {
      const data = await getBleManager().readCharacteristic(
        device.id,
        SERVICE_BOTA_CONTROL,
        CHAR_DEVICE_STATUS,
      );
      return parseDeviceStatus(data);
    } catch {
      return null;
    }
  }

  /**
   * Poll device status until WiFi or 4G is connected, or until timeout.
   * Cellular registration + PDP activation can take 10–30s after a cold
   * modem boot, so we can't assume the link is up just because Bluetooth is.
   */
  private async waitForNetwork(device: ConnectedDevice) {
    const start = Date.now();
    while (Date.now() - start < NETWORK_WARMUP_TIMEOUT) {
      await new Promise<void>((r) => setTimeout(r, NETWORK_WARMUP_POLL_INTERVAL));
      if (!getBleManager().isConnected(device.id)) return null;
      const status = await this.readDeviceStatus(device);
      if (status && (status.flags.wifiConnected || status.flags.lteConnected)) {
        return status;
      }
    }
    return null;
  }

  /**
   * Trigger device-side upload via WiFi/4G.
   * Returns the response, or null if firmware doesn't support it (timeout).
   */
  async triggerDeviceUpload(device: ConnectedDevice) {
    return this.protocolHandler.triggerDeviceUpload(device.id);
  }

  /**
   * Monitor device-side upload progress by polling device status.
   * Yields progress as pending_recordings decreases.
   * Completes when syncActive clears or pending hits 0.
   */
  async *monitorDeviceUpload(
    device: ConnectedDevice,
    initialPendingCount: number,
  ): AsyncGenerator<SyncProgress & { recordingIndex?: number; totalRecordings?: number }> {
    const startTime = Date.now();
    let lastPending = initialPendingCount;

    yield {
      stage: 'device_uploading',
      progress: 0,
      recordingIndex: 0,
      totalRecordings: initialPendingCount,
    };

    while (Date.now() - startTime < DEVICE_UPLOAD_TIMEOUT) {
      await new Promise<void>((r) => setTimeout(() => r(), DEVICE_UPLOAD_POLL_INTERVAL));

      if (!getBleManager().isConnected(device.id)) {
        yield { stage: 'failed', progress: 0, error: 'BLE disconnected during device upload' };
        return;
      }

      const status = await this.readDeviceStatus(device);
      if (!status) {
        continue;
      }

      const pending = status.pendingRecordings;
      const uploaded = initialPendingCount - pending;

      if (pending < lastPending) {
        lastPending = pending;
        yield {
          stage: 'device_uploading',
          progress: initialPendingCount > 0 ? uploaded / initialPendingCount : 1,
          recordingIndex: uploaded,
          totalRecordings: initialPendingCount,
        };
      }

      if (!status.flags.syncActive && pending === 0) {
        yield {
          stage: 'completed',
          progress: 1,
          recordingIndex: initialPendingCount,
          totalRecordings: initialPendingCount,
        };
        return;
      }

      if (!status.flags.syncActive && pending > 0) {
        // Device stopped uploading but files remain — partial failure
        yield {
          stage: 'failed',
          progress: initialPendingCount > 0 ? uploaded / initialPendingCount : 0,
          error: `Device upload stopped with ${pending} files remaining`,
          recordingIndex: uploaded,
          totalRecordings: initialPendingCount,
        };
        return;
      }
    }

    yield { stage: 'failed', progress: 0, error: 'Device upload timeout' };
  }

  /**
   * Sync all recordings from a device.
   * Smart path: if device has WiFi/4G, triggers device-side upload.
   * Fallback: Bluetooth transfer (existing behavior).
   */
  async *syncAllRecordings(
    device: ConnectedDevice,
    uploadInfoProvider: UploadInfoProvider
  ): AsyncGenerator<SyncProgress & { recordingIndex?: number; totalRecordings?: number }> {
    if (!getBleManager().isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    log.info('Syncing all recordings', { deviceId: device.id });

    // List recordings
    const recordings = await this.listRecordings(device);

    if (recordings.length === 0) {
      log.info('No recordings to sync', { deviceId: device.id });
      return;
    }

    log.info('Starting sync of recordings', {
      deviceId: device.id,
      count: recordings.length,
    });

    // --- Smart sync: try device-side upload via WiFi/4G ---
    // 1. If device is already uploading, just monitor it.
    // 2. If WiFi/4G is up, fire the trigger.
    // 3. If neither is up yet, wait briefly for the modem to register
    //    (cellular cold-boot takes 10–30s); fall back to Bluetooth on timeout.
    let status = await this.readDeviceStatus(device);

    if (status?.flags.syncActive) {
      log.info('Smart sync: device already uploading, monitoring');
      yield* this.monitorDeviceUpload(device, recordings.length);
      return;
    }

    if (status && !status.flags.wifiConnected && !status.flags.lteConnected) {
      log.info('Smart sync: no network up yet, waiting for warmup');
      const ready = await this.waitForNetwork(device);
      if (ready) status = ready;
    }

    if (status && (status.flags.wifiConnected || status.flags.lteConnected)) {
      log.info('Smart sync: triggering device-side upload', {
        wifi: status.flags.wifiConnected,
        lte: status.flags.lteConnected,
        pending: status.pendingRecordings,
      });

      try {
        const response = await this.protocolHandler.triggerDeviceUpload(device.id);
        if (response?.accepted) {
          yield* this.monitorDeviceUpload(device, recordings.length);
          return;
        }
        log.info('Smart sync: device rejected, falling back to BLE', {
          errorCode: response?.errorCode,
        });
      } catch (err) {
        log.warn('Smart sync: trigger failed, falling back to BLE', {
          error: (err as Error).message,
        });
      }
    } else {
      log.info('Smart sync: no WiFi/4G after warmup, falling back to BLE');
    }

    // --- Bluetooth sync path (existing behavior) ---
    for (let i = 0; i < recordings.length; i++) {
      const recording = recordings[i];

      try {
        // Get upload info from customer backend
        const uploadInfo = await uploadInfoProvider(recording);

        // Sync the recording
        for await (const progress of this.syncRecording(
          device,
          recording,
          uploadInfo
        )) {
          yield {
            ...progress,
            recordingIndex: i,
            totalRecordings: recordings.length,
          };
        }
      } catch (error) {
        const err = error as Error;
        log.error('Failed to sync recording', err, {
          deviceId: device.id,
          recordingUuid: recording.uuid,
          index: i,
        });

        yield {
          stage: 'failed',
          progress: 0,
          error: err.message,
          recordingIndex: i,
          totalRecordings: recordings.length,
        };

        // Continue with next recording
      }
    }

    // Read fresh device status so Bluetooth characteristic cache is updated.
    // The app's status subscription will pick up the new value on restart.
    await this.readDeviceStatus(device);
  }

  /**
   * Get pending uploads
   */
  getPendingUploads(): UploadTask[] {
    return this.uploadQueue.getPendingTasks();
  }

  /**
   * Get all uploads
   */
  getAllUploads(): UploadTask[] {
    return this.uploadQueue.getAllTasks();
  }

  /**
   * Cancel a pending upload
   */
  async cancelUpload(taskId: string): Promise<void> {
    await this.uploadQueue.cancel(taskId);
  }

  /**
   * Retry failed uploads
   */
  async retryFailedUploads(): Promise<void> {
    await this.uploadQueue.retryFailed();
  }

  /**
   * Clear completed uploads from queue
   */
  async clearCompletedUploads(): Promise<void> {
    await this.storage.clearCompletedTasks();
    this.emit('queueUpdated', this.uploadQueue.getAllTasks());
  }

  /**
   * Clear all uploads
   */
  async clearAllUploads(): Promise<void> {
    await this.uploadQueue.cancelAll();
    this.emit('queueUpdated', []);
  }

  /**
   * Pause upload processing
   */
  pauseUploads(): void {
    this.uploadQueue.pause();
  }

  /**
   * Resume upload processing
   */
  resumeUploads(): void {
    this.uploadQueue.resume();
  }

  /**
   * Start streaming sync for the current in-progress recording.
   *
   * This method is for live recordings only — it streams audio data from the
   * device via Bluetooth while the recording is still in progress, and uploads chunks
   * to S3 as they arrive.
   *
   * If Bluetooth disconnects, the session emits 'disconnected'. The recording
   * continues on the device and can be batch-synced later via syncRecording().
   *
   * @param device - Connected device that is currently recording
   * @param recordingUuid - UUID of the in-progress recording
   * @param uploadInfoProvider - Callback to get upload info from customer backend
   * @returns StreamingSession that emits progress events
   */
  startStreamingSync(
    device: ConnectedDevice,
    recordingUuid: string,
    uploadInfoProvider: StreamingUploadProvider,
    options?: StreamingSyncOptions
  ): StreamingSession {
    if (!getBleManager().isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    if (this.activeStreamingSession) {
      throw new Error('A streaming session is already active');
    }

    log.info('Starting streaming sync', {
      deviceId: device.id,
      recordingUuid,
    });

    const session = new StreamingSession(
      this.protocolHandler,
      this.storage,
      device,
      recordingUuid,
      uploadInfoProvider,
      options?.chunkSizeKb,
      options?.flushIntervalMs
    );

    this.activeStreamingSession = session;

    session.on('completed', () => {
      this.activeStreamingSession = null;
    });
    session.on('disconnected', () => {
      this.activeStreamingSession = null;
    });
    session.on('error', () => {
      this.activeStreamingSession = null;
    });

    session.start();
    return session;
  }

  private activeStreamingSession: StreamingSession | null = null;

  /**
   * Get the active streaming session, if any
   */
  getActiveStreamingSession(): StreamingSession | null {
    return this.activeStreamingSession;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    log.info('Destroying RecordingManager');
    if (this.activeStreamingSession) {
      this.activeStreamingSession.abort();
      this.activeStreamingSession = null;
    }
    this.protocolHandler.destroy();
    this.uploadQueue.destroy();
    this.storage.destroy();
    this.removeAllListeners();
    this.isInitialized = false;
  }
}

// Globals available in React Native (Hermes) but not declared in this tsconfig's lib
// eslint-disable-next-line no-var
declare var fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => Promise<{ ok: boolean; status: number; statusText: string }>;
// eslint-disable-next-line no-var
declare var setInterval: (handler: () => void, timeout: number) => number;
// eslint-disable-next-line no-var
declare var clearInterval: (id: number | null) => void;

/**
 * Streaming session — manages a live streaming sync of the current recording.
 *
 * Mirrors firmware WiFi/4G upload: creates backend record upfront, uploads
 * chunks to S3 concurrently with Bluetooth transfer (one chunk at a time, serialized),
 * then finalizes after EOF. Same chunk-URL-per-chunk pattern as bota_upload_task().
 */
export class StreamingSession extends EventEmitter<StreamingSessionEvents> {
  private _state: StreamingState = 'idle';
  private _bytesReceived = 0;
  private _chunksUploaded = 0;
  // P10: per-chunk relay info. Each encrypted chunk POSTs independently to
  // chunkUrl(seq) so the backend can decrypt + write to S3 (and, in the
  // future, fan out to streaming-ASR / translation pipelines) in real time.
  // finalizeUrl wraps up the session after EOF.
  private relay?: {
    chunkUrl: (seq: number) => string;
    finalizeUrl: string;
    bearerToken: string;
  };
  // P10 e2e session header captured from the device's e2e_start packet.
  // Prepended only to chunk 0's POST body; chunks 1..N reuse it server-side
  // (persisted on the recording row at chunk 0).
  private e2eSessionHeader?: { ephemeralPk: Buffer; salt: Buffer };
  // Tracks how many encrypted chunks have been successfully POSTed. Used for
  // progress display + a sanity check in finalize. NOT used as total_chunks
  // because BLE notifications can be silently dropped — `e2eMaxSeq + 1` from
  // the ProtocolHandler return value is the firmware's intended chunk count
  // and is what the backend stitcher looks for in S3.
  private e2eChunksPosted = 0;
  // Seqs whose POST to /upload-relay/chunk/{seq} failed (non-OK response or
  // network error). Chunk 0 failure is still fatal — without it the session
  // header isn't persisted on the recording row and no other chunk can be
  // decrypted. Chunks 1..N are tolerated as gaps; backend stitcher skips
  // them so a transient hiccup surfaces as a brief audio dropout instead of
  // killing the whole recording.
  private e2eChunksFailedSeqs: number[] = [];
  // DEBUG counters: count how many times the onE2eChunk callback fires
  // (i.e. how many encrypted_data packets the ProtocolHandler dispatched
  // to this session) and how many times the resulting chain-entry actually
  // executes. A gap between these and `e2eChunksPosted` + `e2eMaxSeq + 1`
  // localizes where chunks are leaking. Logged in the finalize WARN.
  private e2eCallbackCount = 0;
  private e2eChainRunCount = 0;
  private _recordingId?: string;
  private _isAborted = false;
  private _startedAt = 0;
  // Pending Bluetooth data not yet assigned to a chunk upload
  private pendingData: Buffer[] = [];
  private pendingBytes = 0;
  // Serialized upload chain — one chunk uploads at a time
  private uploadChain: Promise<void> = Promise.resolve();
  private chunkIndex = 0;
  private readonly chunkSize: number;
  private readonly flushIntervalMs: number;

  constructor(
    private protocolHandler: ProtocolHandler,
    _storageManager: StorageManager,
    private device: ConnectedDevice,
    private recordingUuid: string,
    private uploadProvider: StreamingUploadProvider,
    chunkSizeKb?: number,
    flushIntervalMs?: number
  ) {
    super();
    // Default 512KB to match firmware BOTA_UPLOAD_CHUNK_SIZE
    const kb = Math.max(64, Math.min(1024, chunkSizeKb ?? 512));
    this.chunkSize = kb * 1024;
    this.flushIntervalMs = flushIntervalMs ?? 60_000;
  }

  get state(): StreamingState { return this._state; }
  get bytesReceived(): number { return this._bytesReceived; }
  get chunksUploaded(): number { return this._chunksUploaded; }
  get recordingId(): string | undefined { return this._recordingId; }
  get isActive(): boolean { return this._state === 'streaming' || this._state === 'paused'; }

  /**
   * Enqueue a chunk upload after the current one finishes.
   * Data is captured immediately; upload runs serially in the background.
   */
  private enqueueChunkUpload(): void {
    if (this.pendingData.length === 0) return;
    const chunkData = Buffer.concat(this.pendingData);
    this.pendingData = [];
    this.pendingBytes = 0;
    const idx = ++this.chunkIndex;
    const recordingId = this._recordingId!;

    this.uploadChain = this.uploadChain.then(async () => {
      if (this._isAborted) return;
      const url = await this.uploadProvider.getChunkUrl(recordingId, idx);
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'audio/ogg' },
        body: chunkData,
      });
      if (!response.ok) {
        throw new Error(`Chunk ${idx} S3 upload failed: ${response.status} ${response.statusText}`);
      }
      this._chunksUploaded = idx;
      this.emitProgress();
      log.debug('Chunk uploaded', { chunkIndex: idx, size: chunkData.length });
    });
  }

  /**
   * Start the streaming session (called internally by RecordingManager)
   */
  async start(): Promise<void> {
    this._state = 'streaming';
    this._startedAt = Date.now();

    // Create backend record immediately — needed to get chunk URLs.
    // If Bluetooth disconnects before data arrives the record is left un-finalized
    // (status: 'streaming') and will not trigger transcription.
    const { recordingId, relay } = await this.uploadProvider.createRecording({
      startedAt: new Date(this._startedAt),
    });
    this._recordingId = recordingId;
    // P10: stash for the post-EOF e2e-relay upload (if the device delivers ciphertext).
    this.relay = relay;

    // Time-based flush: upload partial chunk even if chunkSize not yet reached
    let flushTimer: number | null = null;
    if (this.flushIntervalMs > 0) {
      flushTimer = setInterval(() => {
        if (this.pendingBytes > 0 && this.isActive) {
          this.enqueueChunkUpload();
        }
      }, this.flushIntervalMs);
    }

    try {
      const result = await this.protocolHandler.streamTransfer(
        this.device.id,
        this.recordingUuid,
        {
          onData: (_seq, data) => {
            this._bytesReceived += data.length;
            this.pendingData.push(Buffer.from(data));
            this.pendingBytes += data.length;
            if (this.pendingBytes >= this.chunkSize) {
              this.enqueueChunkUpload();
            }
            this.emitProgress();
          },
          onPaused: (_bytesSent) => {
            this._state = 'paused';
            this.emit('paused');
            this.emitProgress();
          },
          onResumed: () => {
            this._state = 'streaming';
            this.emit('resumed');
          },
          // P10: capture session header from e2e_start packet. Prepended only
          // to chunk 0's POST body — backend persists and reuses server-side.
          onE2eStart: (ephemeralPk, salt) => {
            this.e2eSessionHeader = { ephemeralPk, salt };
          },
          // P10: per-chunk relay POST. Each encrypted chunk POSTs to
          // chunkUrl(seq) the moment the device emits it (foundation for
          // streaming ASR / translation). Chunks are serialized through
          // uploadChain so backend receives them in order — required because
          // chunk 0 carries the session header and the others reference it.
          // App never holds plaintext.
          onE2eChunk: (seq, ciphertextWithTag) => {
            // Track plaintext size for progress (ct.length includes 16-byte tag).
            this._bytesReceived += ciphertextWithTag.length - 16;
            this.emitProgress();

            // DEBUG: log every callback entry so we can compare against
            // (a) firmware's emitted `chunks=N`, (b) the ProtocolHandler's
            // 'E2E chunk dispatch' count, and (c) the chain-execution log
            // below. A gap between (a) and this counter = wire/bridge loss.
            // A gap between this and (c) = the chain skipped an entry.
            this.e2eCallbackCount += 1;
            log.debug('E2E chunk callback', {
              seq,
              callbackCount: this.e2eCallbackCount,
              ctLen: ciphertextWithTag.length,
            });

            this.uploadChain = this.uploadChain.then(async () => {
              this.e2eChainRunCount += 1;
              log.debug('E2E chunk chain enter', {
                seq,
                chainRunCount: this.e2eChainRunCount,
                aborted: this._isAborted,
                hasRelay: !!this.relay,
              });
              if (this._isAborted) return;
              if (!this.relay) {
                throw new Error(
                  'E2E streaming chunk arrived but uploadProvider.createRecording did not return relay info',
                );
              }
              let body: Buffer;
              if (seq === 0) {
                if (!this.e2eSessionHeader) {
                  throw new Error('E2E chunk 0 arrived before e2e_start packet');
                }
                body = Buffer.concat([
                  this.e2eSessionHeader.ephemeralPk,
                  this.e2eSessionHeader.salt,
                  ciphertextWithTag,
                ]);
              } else {
                body = ciphertextWithTag;
              }
              // Chunk 0 carries the session header (eph_pk + salt) the backend
              // persists for decrypting every subsequent chunk. If it fails,
              // no later chunk is decryptable — fail loud so the app falls
              // back to batch sync. Chunks 1..N are individually recoverable
              // as gaps, so we catch + skip them instead of cascading.
              let response: Awaited<ReturnType<typeof fetch>>;
              try {
                response = await fetch(this.relay.chunkUrl(seq), {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': body.length.toString(),
                    Authorization: `Bearer ${this.relay.bearerToken}`,
                  },
                  body,
                });
              } catch (err) {
                if (seq === 0) {
                  throw new Error(
                    `E2E streaming chunk 0 (session header) upload threw: ${(err as Error).message}`,
                  );
                }
                log.warn('E2E chunk POST threw — recording as gap', { seq, err });
                this.e2eChunksFailedSeqs.push(seq);
                return;
              }
              if (!response.ok) {
                if (seq === 0) {
                  throw new Error(
                    `E2E streaming chunk 0 (session header) upload failed: ${response.status} ${response.statusText}`,
                  );
                }
                log.warn('E2E chunk POST non-OK — recording as gap', {
                  seq,
                  status: response.status,
                });
                this.e2eChunksFailedSeqs.push(seq);
                return;
              }
              this.e2eChunksPosted += 1;
              this._chunksUploaded = this.e2eChunksPosted;
              this.emitProgress();
              log.debug('E2E chunk uploaded', { seq, bytes: body.length });
            });
          },
        }
      );

      if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
      this._state = 'uploading';

      if (result.totalBytes === 0) {
        // No data received — leave record un-finalized, let batch sync handle it
        this._state = 'completed';
        this.emit('completed', { recordingId: '', totalBytes: 0 });
        return;
      }

      // P10: e2e-encrypted streaming. Per-chunk POSTs already happened during
      // the BLE transfer via the onE2eChunk callback. Wait for any in-flight
      // POSTs to drain, then POST finalize so the backend can run the existing
      // chunk-stitching pipeline (assemble → audio.opus → trigger
      // auto-transcription / Cleanvoice / integrity verify).
      if (result.e2eEncrypted) {
        if (!this.relay) {
          throw new Error(
            'E2E streaming requires uploadProvider.createRecording to return relay info',
          );
        }
        // Wait for all per-chunk POSTs to land at the backend before finalize.
        await this.uploadChain;

        // `total_chunks` is the firmware's intended count — every seq from 0
        // to e2eMaxSeq SHOULD have a chunk in S3. `e2eMaxSeq + 1` is correct
        // even if some POSTs failed (dropped notifications + transient 5xx);
        // the backend stitcher treats missing chunks as gaps. Older firmware
        // (no e2eMaxSeq surfaced) falls back to e2eChunkCount, which assumes
        // no drops — same behavior as before the gap-tolerant fix.
        const expectedChunks = (result.e2eMaxSeq !== undefined)
          ? result.e2eMaxSeq + 1
          : (result.e2eChunkCount ?? this.e2eChunksPosted);
        const gapCount = expectedChunks - this.e2eChunksPosted;
        // Always log the per-stage counters so we can localize where chunks
        // were lost (wire vs SDK dispatch vs chain vs POST). Compare against
        // firmware EOF print `chunks=N`:
        //   - expectedChunks (= e2eMaxSeq + 1)  == N  ⇒ SDK saw every seq
        //   - protocolHandlerChunks (from PH log) == N  ⇒ ProtocolHandler saw every packet
        //   - callbackCount        < N  ⇒ leak between PH and RM callback
        //   - chainRunCount        < callbackCount  ⇒ chain skipped entries
        //   - posted               < chainRunCount  ⇒ POSTs failed silently
        const counterReport = {
          expectedChunks,
          posted: this.e2eChunksPosted,
          callbackCount: this.e2eCallbackCount,
          chainRunCount: this.e2eChainRunCount,
          gapCount,
          failedSeqs: this.e2eChunksFailedSeqs,
        };
        if (gapCount > 0) {
          log.warn('E2E streaming finalizing with gaps', counterReport);
        } else {
          log.info('E2E streaming counter report (no gaps)', counterReport);
        }

        this._state = 'completing';
        const durationMs = Date.now() - this._startedAt;
        const finalizeBody = JSON.stringify({
          total_chunks: expectedChunks,
          final_duration_ms: durationMs,
          final_file_size_bytes: this._bytesReceived,
        });
        const finalizeResp = await fetch(this.relay.finalizeUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': finalizeBody.length.toString(),
            Authorization: `Bearer ${this.relay.bearerToken}`,
          },
          body: finalizeBody,
        });
        if (!finalizeResp.ok) {
          throw new Error(
            `E2E streaming finalize failed: ${finalizeResp.status} ${finalizeResp.statusText}`,
          );
        }
        log.info('E2E streaming completed', {
          recordingUuid: this.recordingUuid,
          recordingId: this._recordingId,
          totalChunks: expectedChunks,
          plaintextBytes: this._bytesReceived,
        });
      } else {
        // Flush any remaining buffered data as the final chunk
        if (this.pendingBytes > 0) {
          this.enqueueChunkUpload();
        }

        // Wait for all chunk uploads to finish
        await this.uploadChain;

        // Finalize — backend stitches chunks and triggers transcription
        this._state = 'completing';
        const durationMs = Date.now() - this._startedAt;
        await this.uploadProvider.finalizeRecording(this._recordingId, {
          totalChunks: this.chunkIndex,
          durationMs,
          fileSizeBytes: this._bytesReceived,
        });
      }

      // Tell device to delete the transferred file
      await this.protocolHandler.confirmSync(this.device.id, this.recordingUuid);

      this._state = 'completed';
      this.emit('completed', {
        recordingId: this._recordingId!,
        totalBytes: result.totalBytes,
      });
      log.info('Streaming sync completed', {
        recordingUuid: this.recordingUuid,
        recordingId: this._recordingId,
        totalChunks: this.chunkIndex,
        totalBytes: this._bytesReceived,
      });
    } catch (error) {
      if (flushTimer) { clearInterval(flushTimer); }
      if (this._isAborted) return;

      const err = error as Error;
      if (err.message?.includes('disconnected') || err.message?.includes('interrupted')) {
        this._state = 'disconnected';
        this.emit('disconnected');
        log.info('Streaming session disconnected — recording continues on device', {
          recordingUuid: this.recordingUuid,
          bytesReceived: this._bytesReceived,
        });
      } else {
        this._state = 'failed';
        this.emit('error', err);
        log.error('Streaming session failed', err, {
          recordingUuid: this.recordingUuid,
        });
      }
    }
  }

  /**
   * Abort the streaming session. Recording continues on device,
   * can be batch-synced later.
   */
  abort(): void {
    if (!this.isActive) return;
    this._isAborted = true;
    this.protocolHandler.cancelTransfer(this.device.id, this.recordingUuid);
    this._state = 'disconnected';
    this.emit('disconnected');
  }

  private emitProgress(): void {
    this.emit('chunk', {
      state: this._state,
      bytesReceived: this._bytesReceived,
      chunksUploaded: this._chunksUploaded,
      recordingId: this._recordingId,
    });
  }
}
