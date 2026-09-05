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
import AsyncStorage from '@react-native-async-storage/async-storage';

import { StorageManager } from '../src/storage/StorageManager';
import type { PersistedEncryptedUploadV2Checkpoint } from '../src/models/Recording';

const checkpoint = (): PersistedEncryptedUploadV2Checkpoint => ({
  deviceId: 'device-1',
  uploadSessionUuid: 'ffeeddcc-bbaa-9988-7766-554433221100',
  recordingUuid: '00112233-4455-6677-8899-aabbccddeeff',
  recordingGeneration: 3,
  ownerRevision: 4,
  revision: 5,
  nextCiphertextOffset: 2048n,
  prefixSha256: Buffer.alloc(32, 0x11),
  highestContiguousSequence: 7,
  windowPackets: 4,
  dataPayloadBytes: 64,
  checkpointIntervalBlocks: 1,
  ciphertextLength: 4096n,
  ciphertextSha256: Buffer.alloc(32, 0x22),
});

describe('encrypted upload v2 checkpoint persistence', () => {
  beforeEach(() => {
    mockValues.clear();
    (AsyncStorage.setItem as jest.Mock).mockReset().mockImplementation(
      async (key: string, value: string) => { mockValues.set(key, value); }
    );
  });

  it('round-trips only resumable metadata through AsyncStorage', async () => {
    const first = new StorageManager();
    await first.initialize();
    await first.saveEncryptedUploadV2Checkpoint(checkpoint());

    const serialized = [...mockValues.values()].find((value) => value.includes('ffeeddcc'));
    expect(serialized).toBeDefined();
    expect(serialized).not.toMatch(/authorization|receipt|manifest|ciphertextBytes|uploadUrl|header|localPath/i);

    const second = new StorageManager();
    await second.initialize();
    expect(second.getEncryptedUploadV2Checkpoint(
      'device-1',
      '00112233-4455-6677-8899-aabbccddeeff',
      3
    )).toEqual(checkpoint());
  });

  it('deletes only the matching recording generation checkpoint', async () => {
    const storage = new StorageManager();
    await storage.initialize();
    await storage.saveEncryptedUploadV2Checkpoint(checkpoint());

    await storage.deleteEncryptedUploadV2Checkpoint(
      'device-1',
      '00112233-4455-6677-8899-aabbccddeeff',
      3
    );

    expect(storage.getEncryptedUploadV2Checkpoint(
      'device-1',
      '00112233-4455-6677-8899-aabbccddeeff',
      3
    )).toBeUndefined();
  });

  it('does not expose a checkpoint when durable persistence fails', async () => {
    const storage = new StorageManager();
    await storage.initialize();
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));

    await expect(storage.saveEncryptedUploadV2Checkpoint(checkpoint())).rejects.toThrow(
      'disk full'
    );
    expect(storage.getEncryptedUploadV2Checkpoint(
      'device-1',
      '00112233-4455-6677-8899-aabbccddeeff',
      3
    )).toBeUndefined();
  });

  it('restores an in-memory checkpoint when durable deletion fails', async () => {
    const storage = new StorageManager();
    await storage.initialize();
    await storage.saveEncryptedUploadV2Checkpoint(checkpoint());
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));

    await expect(storage.deleteEncryptedUploadV2Checkpoint(
      'device-1',
      '00112233-4455-6677-8899-aabbccddeeff',
      3
    )).rejects.toThrow('disk full');
    expect(storage.getEncryptedUploadV2Checkpoint(
      'device-1',
      '00112233-4455-6677-8899-aabbccddeeff',
      3
    )).toEqual(checkpoint());
  });

  it('serializes checkpoint snapshots across concurrent devices', async () => {
    const storage = new StorageManager();
    await storage.initialize();
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    (AsyncStorage.setItem as jest.Mock)
      .mockImplementationOnce(async (key: string, value: string) => {
        await firstWrite;
        mockValues.set(key, value);
      });
    const second = {
      ...checkpoint(),
      deviceId: 'device-2',
      uploadSessionUuid: '11111111-2222-3333-4444-555555555555',
    };

    const firstSave = storage.saveEncryptedUploadV2Checkpoint(checkpoint());
    const secondSave = storage.saveEncryptedUploadV2Checkpoint(second);
    await Promise.resolve();
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
    releaseFirstWrite();
    await Promise.all([firstSave, secondSave]);

    const serialized = [...mockValues.values()].find((value) => value.includes('device-2'));
    expect(serialized).toContain('device-1');
    expect(serialized).toContain('device-2');
  });
});
