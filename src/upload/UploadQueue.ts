/**
 * Upload Queue - Manages persistent upload queue with retry logic
 */

import EventEmitter from 'eventemitter3';

import type { UploadTask } from '../models/Recording';
import { StorageManager, generateTaskId } from '../storage/StorageManager';
import { S3Uploader } from './S3Uploader';
import { shouldContinueRetrying } from '../utils/retry';
import { logger } from '../utils/logger';

const log = logger.tag('UploadQueue');

/**
 * Events emitted by UploadQueue
 */
interface UploadQueueEvents {
  taskAdded: (task: UploadTask) => void;
  taskUpdated: (task: UploadTask) => void;
  taskCompleted: (taskId: string, recordingId: string) => void;
  taskFailed: (taskId: string, error: Error) => void;
  uploadProgress: (taskId: string, progress: number) => void;
  queueEmpty: () => void;
}

/**
 * Upload Queue configuration
 */
export interface UploadQueueConfig {
  /** Maximum concurrent uploads (default: 2) */
  maxConcurrent?: number;
  /** Maximum retry attempts (default: 6) */
  maxRetries?: number;
  /** Auto-start processing (default: true) */
  autoStart?: boolean;
}

/**
 * Upload Queue class
 */
export class UploadQueue extends EventEmitter<UploadQueueEvents> {
  private storage: StorageManager;
  private uploader: S3Uploader;
  private maxConcurrent: number;
  private maxRetries: number;
  private activeUploads: Set<string> = new Set();
  private isPaused = false;
  private isProcessing = false;
  private abortControllers: Map<string, AbortController> = new Map();

  constructor(storage: StorageManager, config: UploadQueueConfig = {}) {
    super();
    this.storage = storage;
    this.uploader = new S3Uploader();
    this.maxConcurrent = config.maxConcurrent ?? 2;
    this.maxRetries = config.maxRetries ?? 6;

    if (config.autoStart !== false) {
      this.processQueue();
    }
  }

