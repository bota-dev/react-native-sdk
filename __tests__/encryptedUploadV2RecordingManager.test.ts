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
import vectors from '../protocol/vendor/app-sdk/encrypted-upload-v2.json';

import { RecordingManager } from '../src/managers/RecordingManager';
import { logger } from '../src/utils/logger';
import {
  EncryptedUploadV2RuntimeError,
  type EncryptedUploadV2CiphertextSink,
} from '../src/protocol/encryptedUploadV2Runtime';

const digest = (value: Uint8Array): Buffer => createHash('sha256').update(value).digest();
const emptyDigest = digest(Buffer.alloc(0));

function document(magic: string, length: number): Buffer {
  // Start with a complete canonical envelope; identity mutations below are
  // structural test fixtures, not claims of valid signatures.
  const value = magic === 'BOTAAUT2'
    ? Buffer.from(vectors.cases.find(item => item.name === 'authorization-development')!.inputHex, 'hex')
    : Buffer.alloc(length);
  value.write(magic, 0, 'ascii');
  value.writeUInt16LE(2, 8);
  value.writeUInt16LE(length, 10);
  if (magic === 'BOTAAUT2') {
    value[14] = 3; value[15] = 1; value[16] = 1;
    value.writeUInt16LE(1, 30); value.writeUInt32LE(4, 32);
    value.writeUInt32LE(3, 40); value.writeBigUInt64LE(144n, 72); value.writeBigUInt64LE(144n, 80);
    Buffer.from('ffeeddccbbaa99887766554433221100', 'hex').copy(value, 88);
    Buffer.from('00112233445566778899aabbccddeeff', 'hex').copy(value, 120);
    value.fill(0xaa, 312, 344);
  }
  return value;
}

