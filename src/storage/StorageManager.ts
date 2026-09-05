/**
 * Storage Manager - Local persistence for recordings and upload queue
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Buffer } from 'buffer';

import type {
  PersistedEncryptedUploadV2Checkpoint,
  UploadTask,
  UploadTaskStatus,
} from '../models/Recording';
import { logger } from '../utils/logger';

const log = logger.tag('StorageManager');

// Storage keys
const STORAGE_PREFIX = '@bota_sdk:';
const UPLOAD_QUEUE_KEY = `${STORAGE_PREFIX}upload_queue`;
const SDK_STATE_KEY = `${STORAGE_PREFIX}sdk_state`;
const ENCRYPTED_UPLOAD_V2_CHECKPOINTS_KEY = `${STORAGE_PREFIX}encrypted_upload_v2_checkpoints`;

/**
 * SDK persistent state
 */
interface SdkState {
  lastSyncTimes: Record<string, number>; // deviceId -> timestamp
  deviceInfo: Record<string, { serialNumber: string; firmwareVersion: string }>;
}

/**
 * Storage Manager class
 */
export class StorageManager {
  private uploadQueue: UploadTask[] = [];
  private sdkState: SdkState = {
    lastSyncTimes: {},
    deviceInfo: {},
  };
  private isInitialized = false;
  private encryptedUploadV2Checkpoints = new Map<
    string,
    PersistedEncryptedUploadV2Checkpoint
  >();
  private encryptedUploadV2CheckpointMutation = Promise.resolve();
  // Audio buffers held in memory — avoids AsyncStorage size limits for large files
  private audioBuffers: Map<string, Buffer> = new Map();

  /**
   * Initialize storage manager
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    log.debug('Initializing StorageManager');

    try {
      // Load upload queue
      const queueData = await AsyncStorage.getItem(UPLOAD_QUEUE_KEY);
      if (queueData) {
        this.uploadQueue = JSON.parse(queueData);
        // Restore dates
        this.uploadQueue = this.uploadQueue.map((task) => ({
          ...task,
          createdAt: new Date(task.createdAt),
          updatedAt: new Date(task.updatedAt),
        }));
      }

      // Load SDK state
      const stateData = await AsyncStorage.getItem(SDK_STATE_KEY);
      if (stateData) {
        this.sdkState = JSON.parse(stateData);
      }

      const checkpointsData = await AsyncStorage.getItem(
        ENCRYPTED_UPLOAD_V2_CHECKPOINTS_KEY
      );
      if (checkpointsData) {
        const serialized = JSON.parse(checkpointsData) as SerializedEncryptedUploadV2Checkpoint[];
        this.encryptedUploadV2Checkpoints = new Map(
          serialized.map((checkpoint) => {
            const value = deserializeEncryptedUploadV2Checkpoint(checkpoint);
            return [encryptedUploadV2CheckpointKey(
              value.deviceId,
              value.recordingUuid,
              value.recordingGeneration
            ), value];
          })
        );
      }

      this.isInitialized = true;
      log.info('StorageManager initialized', {
        pendingUploads: this.uploadQueue.length,
      });
    } catch (error) {
      log.error('Failed to initialize storage', error as Error);
      // Continue with empty state
      this.isInitialized = true;
    }
  }

  // Upload Queue Methods

  /**
   * Get all upload tasks
   */
  getUploadQueue(): UploadTask[] {
    return [...this.uploadQueue];
  }

  /**
   * Get pending upload tasks
   */
  getPendingUploads(): UploadTask[] {
    return this.uploadQueue.filter(
      (task) => task.status === 'pending' || task.status === 'uploading'
    );
  }

  /**
   * Get failed upload tasks
   */
  getFailedUploads(): UploadTask[] {
    return this.uploadQueue.filter((task) => task.status === 'failed');
  }

  /**
   * Add a task to the upload queue
   */
  async addUploadTask(task: UploadTask): Promise<void> {
    log.debug('Adding upload task', { taskId: task.id, recordingId: task.recordingId });

    this.uploadQueue.push(task);
    await this.saveUploadQueue();
  }

  /**
   * Update an upload task
   */
  async updateUploadTask(
    taskId: string,
    updates: Partial<UploadTask>
  ): Promise<void> {
    const index = this.uploadQueue.findIndex((t) => t.id === taskId);
    if (index === -1) {
      log.warn('Upload task not found', { taskId });
      return;
    }

    this.uploadQueue[index] = {
      ...this.uploadQueue[index],
      ...updates,
      updatedAt: new Date(),
    };

    await this.saveUploadQueue();
  }

  /**
   * Update task status
   */
  async updateTaskStatus(
    taskId: string,
    status: UploadTaskStatus,
    errorMessage?: string
  ): Promise<void> {
    await this.updateUploadTask(taskId, { status, errorMessage });
  }

  /**
   * Increment retry count for a task
   */
  async incrementRetryCount(taskId: string): Promise<void> {
    const task = this.uploadQueue.find((t) => t.id === taskId);
    if (task) {
      await this.updateUploadTask(taskId, { retryCount: task.retryCount + 1 });
    }
  }

