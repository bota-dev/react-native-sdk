const mockGetBleManager = jest.fn();

jest.mock('../src/ble/BleManager', () => ({
  getBleManager: () => mockGetBleManager(),
}));
jest.mock('react-native-quick-crypto', () => require('node:crypto'), { virtual: true });

import { createHash } from 'node:crypto';
import { Buffer } from 'buffer';

import {
  CHAR_RECORDING_LIST_V2,
  CHAR_RECORDING_TRANSFER_V2,
  CHAR_STORAGE_TRANSFER_CAPABILITIES_V2,
  CHAR_TRANSFER_CONTROL_V2,
  CHAR_TRANSFER_SIGNED_BLOB_V2,
  CHAR_TRANSFER_STATUS_V2,
} from '../src/ble/constants';
import { ProtocolHandler } from '../src/protocol/ProtocolHandler';
import {
  decodeEncryptedUploadV2SignedBlob,
  decodeEncryptedUploadV2Transfer,
  encodeEncryptedUploadV2SignedBlob,
  encodeEncryptedUploadV2Transfer,
} from '../src/protocol/encryptedUploadV2';
import type {
  EncryptedUploadV2Checkpoint,
  EncryptedUploadV2CiphertextSink,
} from '../src/protocol/encryptedUploadV2Runtime';
const digest = (value: Uint8Array): Buffer => createHash('sha256').update(value).digest();

function document(magic: string, length: number, fill: number): Buffer {
  const value = Buffer.alloc(length, fill);
  value.write(magic, 0, 'ascii');
  value.writeUInt16LE(2, 8);
  value.writeUInt16LE(length, 10);
  return value;
}

function capability(): Buffer {
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
}

const uuid = '00112233-4455-6677-8899-aabbccddeeff';
const sessionUuid = 'ffeeddcc-bbaa-9988-7766-554433221100';
const uuidBytes = (value: string): Buffer => Buffer.from(value.replace(/-/g, ''), 'hex');
const common = (messageType: number) => ({ messageType, flags: 0, transportSessionId: 7n });

class TestSink implements EncryptedUploadV2CiphertextSink {
  bytes = Buffer.alloc(0);

  async prepare(checkpoint: EncryptedUploadV2Checkpoint): Promise<void> {
    this.bytes = this.bytes.subarray(0, Number(checkpoint.nextCiphertextOffset));
  }

  async write(offset: bigint, bytes: Buffer): Promise<void> {
    const start = Number(offset);
    if (start + bytes.length > this.bytes.length) {
      this.bytes = Buffer.concat([
        this.bytes,
        Buffer.alloc(start + bytes.length - this.bytes.length),
      ]);
    }
    bytes.copy(this.bytes, start);
  }

  async byteLength(): Promise<bigint> { return BigInt(this.bytes.length); }
  async sha256Prefix(length: bigint): Promise<Buffer> {
    return digest(this.bytes.subarray(0, Number(length)));
  }
}

