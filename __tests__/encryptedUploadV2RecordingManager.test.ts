const mockBleManager = {
  isConnected: jest.fn(() => true),
  getMtu: jest.fn(async () => 256),
};

jest.mock('../src/ble/BleManager', () => ({
  getBleManager: () => mockBleManager,
}));
jest.mock('../src/protocol/ProtocolHandler', () => ({ ProtocolHandler: jest.fn() }));
jest.mock('../src/storage/StorageManager', () => ({ StorageManager: jest.fn() }));
jest.mock('../src/upload/UploadQueue', () => ({ UploadQueue: jest.fn() }));
jest.mock('react-native-quick-crypto', () => require('node:crypto'), { virtual: true });

import { createHash } from 'node:crypto';
import { Buffer } from 'buffer';

import { RecordingManager } from '../src/managers/RecordingManager';
import {
  EncryptedUploadV2RuntimeError,
  type EncryptedUploadV2CiphertextSink,
} from '../src/protocol/encryptedUploadV2Runtime';

const digest = (value: Uint8Array): Buffer => createHash('sha256').update(value).digest();
const emptyDigest = digest(Buffer.alloc(0));

function document(magic: string, length: number): Buffer {
  const value = Buffer.alloc(length);
  value.write(magic, 0, 'ascii');
  value.writeUInt16LE(2, 8);
  value.writeUInt16LE(length, 10);
  return value;
}

const capabilityValue = (() => {
  const value = Buffer.alloc(24);
  value[0] = 1;
  value[1] = 2;
  value.writeUInt16LE(24, 2);
  value.writeUInt32LE(0x7f, 4);
  value.writeUInt16LE(1024, 8);
  value.writeUInt16LE(1024, 10);
  value.writeUInt16LE(64, 12);
  value.writeUInt16LE(4, 14);
  value.writeUInt32LE(1, 16);
  value.writeUInt16LE(2, 20);
  return value;
})();

const capabilities = {
  highestTransferProfileVersion: 2,
  flags: 0x7f,
  maximumSignedBlobBytes: 1024,
  maximumManifestBytes: 1024,
  maximumDataPayloadBytes: 64,
  maximumWindowPackets: 4,
  durableCheckpointIntervalBlocks: 1,
  maximumMissingSequences: 2,
};

const recording = {
  uuid: '00112233-4455-6677-8899-aabbccddeeff',
  generation: 3,
  storageFormat: 3 as const,
  startedAt: new Date(1_700_000_000_000),
  durationMs: 12_000,
  plaintextLength: 100n,
  ciphertextLength: 144n,
  ciphertextSha256: Buffer.alloc(32, 0xaa),
};

const device = { id: 'device-1', serialNumber: 'BOTA123' } as any;

async function collect(generator: AsyncGenerator<any>): Promise<any[]> {
  const values: any[] = [];
  for await (const value of generator) values.push(value);
  return values;
}