  /**
   * Remove a task from the queue
   */
  async removeUploadTask(taskId: string): Promise<void> {
    log.debug('Removing upload task', { taskId });

    this.uploadQueue = this.uploadQueue.filter((t) => t.id !== taskId);
    await this.saveUploadQueue();
  }

  /**
   * Clear all completed tasks
   */
  async clearCompletedTasks(): Promise<void> {
    this.uploadQueue = this.uploadQueue.filter(
      (t) => t.status !== 'completed'
    );
    await this.saveUploadQueue();
  }

  /**
   * Clear all tasks
   */
  async clearAllTasks(): Promise<void> {
    this.uploadQueue = [];
    await this.saveUploadQueue();
  }

  /**
   * Get a specific upload task
   */
  getUploadTask(taskId: string): UploadTask | undefined {
    return this.uploadQueue.find((t) => t.id === taskId);
  }

  /**
   * Save upload queue to storage
   */
  private async saveUploadQueue(): Promise<void> {
    try {
      await AsyncStorage.setItem(
        UPLOAD_QUEUE_KEY,
        JSON.stringify(this.uploadQueue)
      );
    } catch (error) {
      log.error('Failed to save upload queue', error as Error);
    }
  }

  // SDK State Methods

  /**
   * Get last sync time for a device
   */
  getLastSyncTime(deviceId: string): Date | null {
    const timestamp = this.sdkState.lastSyncTimes[deviceId];
    return timestamp ? new Date(timestamp) : null;
  }

  /**
   * Set last sync time for a device
   */
  async setLastSyncTime(deviceId: string, time: Date = new Date()): Promise<void> {
    this.sdkState.lastSyncTimes[deviceId] = time.getTime();
    await this.saveSdkState();
  }

  /**
   * Get cached device info
   */
  getDeviceInfo(
    deviceId: string
  ): { serialNumber: string; firmwareVersion: string } | undefined {
    return this.sdkState.deviceInfo[deviceId];
  }

  /**
   * Cache device info
   */
  async setDeviceInfo(
    deviceId: string,
    info: { serialNumber: string; firmwareVersion: string }
  ): Promise<void> {
    this.sdkState.deviceInfo[deviceId] = info;
    await this.saveSdkState();
  }

  /**
   * Save SDK state to storage
   */
  private async saveSdkState(): Promise<void> {
    try {
      await AsyncStorage.setItem(SDK_STATE_KEY, JSON.stringify(this.sdkState));
    } catch (error) {
      log.error('Failed to save SDK state', error as Error);
    }
  }

  async saveEncryptedUploadV2Checkpoint(
    checkpoint: PersistedEncryptedUploadV2Checkpoint
  ): Promise<void> {
    await this.mutateEncryptedUploadV2Checkpoints(async () => {
      const value = copyEncryptedUploadV2Checkpoint(checkpoint);
      const key = encryptedUploadV2CheckpointKey(
        value.deviceId,
        value.recordingUuid,
        value.recordingGeneration
      );
      const previous = this.encryptedUploadV2Checkpoints.get(key);
      this.encryptedUploadV2Checkpoints.set(key, value);
      try {
        await this.saveEncryptedUploadV2Checkpoints();
      } catch (error) {
        if (previous) this.encryptedUploadV2Checkpoints.set(key, previous);
        else this.encryptedUploadV2Checkpoints.delete(key);
        throw error;
      }
    });
  }

  getEncryptedUploadV2Checkpoint(
    deviceId: string,
    recordingUuid: string,
    recordingGeneration: number
  ): PersistedEncryptedUploadV2Checkpoint | undefined {
    const value = this.encryptedUploadV2Checkpoints.get(
      encryptedUploadV2CheckpointKey(deviceId, recordingUuid, recordingGeneration)
    );
    return value ? copyEncryptedUploadV2Checkpoint(value) : undefined;
  }

  async deleteEncryptedUploadV2Checkpoint(
    deviceId: string,
    recordingUuid: string,
    recordingGeneration: number
  ): Promise<void> {
    await this.mutateEncryptedUploadV2Checkpoints(async () => {
      const key = encryptedUploadV2CheckpointKey(
        deviceId,
        recordingUuid,
        recordingGeneration
      );
      const previous = this.encryptedUploadV2Checkpoints.get(key);
      this.encryptedUploadV2Checkpoints.delete(key);
      try {
        await this.saveEncryptedUploadV2Checkpoints();
      } catch (error) {
        if (previous) this.encryptedUploadV2Checkpoints.set(key, previous);
        throw error;
      }
    });
  }

  private async mutateEncryptedUploadV2Checkpoints(
    mutation: () => Promise<void>
  ): Promise<void> {
    const result = this.encryptedUploadV2CheckpointMutation.then(mutation);
    this.encryptedUploadV2CheckpointMutation = result.catch(() => undefined);
    await result;
  }

  private async saveEncryptedUploadV2Checkpoints(): Promise<void> {
    const values = [...this.encryptedUploadV2Checkpoints.values()].map(
      serializeEncryptedUploadV2Checkpoint
    );
    await AsyncStorage.setItem(
      ENCRYPTED_UPLOAD_V2_CHECKPOINTS_KEY,
      JSON.stringify(values)
    );
  }

