/**
 * Recording Manager - Handles recording sync and upload operations
 */

import EventEmitter from 'eventemitter3';

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
} from '../models/Recording';
import type { RecordingManagerEvents } from '../models/Status';
import { DeviceError } from '../utils/errors';
import { logger } from '../utils/logger';
import { getBleManager } from '../ble/BleManager';

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

      // Stage: Transferring from device (with retry on CRC mismatch)
      const MAX_TRANSFER_RETRIES = 2;
      let audioData: Buffer;
      let lastTransferError: Error | null = null;
      for (let attempt = 0; attempt <= MAX_TRANSFER_RETRIES; attempt++) {
        try {
          if (attempt > 0) {
            log.warn(`Retrying BLE transfer (attempt ${attempt + 1}/${MAX_TRANSFER_RETRIES + 1})`, {
              recordingUuid: recording.uuid,
            });
            // Brief delay before retry to let BLE stabilize
            await new Promise(r => setTimeout(r, 1000));
          }
          audioData = await this.protocolHandler.transferRecording(
            device.id,
            recording.uuid,
            (_bytesReceived, _totalBytes) => {
              // Progress callback - can be used for real-time progress updates
            }
          );
          lastTransferError = null;
          break;
        } catch (err) {
          lastTransferError = err as Error;
          const isChecksumError = (err as any)?.code === 'CHECKSUM_MISMATCH';
          if (!isChecksumError || attempt >= MAX_TRANSFER_RETRIES) {
            throw err;
          }
          log.warn(`BLE transfer CRC mismatch, will retry`, {
            recordingUuid: recording.uuid,
            attempt: attempt + 1,
            error: (err as Error).message,
          });
        }
      }
      if (lastTransferError) throw lastTransferError;

      yield {
        stage: 'transferring',
        progress: 1,
        bytesTransferred: audioData.length,
        totalBytes: recording.fileSizeBytes,
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

      // Queue for upload (this will process in background)
      const task = await this.uploadQueue.enqueue({
        recordingId: uploadInfo.recordingId,
        deviceId: device.id,
        localPath,
        uploadUrl: uploadInfo.uploadUrl,
        uploadToken: uploadInfo.uploadToken,
        completeUrl: uploadInfo.completeUrl,
        contentType: uploadInfo.contentType,
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
   * Sync all recordings from a device
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

    // Sync each recording
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
   * device via BLE while the recording is still in progress, and uploads chunks
   * to S3 as they arrive.
   *
   * If BLE disconnects, the session emits 'disconnected'. The recording
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
    uploadInfoProvider: UploadInfoProvider,
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
      options?.chunkSizeKb
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

/**
 * Streaming session — manages a live streaming sync of the current recording.
 *
 * Coordinates: BLE streaming transfer ↔ chunked S3 upload
 * Independent from batch sync — they don't share locks or state.
 */
export class StreamingSession extends EventEmitter<StreamingSessionEvents> {
  private _state: StreamingState = 'idle';
  private _bytesReceived = 0;
  private _chunksUploaded = 0;
  private _recordingId?: string;
  private _isAborted = false;
  private chunkBuffer: Buffer[] = [];
  private chunkBytesBuffered = 0;
  private readonly chunkSize: number;

  constructor(
    private protocolHandler: ProtocolHandler,
    private storageManager: StorageManager,
    private device: ConnectedDevice,
    private recordingUuid: string,
    private uploadInfoProvider: UploadInfoProvider,
    chunkSizeKb?: number
  ) {
    super();
    // Clamp to 64KB-1MB, default 256KB (matches backend setting range)
    const kb = Math.max(64, Math.min(1024, chunkSizeKb ?? 256));
    this.chunkSize = kb * 1024;
  }

  get state(): StreamingState { return this._state; }
  get bytesReceived(): number { return this._bytesReceived; }
  get chunksUploaded(): number { return this._chunksUploaded; }
  get recordingId(): string | undefined { return this._recordingId; }
  get isActive(): boolean { return this._state === 'streaming' || this._state === 'paused'; }

  /**
   * Start the streaming session (called internally by RecordingManager)
   */
  async start(): Promise<void> {
    this._state = 'streaming';

    try {
      // Get upload info for the streaming recording
      const fakeRecording: DeviceRecording = {
        uuid: this.recordingUuid,
        startedAt: new Date(),
        durationMs: 0, // Unknown — still recording
        fileSizeBytes: 0,
        codec: 'opus_16k',
      };
      const uploadInfo = await this.uploadInfoProvider(fakeRecording);
      this._recordingId = uploadInfo.recordingId;

      // Start BLE streaming transfer
      const result = await this.protocolHandler.streamTransfer(
        this.device.id,
        this.recordingUuid,
        {
          onData: (_seq, data) => {
            this._bytesReceived += data.length;
            this.chunkBuffer.push(data);
            this.chunkBytesBuffered += data.length;

            // Upload a chunk when we've buffered enough
            if (this.chunkBytesBuffered >= this.chunkSize) {
              this.flushChunk();
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
        }
      );

      // EOF received — recording stopped, flush remaining data
      this._state = 'uploading';

      // Flush any remaining buffered data as final chunk
      if (this.chunkBytesBuffered > 0) {
        await this.flushChunk();
      }

      // Finalize and confirm
      this._state = 'completing';
      await this.protocolHandler.confirmSync(this.device.id, this.recordingUuid);

      this._state = 'completed';
      this.emit('completed', {
        recordingId: this._recordingId!,
        totalBytes: result.totalBytes,
      });
    } catch (error) {
      if (this._isAborted) {
        return; // Don't emit error for intentional abort
      }

      const err = error as Error;
      // Check if this is a BLE disconnection
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

  /**
   * Flush buffered data as an S3 chunk upload
   */
  private async flushChunk(): Promise<void> {
    if (this.chunkBuffer.length === 0) return;

    const chunkData = Buffer.concat(this.chunkBuffer);
    this.chunkBuffer = [];
    this.chunkBytesBuffered = 0;
    const chunkNumber = this._chunksUploaded + 1;

    // Save chunk to local storage (for recovery if S3 upload fails)
    await this.storageManager.saveRecordingData(
      this.device.id,
      `${this.recordingUuid}_chunk_${chunkNumber}`,
      chunkData
    );

    this._chunksUploaded = chunkNumber;

    log.debug('Flushed streaming chunk', {
      chunkNumber,
      size: chunkData.length,
      totalReceived: this._bytesReceived,
    });
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