describe('RecordingManager encrypted upload v2', () => {
  function createManager(operations: string[]) {
    const manager = Object.create(RecordingManager.prototype) as any;
    manager.activeEncryptedUploadV2Devices = new Set();
    manager.protocolHandler = {
      getEncryptedUploadV2Capabilities: jest.fn(async () => ({
        rawValue: capabilityValue,
        sha256: digest(capabilityValue),
        capabilities,
      })),
      sendEncryptedUploadV2Document: jest.fn(async () => { operations.push('authorization'); }),
      transferEncryptedUploadV2: jest.fn(async (_deviceId, request) => {
        operations.push('transfer');
        await request.persistCheckpoint({
          revision: 1,
          nextCiphertextOffset: 144n,
          prefixSha256: recording.ciphertextSha256,
          highestContiguousSequence: 0,
        });
        return {
          manifest: document('BOTAMNF2', 580),
          evidence: {
            ciphertextLength: 144n,
            ciphertextSha256: recording.ciphertextSha256,
            manifestLength: 580,
            manifestSha256: digest(document('BOTAMNF2', 580)),
            blockCount: 1,
          },
        };
      }),
      confirmEncryptedUploadV2: jest.fn(async () => { operations.push('confirm'); }),
      abortEncryptedUploadV2: jest.fn(async () => { operations.push('abort'); }),
    };
    manager.storage = {
      getEncryptedUploadV2Checkpoint: jest.fn(() => undefined),
      saveEncryptedUploadV2Checkpoint: jest.fn(async () => { operations.push('checkpoint'); }),
      deleteEncryptedUploadV2Checkpoint: jest.fn(async () => { operations.push('delete-checkpoint'); }),
      setLastSyncTime: jest.fn(async () => undefined),
    };
    manager.emit = jest.fn();
    return manager;
  }

  function provider(operations: string[], finalizeError?: Error) {
    const sink: EncryptedUploadV2CiphertextSink = {
      prepare: jest.fn(async () => undefined),
      write: jest.fn(async () => undefined),
      byteLength: jest.fn(async () => 0n),
      sha256Prefix: jest.fn(async () => emptyDigest),
    };
    return jest.fn(async () => ({
      policy: 'v2_preferred' as const,
      profile: 'encrypted_upload_v2' as const,
      recordingId: 'rec_123',
      uploadSessionUuid: 'ffeeddcc-bbaa-9988-7766-554433221100',
      ownerRevision: 4,
      authorization: document('BOTAAUT2', 408),
      sink,
      stageCiphertext: async () => { operations.push('stage'); },
      submitManifest: async () => { operations.push('manifest'); },
      finalize: async () => {
        operations.push('finalize');
        if (finalizeError) throw finalizeError;
      },
      completionReceipt: async () => {
        operations.push('receipt');
        return document('BOTARCPT', 336);
      },
      cancel: async () => { operations.push('cancel'); },
    }));
  }

  it('stages, submits, finalizes, receives a receipt, and only then confirms deletion', async () => {
    const operations: string[] = [];
    const manager = createManager(operations);
    const uploadProvider = provider(operations);

    const progress = await collect(
      manager.syncEncryptedRecordingV2(device, recording, uploadProvider)
    );

    expect(progress.map((value) => value.stage)).toEqual([
      'preparing', 'transferring', 'uploading', 'completing', 'completed',
    ]);
    expect(operations).toEqual([
      'authorization',
      'transfer',
      'checkpoint',
      'stage',
      'manifest',
      'finalize',
      'receipt',
      'confirm',
      'delete-checkpoint',
    ]);
    expect(uploadProvider).toHaveBeenCalledWith(expect.objectContaining({
      recording,
      checkpoint: undefined,
      capability: expect.objectContaining({ rawValue: capabilityValue }),
    }));
  });

  it('never confirms or downgrades after a v2 finalization failure', async () => {
    const operations: string[] = [];
    const manager = createManager(operations);
    const uploadProvider = provider(operations, new Error('finalize failed'));

    await expect(collect(
      manager.syncEncryptedRecordingV2(device, recording, uploadProvider)
    )).rejects.toThrow('finalize failed');

    expect(operations).toContain('abort');
    expect(operations).toContain('cancel');
    expect(operations).not.toContain('confirm');
    expect(operations).not.toContain('delete-checkpoint');
  });

  it('rejects v2 before provider invocation when the capability is absent', async () => {
    const operations: string[] = [];
    const manager = createManager(operations);
    manager.protocolHandler.getEncryptedUploadV2Capabilities.mockResolvedValue(undefined);
    const uploadProvider = provider(operations);

    await expect(collect(
      manager.syncEncryptedRecordingV2(device, recording, uploadProvider)
    )).rejects.toMatchObject({ code: 'encrypted_upload_v2_unsupported' });
    expect(uploadProvider).not.toHaveBeenCalled();
    expect(operations).toEqual([]);
  });

  it('does not reverse completion when checkpoint cleanup remains pending', async () => {
    const operations: string[] = [];
    const manager = createManager(operations);
    manager.storage.deleteEncryptedUploadV2Checkpoint.mockImplementation(async () => {
      operations.push('delete-checkpoint');
      throw new Error('checkpoint cleanup failed');
    });

    const progress = await collect(
      manager.syncEncryptedRecordingV2(device, recording, provider(operations))
    );

    expect(progress.at(-1)?.stage).toBe('completed');
    expect(operations).toContain('confirm');
    expect(operations).toContain('delete-checkpoint');
    expect(operations).not.toContain('abort');
    expect(operations).not.toContain('cancel');
  });

  it('does not abort or cancel after confirmation becomes uncertain', async () => {
    const operations: string[] = [];
    const manager = createManager(operations);
    manager.protocolHandler.confirmEncryptedUploadV2.mockImplementation(async () => {
      operations.push('confirm');
      throw new EncryptedUploadV2RuntimeError(
        'encrypted_upload_v2_confirmation_uncertain',
        undefined,
        new Error('confirmation status lost')
      );
    });

    await expect(collect(
      manager.syncEncryptedRecordingV2(device, recording, provider(operations))
    )).rejects.toMatchObject({
      code: 'encrypted_upload_v2_confirmation_uncertain',
      underlyingError: expect.objectContaining({ message: 'confirmation status lost' }),
    });

    expect(operations).toContain('confirm');
    expect(operations).not.toContain('delete-checkpoint');
    expect(operations).not.toContain('abort');
    expect(operations).not.toContain('cancel');
  });

  it('allows only one v2 owner per connected device', async () => {
    const operations: string[] = [];
    const manager = createManager(operations);
    const first = manager.syncEncryptedRecordingV2(
      device,
      recording,
      provider(operations)
    );

    await expect(first.next()).resolves.toMatchObject({
      value: { stage: 'preparing' },
      done: false,
    });
    await expect(collect(
      manager.syncEncryptedRecordingV2(device, recording, provider(operations))
    )).rejects.toMatchObject({
      code: 'encrypted_upload_v2_operation_in_progress',
    });

    await first.return(undefined);
    expect(manager.activeEncryptedUploadV2Devices.size).toBe(0);
  });

  it('aborts and cancels when the consumer stops an unconfirmed generator', async () => {
    const operations: string[] = [];
    const manager = createManager(operations);
    const sync = manager.syncEncryptedRecordingV2(
      device,
      recording,
      provider(operations)
    );

    await sync.next();
    await sync.next();
    await sync.return(undefined);

    expect(operations).toContain('abort');
    expect(operations).toContain('cancel');
  });

  it('rejects an MTU that cannot carry the fixed v2 START before provider work', async () => {
    const operations: string[] = [];
    const manager = createManager(operations);
    const uploadProvider = provider(operations);
    mockBleManager.getMtu.mockResolvedValueOnce(130);

    await expect(collect(
      manager.syncEncryptedRecordingV2(device, recording, uploadProvider)
    )).rejects.toMatchObject({ code: 'encrypted_upload_v2_unsupported' });

    expect(uploadProvider).not.toHaveBeenCalled();
    expect(operations).toEqual([]);
  });

  it('caps window repair bounds to the negotiated ATT payload', async () => {
    const operations: string[] = [];
    const manager = createManager(operations);
    manager.protocolHandler.getEncryptedUploadV2Capabilities.mockResolvedValue({
      rawValue: capabilityValue,
      sha256: digest(capabilityValue),
      capabilities: {
        ...capabilities,
        maximumWindowPackets: 100,
        maximumMissingSequences: 100,
      },
    });
    mockBleManager.getMtu.mockResolvedValueOnce(131);

    await collect(manager.syncEncryptedRecordingV2(
      device,
      recording,
      provider(operations)
    ));

    expect(manager.protocolHandler.transferEncryptedUploadV2).toHaveBeenCalledWith(
      device.id,
      expect.objectContaining({
        windowPackets: 15,
        maximumMissingSequences: 15,
        dataPayloadBytes: 64,
      })
    );
  });

  it('discards a locally advanced checkpoint after device resume rejection', async () => {
    const operations: string[] = [];
    const manager = createManager(operations);
    manager.protocolHandler.transferEncryptedUploadV2.mockRejectedValue(
      new EncryptedUploadV2RuntimeError('encrypted_upload_v2_checkpoint_mismatch')
    );

    await expect(collect(
      manager.syncEncryptedRecordingV2(device, recording, provider(operations))
    )).rejects.toMatchObject({ code: 'encrypted_upload_v2_checkpoint_mismatch' });

    expect(operations).toContain('delete-checkpoint');
    expect(operations).toContain('cancel');
  });

  it('propagates AbortSignal through an in-flight v2 transfer', async () => {
    const operations: string[] = [];
    const manager = createManager(operations);
    const controller = new AbortController();
    let markTransferStarted!: () => void;
    const transferStarted = new Promise<void>((resolve) => {
      markTransferStarted = resolve;
    });
    manager.protocolHandler.transferEncryptedUploadV2.mockImplementation(
      async (_deviceId, request) => {
        markTransferStarted();
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            reject(new EncryptedUploadV2RuntimeError('encrypted_upload_v2_cancelled'));
          }, { once: true });
        });
      }
    );
    const sync = manager.syncEncryptedRecordingV2(
      device,
      recording,
      provider(operations),
      { signal: controller.signal }
    );

    await sync.next();
    const pending = sync.next();
    await transferStarted;
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      value: { stage: 'failed', error: 'encrypted_upload_v2_cancelled' },
      done: false,
    });
    await expect(sync.next()).rejects.toMatchObject({
      code: 'encrypted_upload_v2_cancelled',
    });
    expect(operations).toContain('abort');
    expect(operations).toContain('cancel');
  });
});