  // Recording File Methods

  /**
   * Save recording data locally (held in memory, not persisted to SQLite)
   */
  async saveRecordingData(
    deviceId: string,
    recordingUuid: string,
    data: Buffer
  ): Promise<string> {
    const key = `${STORAGE_PREFIX}recording:${deviceId}:${recordingUuid}`;
    this.audioBuffers.set(key, data);
    log.debug('Saved recording data', { deviceId, recordingUuid, size: data.length });
    return key;
  }

  /**
   * Load recording data
   */
  async loadRecordingData(localPath: string): Promise<Buffer> {
    const buf = this.audioBuffers.get(localPath);
    if (!buf) {
      throw new Error(`Recording not found: ${localPath}`);
    }
    return buf;
  }

  /**
   * Delete recording data
   */
  async deleteRecordingData(localPath: string): Promise<void> {
    this.audioBuffers.delete(localPath);
    log.debug('Deleted recording data', { localPath });
  }

  /**
   * Clear all SDK storage
   */
  async clearAll(): Promise<void> {
    log.info('Clearing all SDK storage');

    try {
      const keys = await AsyncStorage.getAllKeys();
      const botaKeys = keys.filter((k) => k.startsWith(STORAGE_PREFIX));
      await Promise.all(botaKeys.map((key) => AsyncStorage.removeItem(key)));

      this.uploadQueue = [];
      this.sdkState = { lastSyncTimes: {}, deviceInfo: {} };
      this.encryptedUploadV2Checkpoints.clear();
      this.audioBuffers.clear();
    } catch (error) {
      log.error('Failed to clear storage', error as Error);
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.uploadQueue = [];
    this.sdkState = { lastSyncTimes: {}, deviceInfo: {} };
    this.encryptedUploadV2Checkpoints.clear();
    this.audioBuffers.clear();
    this.isInitialized = false;
  }
}

/**
 * Generate a unique task ID
 */
export function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

interface SerializedEncryptedUploadV2Checkpoint {
  deviceId: string;
  uploadSessionUuid: string;
  recordingUuid: string;
  recordingGeneration: number;
  ownerRevision: number;
  revision: number;
  nextCiphertextOffset: string;
  prefixSha256Hex: string;
  highestContiguousSequence?: number;
  windowPackets: number;
  dataPayloadBytes: number;
  checkpointIntervalBlocks: number;
  ciphertextLength: string;
  ciphertextSha256Hex: string;
}

function encryptedUploadV2CheckpointKey(
  deviceId: string,
  recordingUuid: string,
  recordingGeneration: number
): string {
  return `${deviceId}:${recordingUuid.toLowerCase()}:${recordingGeneration}`;
}

function serializeEncryptedUploadV2Checkpoint(
  value: PersistedEncryptedUploadV2Checkpoint
): SerializedEncryptedUploadV2Checkpoint {
  return {
    deviceId: value.deviceId,
    uploadSessionUuid: value.uploadSessionUuid,
    recordingUuid: value.recordingUuid,
    recordingGeneration: value.recordingGeneration,
    ownerRevision: value.ownerRevision,
    revision: value.revision,
    nextCiphertextOffset: value.nextCiphertextOffset.toString(),
    prefixSha256Hex: Buffer.from(value.prefixSha256).toString('hex'),
    highestContiguousSequence: value.highestContiguousSequence,
    windowPackets: value.windowPackets,
    dataPayloadBytes: value.dataPayloadBytes,
    checkpointIntervalBlocks: value.checkpointIntervalBlocks,
    ciphertextLength: value.ciphertextLength.toString(),
    ciphertextSha256Hex: Buffer.from(value.ciphertextSha256).toString('hex'),
  };
}

function deserializeEncryptedUploadV2Checkpoint(
  value: SerializedEncryptedUploadV2Checkpoint
): PersistedEncryptedUploadV2Checkpoint {
  return {
    deviceId: value.deviceId,
    uploadSessionUuid: value.uploadSessionUuid,
    recordingUuid: value.recordingUuid,
    recordingGeneration: value.recordingGeneration,
    ownerRevision: value.ownerRevision,
    revision: value.revision,
    nextCiphertextOffset: BigInt(value.nextCiphertextOffset),
    prefixSha256: Buffer.from(value.prefixSha256Hex, 'hex'),
    highestContiguousSequence: value.highestContiguousSequence,
    windowPackets: value.windowPackets,
    dataPayloadBytes: value.dataPayloadBytes,
    checkpointIntervalBlocks: value.checkpointIntervalBlocks,
    ciphertextLength: BigInt(value.ciphertextLength),
    ciphertextSha256: Buffer.from(value.ciphertextSha256Hex, 'hex'),
  };
}

function copyEncryptedUploadV2Checkpoint(
  value: PersistedEncryptedUploadV2Checkpoint
): PersistedEncryptedUploadV2Checkpoint {
  return {
    ...value,
    prefixSha256: Buffer.from(value.prefixSha256),
    ciphertextSha256: Buffer.from(value.ciphertextSha256),
  };
}
