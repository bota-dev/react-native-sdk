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

      // Stage: Transferring from device
      const audioData = await this.protocolHandler.transferRecording(
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
   * Clean up resources
   */
  destroy(): void {
    log.info('Destroying RecordingManager');
    this.protocolHandler.destroy();
    this.uploadQueue.destroy();
    this.storage.destroy();
    this.removeAllListeners();
    this.isInitialized = false;
  }
}