  /**
   * Add a new upload task to the queue
   */
  async enqueue(params: {
    recordingId: string;
    deviceId: string;
    localPath: string;
    uploadUrl: string;
    uploadToken?: string;
    completeUrl?: string;
    contentType?: string;
    /** P9.F2: device-computed SHA-256 (hex) forwarded to completeUrl. */
    contentSha256?: string;
    /** P10: BLE-e2e relay upload — see UploadTask.relay. */
    relay?: { url: string; bearerToken: string };
  }): Promise<UploadTask> {
    const task: UploadTask = {
      id: generateTaskId(),
      recordingId: params.recordingId,
      deviceId: params.deviceId,
      localPath: params.localPath,
      uploadUrl: params.uploadUrl,
      uploadToken: params.uploadToken,
      completeUrl: params.completeUrl,
      contentType: params.contentType,
      contentSha256: params.contentSha256,
      relay: params.relay,
      status: 'pending',
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.storage.addUploadTask(task);
    this.emit('taskAdded', task);

    log.info('Task enqueued', { taskId: task.id, recordingId: task.recordingId });

    // Trigger queue processing
    this.processQueue();

    return task;
  }

  /**
   * Cancel a specific upload task
   */
  async cancel(taskId: string): Promise<void> {
    log.info('Cancelling task', { taskId });

    // Abort if currently uploading
    const controller = this.abortControllers.get(taskId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(taskId);
    }

    // Remove from active uploads
    this.activeUploads.delete(taskId);

    // Remove from queue
    await this.storage.removeUploadTask(taskId);
  }

  /**
   * Cancel all uploads
   */
  async cancelAll(): Promise<void> {
    log.info('Cancelling all uploads');

    // Abort all active uploads
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
    this.activeUploads.clear();

    // Clear queue
    await this.storage.clearAllTasks();
    this.emit('queueEmpty');
  }

  /**
   * Pause queue processing
   */
  pause(): void {
    log.info('Pausing upload queue');
    this.isPaused = true;
  }

  /**
   * Resume queue processing
   */
  resume(): void {
    log.info('Resuming upload queue');
    this.isPaused = false;
    this.processQueue();
  }

  /**
   * Retry all failed uploads
   */
  async retryFailed(): Promise<void> {
    log.info('Retrying failed uploads');

    const failedTasks = this.storage.getFailedUploads();
    for (const task of failedTasks) {
      if (task.retryCount < this.maxRetries) {
        await this.storage.updateTaskStatus(task.id, 'pending');
      }
    }

    this.processQueue();
  }

  /**
   * Get all pending tasks
   */
  getPendingTasks(): UploadTask[] {
    return this.storage.getPendingUploads();
  }

  /**
   * Get all tasks
   */
  getAllTasks(): UploadTask[] {
    return this.storage.getUploadQueue();
  }

  /**
   * Process the upload queue
   */
  private async processQueue(): Promise<void> {
    if (this.isPaused || this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      while (!this.isPaused) {
        // Check if we can start more uploads
        if (this.activeUploads.size >= this.maxConcurrent) {
          break;
        }

        // Get next pending task
        const pendingTasks = this.storage.getPendingUploads();
        const nextTask = pendingTasks.find(
          (t) => !this.activeUploads.has(t.id) && t.status === 'pending'
        );

        if (!nextTask) {
          // No more tasks to process
          if (this.activeUploads.size === 0) {
            this.emit('queueEmpty');
          }
          break;
        }

        // Start upload in background
        this.processTask(nextTask);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single upload task
   */
  private async processTask(task: UploadTask): Promise<void> {
    this.activeUploads.add(task.id);

    const abortController = new AbortController();
    this.abortControllers.set(task.id, abortController);

    try {
      // Update status to uploading
      await this.storage.updateTaskStatus(task.id, 'uploading');
      this.emit('taskUpdated', { ...task, status: 'uploading' });

      log.info('Starting upload', { taskId: task.id, recordingId: task.recordingId });

      // Load the audio data
      const audioData = await this.storage.loadRecordingData(task.localPath);

      if (task.relay) {
        // P10 BLE-e2e relay path: POST ciphertext to backend; backend
        // decrypts and writes plaintext to S3 server-side. The relay
        // endpoint also marks the recording uploaded — no separate
        // completion call needed.
        log.info('Uploading via BLE-e2e relay', {
          taskId: task.id,
          recordingId: task.recordingId,
        });
        await this.uploader.relayUpload(
          audioData,
          task.relay.url,
          task.relay.bearerToken,
          {
            onProgress: (progress) => {
              this.emit('uploadProgress', task.id, progress);
            },
            abortSignal: abortController.signal,
          }
        );
      } else {
        // Standard pre-signed S3 PUT
        await this.uploader.upload(audioData, task.uploadUrl, {
          contentType: task.contentType,
          onProgress: (progress) => {
            this.emit('uploadProgress', task.id, progress);
          },
          abortSignal: abortController.signal,
        });

        // Notify completion (only if completeUrl and uploadToken are provided)
        if (task.completeUrl && task.uploadToken) {
          await this.uploader.notifyCompletion(
            task.completeUrl,
            task.recordingId,
            task.uploadToken,
            task.contentSha256
          );
        } else {
          log.debug('Skipping completion notification (custom completion flow)', {
            taskId: task.id,
            recordingId: task.recordingId,
          });
        }
      }

      // Mark as completed
      await this.storage.updateTaskStatus(task.id, 'completed');

      // Clean up local file
      await this.storage.deleteRecordingData(task.localPath);

      log.info('Upload completed', { taskId: task.id, recordingId: task.recordingId });

      this.emit('taskCompleted', task.id, task.recordingId);
    } catch (error) {
      const err = error as Error;
      log.error('Upload failed', err, { taskId: task.id });

      // Check if we should retry
      if (
        task.retryCount < this.maxRetries &&
        shouldContinueRetrying(task.createdAt)
      ) {
        await this.storage.incrementRetryCount(task.id);
        await this.storage.updateTaskStatus(task.id, 'pending', err.message);
        log.info('Task will be retried', {
          taskId: task.id,
          retryCount: task.retryCount + 1,
        });
      } else {
        await this.storage.updateTaskStatus(task.id, 'failed', err.message);
        this.emit('taskFailed', task.id, err);
      }
    } finally {
      this.activeUploads.delete(task.id);
      this.abortControllers.delete(task.id);

      // Process next task
      this.processQueue();
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.isPaused = true;

    // Abort all active uploads
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
    this.activeUploads.clear();

    this.removeAllListeners();
  }
}
