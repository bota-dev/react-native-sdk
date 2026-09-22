const mockValues = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockValues.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { mockValues.set(key, value); }),
    removeItem: jest.fn(async (key: string) => { mockValues.delete(key); }),
    getAllKeys: jest.fn(async () => [...mockValues.keys()]),
  },
}));

import { Buffer } from 'buffer';

import type { RecordingDataStore, UploadTask } from '../src/models/Recording';
import { StorageManager } from '../src/storage/StorageManager';
import { S3Uploader } from '../src/upload/S3Uploader';
import { UploadQueue } from '../src/upload/UploadQueue';

class DurableTestStore implements RecordingDataStore {
  readonly files = new Map<string, Uint8Array>();

  async saveRecordingData(input: {
    deviceId: string;
    recordingUuid: string;
    data: Uint8Array;
  }): Promise<string> {
    const path = `private://${input.deviceId}/${input.recordingUuid}`;
    this.files.set(path, Uint8Array.from(input.data));
    return path;
  }

  async loadRecordingData(localPath: string): Promise<Uint8Array> {
    const value = this.files.get(localPath);
    if (!value) throw new Error(`missing ${localPath}`);
    return Uint8Array.from(value);
  }

  async deleteRecordingData(localPath: string): Promise<void> {
    this.files.delete(localPath);
  }
}

const restoredTask = (localPath: string): UploadTask => ({
  id: 'task-recovery',
  recordingId: 'rec_existing',
  deviceId: 'device-1',
  recordingUuid: '00112233-4455-6677-8899-aabbccddeeff',
  localPath,
  uploadUrl: 'https://old.example/upload?signature=secret',
  uploadToken: 'up_secret',
  completeUrl: 'https://old.example/complete',
  contentType: 'audio/ogg',
  contentSha256: '11'.repeat(32),
  relayUpload: false,
  status: 'uploading',
  retryCount: 0,
  createdAt: new Date('2026-09-22T00:00:00.000Z'),
  updatedAt: new Date('2026-09-22T00:00:01.000Z'),
});

describe('durable upload recovery', () => {
  beforeEach(() => {
    mockValues.clear();
    jest.restoreAllMocks();
  });

  it('persists only resumable metadata and resets an interrupted task to pending', async () => {
    const files = new DurableTestStore();
    const first = new StorageManager(files);
    await first.initialize();
    const localPath = await first.saveRecordingData(
      'device-1',
      '00112233-4455-6677-8899-aabbccddeeff',
      Buffer.from('audio')
    );
    await first.addUploadTask(restoredTask(localPath));

    const serialized = [...mockValues.values()].find((value) => value.includes('task-recovery'));
    expect(serialized).toBeDefined();
    expect(serialized).not.toMatch(/old\.example|up_secret|signature=secret/);
    expect(serialized).toContain('rec_existing');
    expect(serialized).toContain('00112233-4455-6677-8899-aabbccddeeff');

    const second = new StorageManager(files);
    await second.initialize();
    expect(second.getUploadTask('task-recovery')).toMatchObject({
      status: 'pending',
      uploadUrl: '',
      recordingId: 'rec_existing',
    });
    await expect(second.loadRecordingData(localPath)).resolves.toEqual(Buffer.from('audio'));
  });

  it('refreshes credentials for the same recording and deletes data only after completion', async () => {
    const files = new DurableTestStore();
    const first = new StorageManager(files);
    await first.initialize();
    const localPath = await first.saveRecordingData(
      'device-1',
      '00112233-4455-6677-8899-aabbccddeeff',
      Buffer.from('audio')
    );
    await first.addUploadTask(restoredTask(localPath));

    const storage = new StorageManager(files);
    await storage.initialize();
    const upload = jest.spyOn(S3Uploader.prototype, 'upload').mockResolvedValue();
    const complete = jest.spyOn(S3Uploader.prototype, 'notifyCompletion').mockResolvedValue();
    const provider = jest.fn(async () => ({
      recordingId: 'rec_existing',
      uploadUrl: 'https://fresh.example/upload',
      uploadToken: 'up_fresh',
      completeUrl: 'https://fresh.example/complete',
      contentType: 'audio/ogg',
    }));
    const queue = new UploadQueue(storage, {
      autoStart: false,
      recoveryProvider: provider,
    });
    const completed = new Promise<void>((resolve) => {
      queue.once('taskCompleted', () => resolve());
    });

    queue.resume();
    await completed;

    expect(provider).toHaveBeenCalledWith(expect.objectContaining({
      recordingId: 'rec_existing',
      recordingUuid: '00112233-4455-6677-8899-aabbccddeeff',
      relayUpload: false,
    }));
    expect(upload).toHaveBeenCalledWith(
      Buffer.from('audio'),
      'https://fresh.example/upload',
      expect.objectContaining({ contentType: 'audio/ogg' })
    );
    expect(complete).toHaveBeenCalledWith(
      'https://fresh.example/complete',
      'rec_existing',
      'up_fresh',
      '11'.repeat(32)
    );
    expect(files.files.has(localPath)).toBe(false);
    expect(storage.getUploadTask('task-recovery')).toMatchObject({ status: 'completed' });
  });

  it('discards failed credentials before a whole-object retry', async () => {
    const files = new DurableTestStore();
    const storage = new StorageManager(files);
    await storage.initialize();
    const localPath = await storage.saveRecordingData(
      'device-1',
      '00112233-4455-6677-8899-aabbccddeeff',
      Buffer.from('audio')
    );
    const task = restoredTask(localPath);
    task.status = 'pending';
    task.uploadUrl = '';
    task.createdAt = new Date();
    await storage.addUploadTask(task);

    const upload = jest.spyOn(S3Uploader.prototype, 'upload')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce();
    jest.spyOn(S3Uploader.prototype, 'notifyCompletion').mockResolvedValue();
    let issue = 0;
    const provider = jest.fn(async () => {
      issue += 1;
      return {
        recordingId: 'rec_existing',
        uploadUrl: `https://fresh.example/upload-${issue}`,
        uploadToken: `up_fresh_${issue}`,
        completeUrl: 'https://fresh.example/complete',
      };
    });
    const queue = new UploadQueue(storage, {
      autoStart: false,
      recoveryProvider: provider,
    });
    const completed = new Promise<void>((resolve) => {
      queue.once('taskCompleted', () => resolve());
    });

    queue.resume();
    await completed;

    expect(provider).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.map((call) => call[1])).toEqual([
      'https://fresh.example/upload-1',
      'https://fresh.example/upload-2',
    ]);
  });
});