describe('ProtocolHandler encrypted upload v2', () => {
  let subscriptions: Map<string, (data: Buffer) => void>;
  let writes: Array<{ characteristic: string; data: Buffer }>;

  beforeEach(() => {
    subscriptions = new Map();
    writes = [];
    mockGetBleManager.mockReset();
    mockGetBleManager.mockReturnValue({
      isConnected: jest.fn(() => true),
      hasCharacteristic: jest.fn(async () => true),
      getMtu: jest.fn(async () => 128),
      readCharacteristic: jest.fn(async (
        _deviceId: string,
        _service: string,
        characteristic: string
      ) => {
        if (characteristic === CHAR_STORAGE_TRANSFER_CAPABILITIES_V2) return capability();
        throw new Error(`unexpected read ${characteristic}`);
      }),
      subscribeToCharacteristic: jest.fn((
        _deviceId: string,
        _service: string,
        characteristic: string,
        onData: (data: Buffer) => void
      ) => {
        subscriptions.set(characteristic, onData);
        return { remove: jest.fn() };
      }),
      writeCharacteristic: jest.fn(async (
        _deviceId: string,
        _service: string,
        characteristic: string,
        data: Buffer
      ) => {
        writes.push({ characteristic, data });
      }),
    });
  });

  it('reads and hashes the exact dedicated capability value', async () => {
    const handler = new ProtocolHandler();

    const snapshot = await handler.getEncryptedUploadV2Capabilities('device-1');

    if (!snapshot) throw new Error('expected capability snapshot');
    expect(snapshot.rawValue).toEqual(capability());
    expect(snapshot.sha256).toEqual(digest(capability()));
    expect(snapshot.capabilities.flags).toBe(0x7f);
  });

  it('reports explicit characteristic absence without converting read failures to absence', async () => {
    const ble = mockGetBleManager();
    ble.hasCharacteristic.mockResolvedValue(false);
    const handler = new ProtocolHandler();

    await expect(handler.getEncryptedUploadV2Capabilities('device-1')).resolves.toBeUndefined();
    expect(ble.readCharacteristic).not.toHaveBeenCalled();

    ble.hasCharacteristic.mockResolvedValue(true);
    ble.readCharacteristic.mockRejectedValue(new Error('link failed'));
    await expect(handler.getEncryptedUploadV2Capabilities('device-1')).rejects.toThrow('link failed');
  });

  it('lists full v2 recording identities only through 040B/0408', async () => {
    const ble = mockGetBleManager();
    ble.writeCharacteristic.mockImplementation(async (
      _deviceId: string,
      _service: string,
      characteristic: string,
      data: Buffer
    ) => {
      writes.push({ characteristic, data });
      const request = decodeEncryptedUploadV2Transfer(data);
      if (request.type !== 'list') return;
      const entry = encodeEncryptedUploadV2Transfer({
        type: 'recordingEntry',
        common: common(0x48),
        recordingUuid: uuidBytes(uuid),
        recordingGeneration: 3,
        storageFormat: 3,
        completionState: 1,
        startedAt: 1_700_000_000n,
        durationSeconds: 12,
        plaintextLength: 100n,
        ciphertextLength: 144n,
        ciphertextSha256: Buffer.alloc(32, 0xaa),
      });
      subscriptions.get(CHAR_RECORDING_LIST_V2)?.(entry);
      subscriptions.get(CHAR_RECORDING_LIST_V2)?.(encodeEncryptedUploadV2Transfer({
        type: 'recordingListEnd',
        common: common(0x49),
        count: 1,
        listRevision: 9,
        listSha256: digest(entry.subarray(12)),
      }));
    });
    const handler = new ProtocolHandler();

    const recordings = await handler.listEncryptedUploadV2Recordings('device-1', 7n);

    expect(recordings).toEqual([expect.objectContaining({
      uuid,
      generation: 3,
      storageFormat: 3,
      ciphertextLength: 144n,
    })]);
    expect(writes).toHaveLength(1);
    expect(writes[0].characteristic).toBe(CHAR_TRANSFER_CONTROL_V2);
    expect(subscriptions.has(CHAR_RECORDING_LIST_V2)).toBe(true);
  });

  it('delivers a signed document through 0407 and waits for its matching result', async () => {
    const ble = mockGetBleManager();
    ble.writeCharacteristic.mockImplementation(async (
      _deviceId: string,
      _service: string,
      characteristic: string,
      data: Buffer
    ) => {
      writes.push({ characteristic, data });
      const frame = decodeEncryptedUploadV2SignedBlob(data);
      if (frame.type === 'blobCommit') {
        subscriptions.get(CHAR_TRANSFER_SIGNED_BLOB_V2)?.(
          encodeEncryptedUploadV2SignedBlob({ ...frame, type: 'blobResult', result: 0 })
        );
      }
    });
    const handler = new ProtocolHandler();
    const authorization = document('BOTAAUT2', 408, 0x42);

    await handler.sendEncryptedUploadV2Document(
      'device-1', 1, 11, authorization, 1024
    );

    expect(writes.length).toBeGreaterThan(3);
    expect(writes.every((write) => write.characteristic === CHAR_TRANSFER_SIGNED_BLOB_V2)).toBe(true);
    expect(decodeEncryptedUploadV2SignedBlob(writes[0].data)).toMatchObject({
      type: 'blobBegin', kind: 1, writeId: 11, totalLength: 408,
    });
  });

  it('transfers ciphertext and manifest through 0409 and ACKs windows through 0408', async () => {
    const ciphertext = Buffer.from('opaque');
    const manifest = document('BOTAMNF2', 580, 0x33);
    const ble = mockGetBleManager();
    ble.writeCharacteristic.mockImplementation(async (
      _deviceId: string,
      _service: string,
      characteristic: string,
      data: Buffer
    ) => {
      writes.push({ characteristic, data });
      if (characteristic !== CHAR_TRANSFER_CONTROL_V2) return;
      const frame = decodeEncryptedUploadV2Transfer(data);
      if (frame.type !== 'start') return;
      const notify = subscriptions.get(CHAR_RECORDING_TRANSFER_V2);
      notify?.(encodeEncryptedUploadV2Transfer({
        type: 'startAck',
        common: common(0x40),
        uploadSessionUuid: uuidBytes(sessionUuid),
        recordingUuid: uuidBytes(uuid),
        recordingGeneration: 3,
        ciphertextLength: BigInt(ciphertext.length),
        ciphertextSha256: digest(ciphertext),
        windowPackets: 4,
        dataPayloadBytes: 64,
        checkpointIntervalBlocks: 1,
        checkpointRevision: 0,
        nextCiphertextOffset: 0n,
        prefixSha256: digest(Buffer.alloc(0)),
      }));
      notify?.(encodeEncryptedUploadV2Transfer({
        type: 'data', common: common(0x41), sequence: 0, offset: 0n, data: ciphertext,
      }));
      notify?.(encodeEncryptedUploadV2Transfer({
        type: 'windowEnd',
        common: common(0x42),
        windowIndex: 0,
        firstSequence: 0,
        lastSequence: 0,
        nextCiphertextOffset: BigInt(ciphertext.length),
        prefixSha256: digest(ciphertext),
        checkpointRevision: 1,
      }));
      for (let offset = 0; offset < manifest.length; offset += 200) {
        notify?.(encodeEncryptedUploadV2Transfer({
          type: 'manifestChunk',
          common: common(0x43),
          totalManifestLength: 580,
          chunkOffset: offset,
          manifestSha256: digest(manifest),
          chunk: manifest.subarray(offset, Math.min(offset + 200, manifest.length)),
        }));
      }
      notify?.(encodeEncryptedUploadV2Transfer({
        type: 'eof',
        common: common(0x44),
        finalSequence: 0,
        blockCount: 1,
        ciphertextLength: BigInt(ciphertext.length),
        ciphertextSha256: digest(ciphertext),
        manifestSha256: digest(manifest),
      }));
    });
    const sink = new TestSink();
    const persistCheckpoint = jest.fn(async () => undefined);
    const handler = new ProtocolHandler();

    const result = await handler.transferEncryptedUploadV2('device-1', {
      transportSessionId: 7n,
      uploadSessionUuid: sessionUuid,
      recording: {
        uuid,
        generation: 3,
        storageFormat: 3,
        startedAt: new Date(0),
        durationMs: 0,
        plaintextLength: 3n,
        ciphertextLength: BigInt(ciphertext.length),
        ciphertextSha256: digest(ciphertext),
      },
      authorizationSha256: Buffer.alloc(32, 0x11),
      windowPackets: 4,
      dataPayloadBytes: 64,
      checkpointIntervalBlocks: 1,
      maximumMissingSequences: 2,
      checkpoint: {
        revision: 0,
        nextCiphertextOffset: 0n,
        prefixSha256: digest(Buffer.alloc(0)),
      },
      sink,
      persistCheckpoint,
    });

    expect(sink.bytes).toEqual(ciphertext);
    expect(result.manifest).toEqual(manifest);
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
    expect(writes.some((write) => {
      if (write.characteristic !== CHAR_TRANSFER_CONTROL_V2) return false;
      return decodeEncryptedUploadV2Transfer(write.data).type === 'windowAck';
    })).toBe(true);
  });

  it('retains transfer ownership until a cancelled sink write drains', async () => {
    const ciphertext = Buffer.from('opaque');
    const controller = new AbortController();
    let markWriteStarted!: () => void;
    let releaseWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    class SlowSink extends TestSink {
      override async write(offset: bigint, bytes: Buffer): Promise<void> {
        markWriteStarted();
        await writeGate;
        await super.write(offset, bytes);
      }
    }
    const ble = mockGetBleManager();
    ble.writeCharacteristic.mockImplementation(async (
      _deviceId: string,
      _service: string,
      characteristic: string,
      data: Buffer
    ) => {
      writes.push({ characteristic, data });
      if (characteristic !== CHAR_TRANSFER_CONTROL_V2) return;
      const frame = decodeEncryptedUploadV2Transfer(data);
      if (frame.type !== 'start') return;
      const notify = subscriptions.get(CHAR_RECORDING_TRANSFER_V2);
      notify?.(encodeEncryptedUploadV2Transfer({
        type: 'startAck',
        common: common(0x40),
        uploadSessionUuid: uuidBytes(sessionUuid),
        recordingUuid: uuidBytes(uuid),
        recordingGeneration: 3,
        ciphertextLength: BigInt(ciphertext.length),
        ciphertextSha256: digest(ciphertext),
        windowPackets: 4,
        dataPayloadBytes: 64,
        checkpointIntervalBlocks: 1,
        checkpointRevision: 0,
        nextCiphertextOffset: 0n,
        prefixSha256: digest(Buffer.alloc(0)),
      }));
      notify?.(encodeEncryptedUploadV2Transfer({
        type: 'data', common: common(0x41), sequence: 0, offset: 0n, data: ciphertext,
      }));
    });
    const handler = new ProtocolHandler();
    const request = {
      transportSessionId: 7n,
      uploadSessionUuid: sessionUuid,
      recording: {
        uuid,
        generation: 3,
        storageFormat: 3 as const,
        startedAt: new Date(0),
        durationMs: 0,
        plaintextLength: 3n,
        ciphertextLength: BigInt(ciphertext.length),
        ciphertextSha256: digest(ciphertext),
      },
      authorizationSha256: Buffer.alloc(32, 0x11),
      windowPackets: 4,
      dataPayloadBytes: 64,
      checkpointIntervalBlocks: 1,
      maximumMissingSequences: 2,
      checkpoint: {
        revision: 0,
        nextCiphertextOffset: 0n,
        prefixSha256: digest(Buffer.alloc(0)),
      },
      sink: new SlowSink(),
      signal: controller.signal,
      persistCheckpoint: jest.fn(async () => undefined),
    };
    const transfer = handler.transferEncryptedUploadV2('device-1', request);
    await writeStarted;
    controller.abort();

    await expect(handler.transferEncryptedUploadV2('device-1', request)).rejects.toMatchObject({
      code: 'encrypted_upload_v2_invalid_configuration',
    });
    let settled = false;
    void transfer.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseWrite();
    await expect(transfer).rejects.toMatchObject({
      code: 'encrypted_upload_v2_cancelled',
    });
  });

  it('retains ownership and delays ABORT until a cancelled START write settles', async () => {
    const controller = new AbortController();
    let markStartPending!: () => void;
    let releaseStart!: () => void;
    const startPending = new Promise<void>((resolve) => { markStartPending = resolve; });
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const ble = mockGetBleManager();
    ble.writeCharacteristic.mockImplementation(async (
      _deviceId: string,
      _service: string,
      characteristic: string,
      data: Buffer
    ) => {
      writes.push({ characteristic, data });
      if (
        characteristic === CHAR_TRANSFER_CONTROL_V2 &&
        decodeEncryptedUploadV2Transfer(data).type === 'start'
      ) {
        markStartPending();
        await startGate;
      }
    });
    const handler = new ProtocolHandler();
    const request = {
      transportSessionId: 7n,
      uploadSessionUuid: sessionUuid,
      recording: {
        uuid,
        generation: 3,
        storageFormat: 3 as const,
        startedAt: new Date(0),
        durationMs: 0,
        plaintextLength: 3n,
        ciphertextLength: 6n,
        ciphertextSha256: digest(Buffer.from('opaque')),
      },
      authorizationSha256: Buffer.alloc(32, 0x11),
      windowPackets: 4,
      dataPayloadBytes: 64,
      checkpointIntervalBlocks: 1,
      maximumMissingSequences: 2,
      checkpoint: {
        revision: 0,
        nextCiphertextOffset: 0n,
        prefixSha256: digest(Buffer.alloc(0)),
      },
      sink: new TestSink(),
      signal: controller.signal,
      persistCheckpoint: jest.fn(async () => undefined),
    };
    const transfer = handler.transferEncryptedUploadV2('device-1', request);
    void transfer.catch(() => undefined);
    await startPending;
    controller.abort();

    await expect(handler.transferEncryptedUploadV2('device-1', request)).rejects.toMatchObject({
      code: 'encrypted_upload_v2_invalid_configuration',
    });
    expect(writes.map((write) => decodeEncryptedUploadV2Transfer(write.data).type)).toEqual([
      'start',
    ]);
    releaseStart();
    await expect(transfer).rejects.toMatchObject({
      code: 'encrypted_upload_v2_cancelled',
    });
    expect(writes.map((write) => decodeEncryptedUploadV2Transfer(write.data).type)).toEqual([
      'start',
      'abort',
    ]);
  });

  it('sends receipt before CONFIRM and resolves only after the matching complete status', async () => {
    const ble = mockGetBleManager();
    ble.writeCharacteristic.mockImplementation(async (
      _deviceId: string,
      _service: string,
      characteristic: string,
      data: Buffer
    ) => {
      writes.push({ characteristic, data });
      if (characteristic === CHAR_TRANSFER_SIGNED_BLOB_V2) {
        const blob = decodeEncryptedUploadV2SignedBlob(data);
        if (blob.type === 'blobCommit') {
          subscriptions.get(CHAR_TRANSFER_SIGNED_BLOB_V2)?.(
            encodeEncryptedUploadV2SignedBlob({ ...blob, type: 'blobResult', result: 0 })
          );
        }
      }
      if (characteristic === CHAR_TRANSFER_CONTROL_V2) {
        const status = Buffer.alloc(24);
        status[0] = 2;
        status[1] = 9;
        status.writeBigUInt64LE(7n, 4);
        status[20] = 100;
        status[21] = 3;
        subscriptions.get(CHAR_TRANSFER_STATUS_V2)?.(status);
      }
    });
    const handler = new ProtocolHandler();
    const receipt = document('BOTARCPT', 336, 0x24);

    await handler.confirmEncryptedUploadV2('device-1', {
      transportSessionId: 7n,
      uploadSessionUuid: sessionUuid,
      recordingUuid: uuid,
      recordingGeneration: 3,
      ownerRevision: 4,
      receipt,
      maximumSignedBlobBytes: 1024,
      writeId: 12,
    });

    const confirmIndex = writes.findIndex((write) =>
      write.characteristic === CHAR_TRANSFER_CONTROL_V2 &&
      decodeEncryptedUploadV2Transfer(write.data).type === 'confirm'
    );
    const commitIndex = writes.findIndex((write) =>
      write.characteristic === CHAR_TRANSFER_SIGNED_BLOB_V2 &&
      decodeEncryptedUploadV2SignedBlob(write.data).type === 'blobCommit'
    );
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(confirmIndex).toBeGreaterThan(commitIndex);
    expect(subscriptions.has(CHAR_TRANSFER_STATUS_V2)).toBe(true);
    expect(subscriptions.has(CHAR_RECORDING_TRANSFER_V2)).toBe(false);
  });

  it('rejects a matching completion status for a non-v2 upload profile', async () => {
    const ble = mockGetBleManager();
    ble.writeCharacteristic.mockImplementation(async (
      _deviceId: string,
      _service: string,
      characteristic: string,
      data: Buffer
    ) => {
      if (characteristic === CHAR_TRANSFER_SIGNED_BLOB_V2) {
        const blob = decodeEncryptedUploadV2SignedBlob(data);
        if (blob.type === 'blobCommit') {
          subscriptions.get(CHAR_TRANSFER_SIGNED_BLOB_V2)?.(
            encodeEncryptedUploadV2SignedBlob({ ...blob, type: 'blobResult', result: 0 })
          );
        }
      }
      if (characteristic === CHAR_TRANSFER_CONTROL_V2) {
        const status = Buffer.alloc(24);
        status[0] = 2;
        status[1] = 9;
        status.writeBigUInt64LE(7n, 4);
        status[20] = 100;
        status[21] = 2;
        subscriptions.get(CHAR_TRANSFER_STATUS_V2)?.(status);
      }
    });
    const handler = new ProtocolHandler();

    await expect(handler.confirmEncryptedUploadV2('device-1', {
      transportSessionId: 7n,
      uploadSessionUuid: sessionUuid,
      recordingUuid: uuid,
      recordingGeneration: 3,
      ownerRevision: 4,
      receipt: document('BOTARCPT', 336, 0x24),
      maximumSignedBlobBytes: 1024,
      writeId: 13,
    })).rejects.toMatchObject({
      code: 'encrypted_upload_v2_confirmation_uncertain',
      underlyingError: expect.objectContaining({
        code: 'encrypted_upload_v2_unexpected_message',
      }),
    });
  });

  it('reports an uncertain commit when the CONFIRM write loses transport status', async () => {
    const ble = mockGetBleManager();
    ble.writeCharacteristic.mockImplementation(async (
      _deviceId: string,
      _service: string,
      characteristic: string,
      data: Buffer
    ) => {
      if (characteristic === CHAR_TRANSFER_SIGNED_BLOB_V2) {
        const blob = decodeEncryptedUploadV2SignedBlob(data);
        if (blob.type === 'blobCommit') {
          subscriptions.get(CHAR_TRANSFER_SIGNED_BLOB_V2)?.(
            encodeEncryptedUploadV2SignedBlob({ ...blob, type: 'blobResult', result: 0 })
          );
        }
      }
      if (characteristic === CHAR_TRANSFER_CONTROL_V2) {
        throw new Error('BLE write result lost');
      }
    });
    const handler = new ProtocolHandler();

    await expect(handler.confirmEncryptedUploadV2('device-1', {
      transportSessionId: 7n,
      uploadSessionUuid: sessionUuid,
      recordingUuid: uuid,
      recordingGeneration: 3,
      ownerRevision: 4,
      receipt: document('BOTARCPT', 336, 0x24),
      maximumSignedBlobBytes: 1024,
      writeId: 14,
    })).rejects.toMatchObject({
      code: 'encrypted_upload_v2_confirmation_uncertain',
      underlyingError: expect.objectContaining({ message: 'BLE write result lost' }),
    });
  });

  it('honors cancellation after receipt delivery but before CONFIRM begins', async () => {
    const ble = mockGetBleManager();
    const controller = new AbortController();
    ble.writeCharacteristic.mockImplementation(async (
      _deviceId: string,
      _service: string,
      characteristic: string,
      data: Buffer
    ) => {
      writes.push({ characteristic, data });
      if (characteristic !== CHAR_TRANSFER_SIGNED_BLOB_V2) return;
      const blob = decodeEncryptedUploadV2SignedBlob(data);
      if (blob.type === 'blobCommit') {
        subscriptions.get(CHAR_TRANSFER_SIGNED_BLOB_V2)?.(
          encodeEncryptedUploadV2SignedBlob({ ...blob, type: 'blobResult', result: 0 })
        );
        controller.abort();
      }
    });
    const handler = new ProtocolHandler();

    await expect(handler.confirmEncryptedUploadV2('device-1', {
      transportSessionId: 7n,
      uploadSessionUuid: sessionUuid,
      recordingUuid: uuid,
      recordingGeneration: 3,
      ownerRevision: 4,
      receipt: document('BOTARCPT', 336, 0x24),
      maximumSignedBlobBytes: 1024,
      writeId: 15,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'encrypted_upload_v2_cancelled' });
    expect(writes.some((write) => write.characteristic === CHAR_TRANSFER_CONTROL_V2)).toBe(false);
  });
});
