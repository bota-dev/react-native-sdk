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
import * as retry from '../src/utils/retry';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
      '11'.repeat(32),
      expect.any(AbortSignal)
    );
    expect(files.files.has(localPath)).toBe(false);
    expect(storage.getUploadTask('task-recovery')).toMatchObject({ status: 'completed' });
  });

  it('discards failed credentials before a whole-object retry', async () => {
    jest.spyOn(retry, 'calculateDelay').mockReturnValue(0);
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

async function fixture(provider: import('../src/models/Recording').UploadRecoveryProvider) {
  const files = new DurableTestStore();
  const storage = new StorageManager(files);
  await storage.initialize();
  const path = await storage.saveRecordingData('device-1', 'uuid', Buffer.from('audio'));
  const task = { ...restoredTask(path), createdAt: new Date(), status: 'pending' as const };
  await storage.addUploadTask(task);
  const queue = new UploadQueue(storage, { autoStart: false, recoveryProvider: provider, maxRetries: 0 });
  return { files, storage, path, queue };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('upload recovery review regressions', () => {
  beforeEach(() => { mockValues.clear(); jest.restoreAllMocks(); });

  it('retains bytes and never reports completion before the host ACK', async () => {
    jest.spyOn(S3Uploader.prototype, 'upload').mockResolvedValue();
    const complete = jest.fn(async () => { throw new Error('ACK lost https://secret/token'); });
    const f = await fixture(async () => ({ recordingId: 'rec_existing', uploadUrl: 'https://fresh', complete }));
    const done = jest.fn(); f.queue.on('taskCompleted', done);
    const failed = new Promise<void>(resolve => f.queue.once('taskFailed', () => resolve()));
    f.queue.resume(); await failed;
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ fileSizeBytes: 5 }));
    expect(done).not.toHaveBeenCalled();
    expect(f.files.files.has(f.path)).toBe(true);
    expect([...mockValues.values()].join()).not.toContain('secret');
    f.queue.destroy();
  });

  it('recovers a lost ACK without PUT or requesting new upload credentials', async () => {
    const upload = jest.spyOn(S3Uploader.prototype, 'upload');
    const f = await fixture(async () => ({ recordingId: 'rec_existing', uploadUrl: '', alreadyUploaded: true }));
    const completed = new Promise<void>(resolve => f.queue.once('taskCompleted', () => resolve()));
    f.queue.resume(); await completed;
    expect(upload).not.toHaveBeenCalled(); expect(f.files.files.has(f.path)).toBe(false);
    f.queue.destroy();
  });

  it('parks an unavailable account without exhausting retry budget', async () => {
    const provider = jest.fn(async () => null);
    const f = await fixture(provider); f.queue.resume(); await tick();
    expect(f.storage.getUploadTask('task-recovery')).toMatchObject({ status: 'pending', retryCount: 0 });
    expect(provider).toHaveBeenCalledTimes(1); expect(f.files.files.has(f.path)).toBe(true);
    f.queue.destroy();
  });

  it('does not send bytes after cancellation while the provider is pending', async () => {
    let deliver!: (value: any) => void;
    const disposed = jest.fn();
    const upload = jest.spyOn(S3Uploader.prototype, 'upload');
    const f = await fixture(() => new Promise(resolve => { deliver = resolve; }));
    f.queue.resume(); await tick(); f.queue.destroy();
    deliver({ recordingId: 'rec_existing', uploadUrl: 'https://fresh', dispose: disposed }); await tick();
    expect(upload).not.toHaveBeenCalled(); expect(disposed).toHaveBeenCalledTimes(1);
    expect(f.files.files.has(f.path)).toBe(true);
  });

  it('keeps completion durable if unlink fails and cleans up after restart', async () => {
    const f = await fixture(async () => ({ recordingId: 'rec_existing', uploadUrl: '', alreadyUploaded: true }));
    jest.spyOn(f.files, 'deleteRecordingData').mockRejectedValueOnce(new Error('disk'));
    const completed = new Promise<void>(resolve => f.queue.once('taskCompleted', () => resolve()));
    f.queue.resume(); await completed;
    expect(f.storage.getUploadTask('task-recovery')?.status).toBe('completed');
    f.queue.destroy(); await new StorageManager(f.files).initialize();
    expect(f.files.files.has(f.path)).toBe(false);
  });

  it('drops legacy signed URLs and error text when migrating queue metadata', async () => {
    mockValues.set('@bota_sdk:upload_queue', JSON.stringify([{ ...restoredTask('private'), errorMessage: 'https://secret' }]));
    const storage = new StorageManager(); await storage.initialize();
    expect(storage.getUploadTask('task-recovery')?.uploadUrl).toBe('');
    expect([...mockValues.values()].join()).not.toMatch(/secret|old.example/);
  });

  it('preserves a corrupt journal instead of overwriting it on startup', async () => {
    mockValues.set('@bota_sdk:upload_queue', '{broken');
    await expect(new StorageManager().initialize()).rejects.toThrow();
    expect(mockValues.get('@bota_sdk:upload_queue')).toBe('{broken');
  });

  it('serializes concurrent queue mutations with independent rollback', async () => {
    const storage = new StorageManager(); await storage.initialize();
    jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk'));
    const one = storage.addUploadTask(restoredTask('one'));
    const two = storage.addUploadTask({ ...restoredTask('two'), id: 'second' });
    await expect(one).rejects.toThrow('disk'); await two;
    expect(storage.getUploadQueue().map(task => task.id)).toEqual(['second']);
    expect(JSON.parse(mockValues.get('@bota_sdk:upload_queue')!)).toHaveLength(1);
  });

  it('uses persisted backoff rather than consuming all retries immediately', async () => {
    const f = await fixture(async () => { throw new Error('offline'); });
    // A separate queue uses the normal retry budget.
    f.queue.destroy();
    const queue = new UploadQueue(f.storage, { autoStart: false, recoveryProvider: async () => { throw new Error('offline'); } });
    queue.resume(); await tick();
    const task = f.storage.getUploadTask('task-recovery')!;
    expect(task.status).toBe('pending'); expect(task.retryCount).toBe(1);
    expect(task.nextAttemptAt! - Date.now()).toBeGreaterThan(29_000);
    queue.destroy();
  });
});