const capabilityValue = (() => {
  const value = Buffer.alloc(24);
  value[0] = 1;
  value[1] = 2;
  value.writeUInt16LE(24, 2);
  value.writeUInt32LE(0x17f, 4);
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
  flags: 0x17f,
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
  beforeEach(() => logger.setHandler(() => {}));
  afterEach(() => logger.setHandler(null));

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
      refreshEncryptedUploadV2Context: jest.fn(async () => { operations.push('context'); }),
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
      uploadContext: jest.fn(),
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

  it('requires room for the 140-byte START_ACK before calling the provider', async () => {
    const manager = createManager([]);
    const uploadProvider = provider([]);
    mockBleManager.getMtu.mockResolvedValueOnce(142);
    await expect(collect(manager.syncEncryptedRecordingV2(device, recording, uploadProvider)))
      .rejects.toThrow('encrypted_upload_v2_unsupported');
    expect(uploadProvider).not.toHaveBeenCalled();
    expect(manager.protocolHandler.sendEncryptedUploadV2Document).not.toHaveBeenCalled();
  });

  it.each(['provider', 'authorization', 'context', 'transfer'])(
    'reports the failing %s phase without exposing error payloads', async (phase) => {
      const manager = createManager([]);
      const uploadProvider = provider([]);
      const failure = new TypeError('secret signed-document or URL payload');
      if (phase === 'provider') uploadProvider.mockRejectedValueOnce(failure);
      if (phase === 'authorization') manager.protocolHandler.sendEncryptedUploadV2Document.mockRejectedValueOnce(failure);
      if (phase === 'context') manager.protocolHandler.refreshEncryptedUploadV2Context.mockRejectedValueOnce(failure);
      if (phase === 'transfer') manager.protocolHandler.transferEncryptedUploadV2.mockRejectedValueOnce(failure);
      const entries: unknown[] = [];
      logger.setHandler(entry => entries.push(entry));
      try {
        await expect(collect(manager.syncEncryptedRecordingV2(device, recording, uploadProvider)))
          .rejects.toBe(failure);
        const output = JSON.stringify(entries);
        expect(output).toContain(`Encrypted v2 sync failed at ${phase}`);
        expect(output).not.toContain('secret signed-document or URL payload');
      } finally {
        logger.setHandler(null);
      }
    }
  );

  it('does not cancel an uncertain CONFIRM when the diagnostic handler throws', async () => {
    const operations: string[] = [];
    const manager = createManager(operations);
    const failure = new EncryptedUploadV2RuntimeError('encrypted_upload_v2_confirmation_uncertain');
    manager.protocolHandler.confirmEncryptedUploadV2.mockRejectedValueOnce(failure);
    const previousLevel = logger.getLevel();
    logger.setLevel('debug');
    logger.setHandler(() => { throw new Error('broken host logger'); });
    try {
      await expect(collect(manager.syncEncryptedRecordingV2(device, recording, provider(operations))))
        .rejects.toBe(failure);
      expect(operations).not.toContain('abort');
      expect(operations).not.toContain('cancel');
    } finally {
      logger.setLevel(previousLevel);
      logger.setHandler(null);
    }
  });

  it('lists mixed storage without exposing a v2 object as a second legacy choice', async () => {
    const manager = createManager([]);
    const legacy = { uuid: 'aabbccdd-0000-0000-0000-000000000000' };
    manager.protocolHandler.listRecordings = jest.fn(async () => [
      { uuid: '00112233-0000-0000-0000-000000000000' }, legacy,
    ]);
    manager.protocolHandler.listEncryptedUploadV2Recordings = jest.fn(async () => [recording]);
    expect(await manager.listPendingRecordings(device)).toEqual([recording, legacy]);
    manager.protocolHandler.getEncryptedUploadV2Capabilities.mockResolvedValue(undefined);
    manager.protocolHandler.listEncryptedUploadV2Recordings.mockClear();
    expect(await manager.listPendingRecordings(device)).toHaveLength(2);
    expect(manager.protocolHandler.listEncryptedUploadV2Recordings).not.toHaveBeenCalled();
  });

  it('does not silently use the legacy catalog when reading v2 capability fails', async () => {
    const manager = createManager([]);
    manager.protocolHandler.getEncryptedUploadV2Capabilities.mockRejectedValue(new Error('GATT read failed'));
    manager.protocolHandler.listRecordings = jest.fn();
    await expect(manager.listPendingRecordings(device)).rejects.toThrow('GATT read failed');
    expect(manager.protocolHandler.listRecordings).not.toHaveBeenCalled();
  });

  it('accepts canonical profile 3 for an ordinary upload through receipt-confirmed deletion', async () => {
    const operations: string[] = [];
    const manager = createManager(operations);
    const uploadProvider = provider(operations);
    const material = await uploadProvider();
    expect(material.authorization[13]).toBe(3);
    uploadProvider.mockResolvedValue(material);

    const progress = await collect(
      manager.syncEncryptedRecordingV2(device, recording, uploadProvider)
    );

    expect(progress.map((value) => value.stage)).toEqual([
      'preparing', 'transferring', 'uploading', 'completing', 'completed',
    ]);
    expect(operations).toEqual([
      'context',
      'authorization',
      'transfer',
      'checkpoint',
      'stage',
      'manifest',
      'finalize',
      'receipt',
      'context',
      'confirm',
      'delete-checkpoint',
    ]);
    expect(uploadProvider).toHaveBeenCalledWith(expect.objectContaining({
      recording,
      checkpoint: undefined,
      capability: expect.objectContaining({ rawValue: capabilityValue }),
    }));
  });

  it('requires the context capability and provider before authorization delivery', async () => {
    const manager = createManager([]);
    const uploadProvider = provider([]);
    manager.protocolHandler.getEncryptedUploadV2Capabilities.mockResolvedValueOnce({
      rawValue: capabilityValue, sha256: digest(capabilityValue), capabilities: { ...capabilities, flags: 0x7f },
    });
    await expect(collect(manager.syncEncryptedRecordingV2(device, recording, uploadProvider))).rejects.toThrow('encrypted_upload_v2_unsupported');
    expect(uploadProvider).not.toHaveBeenCalled();
    const material = await uploadProvider(); delete (material as any).uploadContext;
    await expect(collect(manager.syncEncryptedRecordingV2(device, recording, async () => material))).rejects.toThrow('encrypted_upload_v2_invalid_configuration');
    expect(manager.protocolHandler.sendEncryptedUploadV2Document).not.toHaveBeenCalled();
  });

  it('retains the file and never CONFIRMs if fresh receipt context fails', async () => {
    const operations: string[] = []; const manager = createManager(operations);
    manager.protocolHandler.refreshEncryptedUploadV2Context.mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('context rejected'));
    await expect(collect(manager.syncEncryptedRecordingV2(device, recording, provider(operations)))).rejects.toThrow('context rejected');
    expect(operations).not.toContain('confirm'); expect(operations).not.toContain('delete-checkpoint');
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

  it('reports device-confirmed completion when last-sync bookkeeping fails', async () => {
    const operations: string[] = [];
    const manager = createManager(operations);
    manager.storage.setLastSyncTime.mockRejectedValue(new Error('local storage unavailable'));

    const progress = await collect(
      manager.syncEncryptedRecordingV2(device, recording, provider(operations))
    );

    expect(progress.at(-1)).toMatchObject({ stage: 'completed', recordingId: 'rec_123' });
    expect(operations).toContain('confirm');
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
    mockBleManager.getMtu.mockResolvedValueOnce(143);

    await collect(manager.syncEncryptedRecordingV2(
      device,
      recording,
      provider(operations)
    ));

    expect(manager.protocolHandler.transferEncryptedUploadV2).toHaveBeenCalledWith(
      device.id,
      expect.objectContaining({
        windowPackets: 18,
        maximumMissingSequences: 18,
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

  function replacement(operations: string[]) {
    const manager = createManager(operations);
    const stored = { uploadSessionUuid: '11223344-5566-7788-9900-aabbccddeeff', ownerRevision: 3,
      recordingUuid: recording.uuid, recordingGeneration: 3, ciphertextLength: 144n,
      ciphertextSha256: recording.ciphertextSha256, revision: 7, nextCiphertextOffset: 100n,
      prefixSha256: emptyDigest, windowPackets: 2, dataPayloadBytes: 64, checkpointIntervalBlocks: 1 };
    manager.storage.getEncryptedUploadV2Checkpoint.mockReturnValue(stored);
    manager.protocolHandler.getEncryptedUploadV2Capabilities.mockResolvedValue({
      rawValue: capabilityValue, capabilities: { ...capabilities, flags: 0x37f }, sha256: digest(capabilityValue),
    });
    return { manager, stored };
  }

  it.each(['ordinary', 'replacement'])('rejects wire profile 2 for %s uploads before context or authorization delivery', async (kind) => {
    const operations: string[] = [];
    const { manager, stored } = kind === 'replacement'
      ? replacement(operations)
      : { manager: createManager(operations), stored: undefined };
    const material = await provider(operations)();
    if (kind === 'replacement') material.authorization.writeUInt16LE(9, 30);
    material.authorization[13] = 2;

    await expect(collect(manager.syncEncryptedRecordingV2(device, recording, async () => material)))
      .rejects.toMatchObject({ code: 'encrypted_upload_v2_invalid_configuration' });
    expect(operations).not.toContain('context');
    expect(operations).not.toContain('authorization');
    expect(operations).not.toContain('transfer');
    expect(operations).not.toContain('checkpoint');
    expect(operations).not.toContain('delete-checkpoint');
    expect(manager.storage.getEncryptedUploadV2Checkpoint()).toBe(stored);
  });

  it.each(['context', 'authorization', 'transfer'])('retains the old owner checkpoint on replacement %s failure', async (phase) => {
    const operations: string[] = []; const { manager, stored } = replacement(operations);
    const material = await provider(operations)(); material.authorization.writeUInt16LE(9, 30);
    const method = { context: 'refreshEncryptedUploadV2Context', authorization: 'sendEncryptedUploadV2Document', transfer: 'transferEncryptedUploadV2' }[phase];
    manager.protocolHandler[method!].mockRejectedValue(new EncryptedUploadV2RuntimeError('encrypted_upload_v2_checkpoint_mismatch'));
    await expect(collect(manager.syncEncryptedRecordingV2(device, recording, async () => material))).rejects.toThrow('checkpoint_mismatch');
    expect(manager.storage.getEncryptedUploadV2Checkpoint()).toBe(stored);
    expect(operations).not.toContain('delete-checkpoint'); expect(operations).not.toContain('checkpoint');
  });

  it.each(['flag', 'capability', 'revision', 'session', 'recording', 'generation', 'length', 'digest', 'stored-identity', 'owner-bound', 'stored-higher', 'same-session']) (
    'rejects replacement with mismatched %s before device delivery', async (field) => {
      const operations: string[] = []; const { manager, stored } = replacement(operations);
      const material = await provider(operations)(); material.authorization.writeUInt16LE(9, 30);
      if (field === 'flag') material.authorization.writeUInt16LE(1, 30);
      if (field === 'capability') manager.protocolHandler.getEncryptedUploadV2Capabilities.mockResolvedValue({ capabilities, rawValue: capabilityValue });
      if (field === 'revision') material.authorization.writeUInt32LE(3, 32);
      if (field === 'session') material.authorization[88] ^= 1;
      if (field === 'recording') material.authorization[120] ^= 1;
      if (field === 'generation') material.authorization.writeUInt32LE(4, 40);
      if (field === 'length') material.authorization.writeBigUInt64LE(145n, 80);
      if (field === 'digest') material.authorization[312] ^= 1;
      if (field === 'stored-identity') stored.ciphertextLength = 145n;
      if (field === 'owner-bound') { material.ownerRevision = 2147483648; material.authorization.writeUInt32LE(2147483648, 32); }
      if (field === 'stored-higher') stored.ownerRevision = 5;
      if (field === 'same-session') stored.uploadSessionUuid = material.uploadSessionUuid;
      await expect(collect(manager.syncEncryptedRecordingV2(device, recording, async () => material))).rejects.toThrow();
      expect(operations).not.toContain('authorization'); expect(operations).not.toContain('delete-checkpoint');
    }
  );

  it('accepts canonical profile 3 for a replacement upload and supersedes old evidence only through durable persistence', async () => {
    const operations: string[] = []; const { manager } = replacement(operations);
    const material = await provider(operations)(); material.authorization.writeUInt16LE(9, 30);
    expect(material.authorization[13]).toBe(3);
    const progress = await collect(manager.syncEncryptedRecordingV2(device, recording, async () => material));
    expect(progress.at(-1)).toMatchObject({ stage: 'completed', recordingId: 'rec_123' });
    expect(manager.protocolHandler.transferEncryptedUploadV2).toHaveBeenCalledWith(device.id, expect.objectContaining({ checkpoint: expect.objectContaining({ revision: 0, nextCiphertextOffset: 0n }) }));
    expect(manager.storage.saveEncryptedUploadV2Checkpoint).toHaveBeenCalledWith(expect.objectContaining({ ownerRevision: 4, revision: 1 }));
    expect(operations.indexOf('authorization')).toBeLessThan(operations.indexOf('checkpoint'));
    expect(operations.indexOf('confirm')).toBeLessThan(operations.indexOf('delete-checkpoint'));
  });

  it('resumes the same accepted replacement checkpoint without resetting its offset', async () => {
    const operations: string[] = []; const { manager, stored } = replacement(operations);
    const material = await provider(operations)(); material.authorization.writeUInt16LE(9, 30);
    stored.ownerRevision = material.ownerRevision; stored.uploadSessionUuid = material.uploadSessionUuid;
    await collect(manager.syncEncryptedRecordingV2(device, recording, async () => material));
    expect(manager.protocolHandler.transferEncryptedUploadV2).toHaveBeenCalledWith(device.id, expect.objectContaining({ checkpoint: expect.objectContaining({ revision: 7, nextCiphertextOffset: 100n }) }));
  });

  it('checks the replacement capability even when there is no old app checkpoint', async () => {
    const operations: string[] = []; const manager = createManager(operations);
    const material = await provider(operations)(); material.authorization.writeUInt16LE(9, 30);
    await expect(collect(manager.syncEncryptedRecordingV2(device, recording, async () => material))).rejects.toThrow('invalid_configuration');
    expect(operations).not.toContain('authorization');
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
    expect(manager.protocolHandler.getEncryptedUploadV2Capabilities)
      .toHaveBeenCalledWith(device.id, controller.signal);
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
