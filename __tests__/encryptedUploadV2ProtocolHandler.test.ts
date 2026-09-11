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
  CHAR_UPLOAD_CONTEXT_V2,
} from '../src/ble/constants';
import { ProtocolHandler } from '../src/protocol/ProtocolHandler';
import { logger } from '../src/utils/logger';
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
      on: jest.fn(),
      off: jest.fn(),
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

  it('retries canonical zero flags and observes readiness on the same connection', async () => {
    jest.useFakeTimers();
    try {
      const ble = mockGetBleManager();
      const pending = capability(); pending.writeUInt32LE(0, 4);
      ble.readCharacteristic.mockResolvedValueOnce(pending).mockResolvedValue(capability());
      const result = new ProtocolHandler().getEncryptedUploadV2Capabilities('device-1');
      await jest.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toMatchObject({ capabilities: { flags: 0x7f } });
      expect(ble.readCharacteristic).toHaveBeenCalledTimes(2);
    } finally { jest.useRealTimers(); }
  });

  it('bounds unavailable capability retries without returning legacy absence', async () => {
    jest.useFakeTimers();
    try {
      const ble = mockGetBleManager();
      const pending = capability(); pending.writeUInt32LE(0, 4);
      ble.readCharacteristic.mockResolvedValue(pending);
      const handler = new ProtocolHandler();
      const result = expect(handler.getEncryptedUploadV2Capabilities('device-1'))
        .rejects.toMatchObject({ code: 'encrypted_upload_v2_capability_unavailable' });
      await jest.advanceTimersByTimeAsync(10000); await result;
      expect(ble.readCharacteristic.mock.calls.length).toBeLessThanOrEqual(100);
      ble.readCharacteristic.mockResolvedValue(capability());
      await expect(handler.getEncryptedUploadV2Capabilities('device-1')).resolves.toBeDefined();
    } finally { jest.useRealTimers(); }
  });

  it('times out hung reads and fences overlap until late read drains', async () => {
    jest.useFakeTimers();
    try {
      const ble = mockGetBleManager(); let finish!: (value: Buffer) => void;
      ble.readCharacteristic.mockReturnValueOnce(new Promise<Buffer>(resolve => { finish = resolve; }));
      const handler = new ProtocolHandler();
      const result = expect(handler.getEncryptedUploadV2Capabilities('device-1'))
        .rejects.toMatchObject({ code: 'encrypted_upload_v2_capability_unavailable' });
      await jest.advanceTimersByTimeAsync(10000); await result;
      await expect(handler.getEncryptedUploadV2Capabilities('device-1'))
        .rejects.toMatchObject({ code: 'encrypted_upload_v2_operation_in_progress' });
      finish(capability()); await jest.advanceTimersByTimeAsync(0);
      await expect(handler.getEncryptedUploadV2Capabilities('device-1')).resolves.toBeDefined();
      expect(ble.readCharacteristic).toHaveBeenCalledTimes(2);
    } finally { jest.useRealTimers(); }
  });

  it('includes hung characteristic discovery in the same deadline', async () => {
    jest.useFakeTimers();
    try {
      const ble = mockGetBleManager(); let finish!: (value: boolean) => void;
      ble.hasCharacteristic.mockReturnValueOnce(new Promise<boolean>(resolve => { finish = resolve; }));
      const handler = new ProtocolHandler();
      const result = expect(handler.getEncryptedUploadV2Capabilities('device-1'))
        .rejects.toMatchObject({ code: 'encrypted_upload_v2_capability_unavailable' });
      await jest.advanceTimersByTimeAsync(10000); await result;
      finish(false); await jest.advanceTimersByTimeAsync(0);
      expect(ble.readCharacteristic).not.toHaveBeenCalled();
      await expect(handler.getEncryptedUploadV2Capabilities('device-1')).resolves.toBeDefined();
    } finally { jest.useRealTimers(); }
  });

  it('does not retry malformed zero-filled capability data', async () => {
    const ble = mockGetBleManager(); ble.readCharacteristic.mockResolvedValue(Buffer.alloc(24));
    await expect(new ProtocolHandler().getEncryptedUploadV2Capabilities('device-1')).rejects.toBeDefined();
    expect(ble.readCharacteristic).toHaveBeenCalledTimes(1);
  });

  it('does not let a late old-link read release the replacement read fence', async () => {
    const ble = mockGetBleManager();
    let finishOld!: (value: Buffer) => void; let finishNew!: (value: Buffer) => void;
    ble.readCharacteristic
      .mockReturnValueOnce(new Promise<Buffer>(resolve => { finishOld = resolve; }))
      .mockReturnValueOnce(new Promise<Buffer>(resolve => { finishNew = resolve; }));
    const handler = new ProtocolHandler();
    const old = expect(handler.getEncryptedUploadV2Capabilities('device-1')).rejects.toBeDefined();
    await new Promise<void>(resolve => setImmediate(resolve));
    for (const [event, listener] of ble.on.mock.calls)
      if (event === 'deviceConnected') listener('device-1');
    await old;
    const replacement = handler.getEncryptedUploadV2Capabilities('device-1');
    await new Promise<void>(resolve => setImmediate(resolve));
    finishOld(capability()); await new Promise<void>(resolve => setImmediate(resolve));
    await expect(handler.getEncryptedUploadV2Capabilities('device-1'))
      .rejects.toMatchObject({ code: 'encrypted_upload_v2_operation_in_progress' });
    finishNew(capability()); await expect(replacement).resolves.toBeDefined();
    expect(ble.readCharacteristic).toHaveBeenCalledTimes(2);
  });

  it.each(['abort', 'disconnect', 'reconnect'])('stops pending capability work on %s without old-link retries', async (reason) => {
    const ble = mockGetBleManager(); let finish!: (value: Buffer) => void;
    ble.readCharacteristic.mockReturnValueOnce(new Promise<Buffer>(resolve => { finish = resolve; }));
    const handler = new ProtocolHandler(); const controller = new AbortController();
    const result = expect(handler.getEncryptedUploadV2Capabilities('device-1', controller.signal)).rejects.toBeDefined();
    await new Promise<void>(resolve => setImmediate(resolve));
    if (reason === 'abort') controller.abort();
    else for (const [event, listener] of ble.on.mock.calls) {
      if (event === (reason === 'disconnect' ? 'deviceDisconnected' : 'deviceConnected')) listener('device-1');
    }
    await result;
    const pending = capability(); pending.writeUInt32LE(0, 4);
    finish(pending); await new Promise<void>(resolve => setImmediate(resolve));
    expect(ble.readCharacteristic).toHaveBeenCalledTimes(1);
    await expect(handler.getEncryptedUploadV2Capabilities('device-1')).resolves.toBeDefined();
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

  it('reports a LIST rejection on 0409 immediately and permits a later list', async () => {
    jest.useFakeTimers();
    const messages: string[] = [];
    logger.setHandler(entry => { messages.push(entry.message); });
    try {
      const ble = mockGetBleManager();
      // ERROR, session 7, BUSY (0x000e), failed LIST (0x25).
      const busy = Buffer.from('4f02000007000000000000000e00250000000000', 'hex');
      let first = true;
      ble.writeCharacteristic.mockImplementation(async () => {
        if (first) {
          first = false;
          subscriptions.get(CHAR_RECORDING_TRANSFER_V2)?.(busy);
        } else {
          subscriptions.get(CHAR_RECORDING_LIST_V2)?.(encodeEncryptedUploadV2Transfer({
            type: 'recordingListEnd', common: common(0x49),
            count: 0, listRevision: 2, listSha256: digest(Buffer.alloc(0)),
          }));
        }
      });
      const handler = new ProtocolHandler();
      let failure: unknown;
      const rejected = handler.listEncryptedUploadV2Recordings('device-1', 7n)
        .catch(error => { failure = error; });
      await jest.advanceTimersByTimeAsync(0);
      expect(failure).toMatchObject({
        code: 'encrypted_upload_v2_device_error', protocolStatus: 0x0e,
      });
      // Metro may show only the message and stack, not structured context.
      expect(messages.some(message => message.includes('status=0x000e'))).toBe(true);
      await rejected;
      await expect(handler.listEncryptedUploadV2Recordings('device-1', 7n)).resolves.toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    } finally { logger.setHandler(null); jest.useRealTimers(); }
  });

  it('ignores drained errors from an older LIST session', async () => {
    const ble = mockGetBleManager();
    ble.writeCharacteristic.mockImplementation(async () => {
      subscriptions.get(CHAR_RECORDING_TRANSFER_V2)?.(
        Buffer.from('4f02000006000000000000000e00250000000000', 'hex')
      );
      subscriptions.get(CHAR_RECORDING_LIST_V2)?.(encodeEncryptedUploadV2Transfer({
        type: 'recordingListEnd', common: common(0x49),
        count: 0, listRevision: 2, listSha256: digest(Buffer.alloc(0)),
      }));
    });
    await expect(new ProtocolHandler().listEncryptedUploadV2Recordings('device-1', 7n))
      .resolves.toEqual([]);
  });

  it.each(['success', 'error', 'timeout'])('releases both LIST monitors exactly once on %s', async (outcome) => {
    jest.useFakeTimers();
    try {
      const ble = mockGetBleManager();
      const removals: string[] = [];
      ble.subscribeToCharacteristic.mockImplementation((_device, _service, characteristic, onData, onError) => {
        subscriptions.set(characteristic, onData);
        return { remove: () => {
          removals.push(characteristic);
          subscriptions.delete(characteristic);
          // Native cancellation can synchronously call the error callback.
          onError?.(new Error('Operation was cancelled'));
        } };
      });
      const pending = new ProtocolHandler().listEncryptedUploadV2Recordings('device-1', 7n);
      const observed = pending.then(value => ({ value }), error => ({ error }));
      if (outcome === 'success') {
        subscriptions.get(CHAR_RECORDING_LIST_V2)?.(encodeEncryptedUploadV2Transfer({
          type: 'recordingListEnd', common: common(0x49),
          count: 0, listRevision: 2, listSha256: digest(Buffer.alloc(0)),
        }));
      } else if (outcome === 'error') {
        subscriptions.get(CHAR_RECORDING_TRANSFER_V2)?.(
          Buffer.from('4f02000007000000000000000e00250000000000', 'hex')
        );
      }
      await jest.advanceTimersByTimeAsync(10000);
      const result = await observed;
      if (outcome === 'success') expect(result).toEqual({ value: [] });
      else expect(result).toMatchObject({ error: {
        code: outcome === 'error' ? 'encrypted_upload_v2_device_error' : 'ENCRYPTED_UPLOAD_V2_LIST_TIMEOUT',
      } });
      expect(removals.sort()).toEqual([CHAR_RECORDING_LIST_V2, CHAR_RECORDING_TRANSFER_V2].sort());
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
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

  it('runs the context exchange through 040C and signed-blob kinds3/4 without touching Grant nonce', async () => {
    const ble = mockGetBleManager(); let attemptId = 0; let state = 1;
    const nonce = Buffer.alloc(16, 7); const proof = Buffer.alloc(147, 8);
    const challenge = document('BOTACTXQ', 196, 9); challenge.writeUInt16LE(1, 8);
    const result = document('BOTACTXR', 264, 10); result.writeUInt16LE(1, 8);
    ble.readCharacteristic.mockImplementation(async (_device, _service, characteristic) => {
      expect(characteristic).toBe(CHAR_UPLOAD_CONTEXT_V2);
      const payload = state === 1 ? nonce : state === 2 ? proof : Buffer.alloc(0);
      const bytes = Buffer.alloc(12 + payload.length); bytes[0] = 0x66; bytes[1] = 2; bytes[2] = state;
      bytes.writeUInt32LE(attemptId, 4); bytes.writeUInt16LE(payload.length, 10); payload.copy(bytes, 12); return bytes;
    });
    ble.writeCharacteristic.mockImplementation(async (_device, _service, characteristic, bytes) => {
      writes.push({ characteristic, data: bytes });
      if (characteristic === CHAR_UPLOAD_CONTEXT_V2) { attemptId = bytes.readUInt32LE(4); return; }
      expect(characteristic).toBe(CHAR_TRANSFER_SIGNED_BLOB_V2);
      const packet = decodeEncryptedUploadV2SignedBlob(bytes);
      if (packet.type === 'blobCommit') {
        state = packet.kind === 3 ? 2 : 3;
        subscriptions.get(characteristic)?.(encodeEncryptedUploadV2SignedBlob({ type: 'blobResult', kind: packet.kind, writeId: packet.writeId, result: 0 }));
      }
    });
    const provider = jest.fn(async (bytes) => {
      expect(bytes).toEqual(nonce);
      return { challenge, exchangeProof: async (value: Buffer) => { expect(value).toEqual(proof); return result; } };
    });
    await new ProtocolHandler().refreshEncryptedUploadV2Context('device-1', provider, 1024);
    expect(attemptId).not.toBe(0);
    expect(writes.filter((write) => write.characteristic === CHAR_UPLOAD_CONTEXT_V2)).toHaveLength(1);
    expect(writes.filter((write) => write.data[0] === 0x62).map((write) => write.data[2])).toEqual([3, 4]);
    expect(ble.readCharacteristic).toHaveBeenCalledTimes(3);
  });

  it('rejects a replacement context exchange until a cancelled BEGIN write drains', async () => {
    const ble = mockGetBleManager();
    const controller = new AbortController();
    let releaseBegin!: () => void;
    let markBeginPending!: () => void;
    const beginGate = new Promise<void>((resolve) => { releaseBegin = resolve; });
    const beginPending = new Promise<void>((resolve) => { markBeginPending = resolve; });
    let delayFirstBegin = true;
    let attemptId = 0;
    let state = 1;
    const nonce = Buffer.alloc(16, 7);
    const proof = Buffer.alloc(147, 8);
    const challenge = document('BOTACTXQ', 196, 9); challenge.writeUInt16LE(1, 8);
    const result = document('BOTACTXR', 264, 10); result.writeUInt16LE(1, 8);
    ble.readCharacteristic.mockImplementation(async () => {
      const payload = state === 1 ? nonce : state === 2 ? proof : Buffer.alloc(0);
      const bytes = Buffer.alloc(12 + payload.length);
      bytes[0] = 0x66; bytes[1] = 2; bytes[2] = state;
      bytes.writeUInt32LE(attemptId, 4); bytes.writeUInt16LE(payload.length, 10);
      payload.copy(bytes, 12);
      return bytes;
    });
    ble.writeCharacteristic.mockImplementation(async (
      _device: string, _service: string, characteristic: string, bytes: Buffer
    ) => {
      writes.push({ characteristic, data: bytes });
      if (characteristic === CHAR_UPLOAD_CONTEXT_V2) {
        attemptId = bytes.readUInt32LE(4);
        if (delayFirstBegin) {
          delayFirstBegin = false;
          markBeginPending();
          await beginGate;
        }
        return;
      }
      const packet = decodeEncryptedUploadV2SignedBlob(bytes);
      if (packet.type === 'blobCommit') {
        state = packet.kind === 3 ? 2 : 3;
        subscriptions.get(characteristic)?.(encodeEncryptedUploadV2SignedBlob({
          type: 'blobResult', kind: packet.kind, writeId: packet.writeId, result: 0,
        }));
      }
    });
    const provider = async () => ({
      challenge,
      exchangeProof: async () => result,
    });
    const handler = new ProtocolHandler();
    const first = handler.refreshEncryptedUploadV2Context(
      'device-1', provider, 1024, controller.signal
    );
    await beginPending;
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'encrypted_upload_v2_cancelled' });

    await expect(handler.refreshEncryptedUploadV2Context(
      'device-1', provider, 1024
    )).rejects.toMatchObject({ code: 'encrypted_upload_v2_operation_in_progress' });

    releaseBegin();
    await beginGate;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    state = 1;
    await expect(handler.refreshEncryptedUploadV2Context(
      'device-1', provider, 1024
    )).resolves.toBeUndefined();
    expect(writes.filter((write) => write.characteristic === CHAR_UPLOAD_CONTEXT_V2)).toHaveLength(2);
  });

  it('removes a cancelled signed-document listener and fences retry until ABORT drains', async () => {
    const ble = mockGetBleManager();
    const controller = new AbortController();
    let signedBlobListener: ((data: Buffer) => void) | undefined;
    let releaseAbort!: () => void;
    let markCommitWritten!: () => void;
    let markAbortPending!: () => void;
    const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const commitWritten = new Promise<void>((resolve) => { markCommitWritten = resolve; });
    const abortPending = new Promise<void>((resolve) => { markAbortPending = resolve; });
    let attemptId = 0;
    const nonce = Buffer.alloc(16, 7);
    const proof = Buffer.alloc(147, 8);
    const challenge = document('BOTACTXQ', 196, 9); challenge.writeUInt16LE(1, 8);
    const result = document('BOTACTXR', 264, 10); result.writeUInt16LE(1, 8);
    ble.subscribeToCharacteristic.mockImplementation((
      _device: string, _service: string, characteristic: string,
      onData: (data: Buffer) => void
    ) => {
      subscriptions.set(characteristic, onData);
      if (characteristic === CHAR_TRANSFER_SIGNED_BLOB_V2) signedBlobListener = onData;
      return { remove: jest.fn(() => {
        if (signedBlobListener === onData) signedBlobListener = undefined;
      }) };
    });
    ble.readCharacteristic.mockImplementation(async () => {
      const bytes = Buffer.alloc(28);
      bytes[0] = 0x66; bytes[1] = 2; bytes[2] = 1;
      bytes.writeUInt32LE(attemptId, 4); bytes.writeUInt16LE(16, 10);
      nonce.copy(bytes, 12);
      return bytes;
    });
    ble.writeCharacteristic.mockImplementation(async (
      _device: string, _service: string, characteristic: string, bytes: Buffer
    ) => {
      writes.push({ characteristic, data: bytes });
      if (characteristic === CHAR_UPLOAD_CONTEXT_V2) {
        attemptId = bytes.readUInt32LE(4);
        return;
      }
      const packet = decodeEncryptedUploadV2SignedBlob(bytes);
      if (packet.type === 'blobCommit') markCommitWritten();
      if (packet.type === 'blobAbort') {
        markAbortPending();
        await abortGate;
      }
    });
    const handler = new ProtocolHandler();
    const first = handler.refreshEncryptedUploadV2Context(
      'device-1', async () => ({ challenge, exchangeProof: async () => result }),
      1024, controller.signal
    );
    await commitWritten;
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'encrypted_upload_v2_cancelled' });
    await abortPending;
    expect(signedBlobListener).toBeUndefined();

    await expect(handler.refreshEncryptedUploadV2Context(
      'device-1', async () => ({ challenge, exchangeProof: async () => result }), 1024
    )).rejects.toMatchObject({ code: 'encrypted_upload_v2_operation_in_progress' });
    releaseAbort();
  });

  it('allows retry after the context deadline expires during provider-only work', async () => {
    jest.useFakeTimers();
    try {
      const ble = mockGetBleManager();
      let attemptId = 0;
      let state = 1;
      let providerCalls = 0;
      let markProviderPending!: () => void;
      const providerPending = new Promise<void>((resolve) => { markProviderPending = resolve; });
      const nonce = Buffer.alloc(16, 7);
      const proof = Buffer.alloc(147, 8);
      const challenge = document('BOTACTXQ', 196, 9); challenge.writeUInt16LE(1, 8);
      const result = document('BOTACTXR', 264, 10); result.writeUInt16LE(1, 8);
      ble.readCharacteristic.mockImplementation(async () => {
        const payload = state === 1 ? nonce : state === 2 ? proof : Buffer.alloc(0);
        const bytes = Buffer.alloc(12 + payload.length);
        bytes[0] = 0x66; bytes[1] = 2; bytes[2] = state;
        bytes.writeUInt32LE(attemptId, 4); bytes.writeUInt16LE(payload.length, 10);
        payload.copy(bytes, 12);
        return bytes;
      });
      ble.writeCharacteristic.mockImplementation(async (
        _device: string, _service: string, characteristic: string, bytes: Buffer
      ) => {
        writes.push({ characteristic, data: bytes });
        if (characteristic === CHAR_UPLOAD_CONTEXT_V2) {
          attemptId = bytes.readUInt32LE(4);
          return;
        }
        const packet = decodeEncryptedUploadV2SignedBlob(bytes);
        if (packet.type === 'blobCommit') {
          state = packet.kind === 3 ? 2 : 3;
          subscriptions.get(characteristic)?.(encodeEncryptedUploadV2SignedBlob({
            type: 'blobResult', kind: packet.kind, writeId: packet.writeId, result: 0,
          }));
        }
      });
      const provider = async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          markProviderPending();
          return await new Promise<never>(() => undefined);
        }
        return { challenge, exchangeProof: async () => result };
      };
      const handler = new ProtocolHandler();
      const first = handler.refreshEncryptedUploadV2Context('device-1', provider, 1024);
      await providerPending;
      jest.advanceTimersByTime(30_000);
      await expect(first).rejects.toMatchObject({ code: 'encrypted_upload_v2_context_timeout' });

      state = 1;
      await expect(handler.refreshEncryptedUploadV2Context(
        'device-1', provider, 1024
      )).resolves.toBeUndefined();
      expect(providerCalls).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears an uncertain context fence only after a verified new connection event', async () => {
    const ble = mockGetBleManager();
    const controller = new AbortController();
    let onConnected: ((deviceId: string) => void) | undefined;
    let releaseBegin!: () => void;
    let markBeginPending!: () => void;
    const beginGate = new Promise<void>((resolve) => { releaseBegin = resolve; });
    const beginPending = new Promise<void>((resolve) => { markBeginPending = resolve; });
    let beginCount = 0;
    ble.on.mockImplementation((event: string, listener: (deviceId: string) => void) => {
      if (event === 'deviceConnected') onConnected = listener;
    });
    ble.writeCharacteristic.mockImplementation(async (
      _device: string, _service: string, characteristic: string
    ) => {
      if (characteristic !== CHAR_UPLOAD_CONTEXT_V2) return;
      beginCount += 1;
      if (beginCount === 1) {
        markBeginPending();
        await beginGate;
        return;
      }
      throw new Error('fresh connection reached');
    });
    const handler = new ProtocolHandler();
    const provider = async () => await new Promise<never>(() => undefined);
    const first = handler.refreshEncryptedUploadV2Context(
      'device-1', provider, 1024, controller.signal
    );
    await beginPending;
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'encrypted_upload_v2_cancelled' });
    await expect(handler.refreshEncryptedUploadV2Context(
      'device-1', provider, 1024
    )).rejects.toMatchObject({ code: 'encrypted_upload_v2_operation_in_progress' });

    expect(onConnected).toBeDefined();
    onConnected?.('device-1');
    await expect(handler.refreshEncryptedUploadV2Context(
      'device-1', provider, 1024
    )).rejects.toThrow('fresh connection reached');
    expect(beginCount).toBe(2);
    releaseBegin();
  });

  it('does not send a stale document ABORT over a replacement connection', async () => {
    const ble = mockGetBleManager();
    const controller = new AbortController();
    let onConnected: ((deviceId: string) => void) | undefined;
    let releaseOldData!: () => void;
    let markOldDataPending!: () => void;
    const oldDataGate = new Promise<void>((resolve) => { releaseOldData = resolve; });
    const oldDataPending = new Promise<void>((resolve) => { markOldDataPending = resolve; });
    let attemptId = 0;
    let state = 1;
    let oldWriteId: number | undefined;
    const nonce = Buffer.alloc(16, 7);
    const proof = Buffer.alloc(147, 8);
    const challenge = document('BOTACTXQ', 196, 9); challenge.writeUInt16LE(1, 8);
    const result = document('BOTACTXR', 264, 10); result.writeUInt16LE(1, 8);
    ble.on.mockImplementation((event: string, listener: (deviceId: string) => void) => {
      if (event === 'deviceConnected') onConnected = listener;
    });
    ble.readCharacteristic.mockImplementation(async () => {
      const payload = state === 1 ? nonce : state === 2 ? proof : Buffer.alloc(0);
      const bytes = Buffer.alloc(12 + payload.length);
      bytes[0] = 0x66; bytes[1] = 2; bytes[2] = state;
      bytes.writeUInt32LE(attemptId, 4); bytes.writeUInt16LE(payload.length, 10);
      payload.copy(bytes, 12);
      return bytes;
    });
    ble.writeCharacteristic.mockImplementation(async (
      _device: string, _service: string, characteristic: string, bytes: Buffer
    ) => {
      writes.push({ characteristic, data: bytes });
      if (characteristic === CHAR_UPLOAD_CONTEXT_V2) {
        attemptId = bytes.readUInt32LE(4);
        state = 1;
        return;
      }
      const packet = decodeEncryptedUploadV2SignedBlob(bytes);
      if (packet.type === 'blobBegin' && oldWriteId === undefined) oldWriteId = packet.writeId;
      if (packet.type === 'blobData' && packet.writeId === oldWriteId) {
        markOldDataPending();
        await oldDataGate;
        return;
      }
      if (packet.type === 'blobCommit') {
        state = packet.kind === 3 ? 2 : 3;
        subscriptions.get(characteristic)?.(encodeEncryptedUploadV2SignedBlob({
          type: 'blobResult', kind: packet.kind, writeId: packet.writeId, result: 0,
        }));
      }
    });
    const provider = async () => ({ challenge, exchangeProof: async () => result });
    const handler = new ProtocolHandler();
    const first = handler.refreshEncryptedUploadV2Context(
      'device-1', provider, 1024, controller.signal
    );
    await oldDataPending;
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'encrypted_upload_v2_cancelled' });

    expect(onConnected).toBeDefined();
    onConnected?.('device-1');
    await expect(handler.refreshEncryptedUploadV2Context(
      'device-1', provider, 1024
    )).resolves.toBeUndefined();

    releaseOldData();
    await oldDataGate;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const staleAborts = writes.filter((write) => {
      if (write.characteristic !== CHAR_TRANSFER_SIGNED_BLOB_V2) return false;
      const packet = decodeEncryptedUploadV2SignedBlob(write.data);
      return packet.type === 'blobAbort' && packet.writeId === oldWriteId;
    });
    expect(staleAborts).toHaveLength(0);
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
    expect(subscriptions.has(CHAR_RECORDING_TRANSFER_V2)).toBe(true);
  });

  it('surfaces CONFIRM errors from 0409 and settles before cancelling both monitors', async () => {
    jest.useFakeTimers();
    try {
      const ble = mockGetBleManager();
      const removed: string[] = [];
      ble.subscribeToCharacteristic.mockImplementation((
        _device: string, _service: string, characteristic: string,
        onData: (data: Buffer) => void, onError: (error: Error) => void
      ) => {
        subscriptions.set(characteristic, onData);
        return { remove: () => { removed.push(characteristic); onError(new Error('cancelled')); } };
      });
      ble.writeCharacteristic.mockImplementation(async (
        _device: string, _service: string, characteristic: string
      ) => {
        if (characteristic !== CHAR_TRANSFER_CONTROL_V2) return;
        const notify = subscriptions.get(CHAR_RECORDING_TRANSFER_V2);
        // Drained errors from an earlier transport must not settle this CONFIRM.
        notify?.(encodeEncryptedUploadV2Transfer({
          type: 'error', common: { ...common(0x4f), transportSessionId: 6n },
          result: 0x0e, failedMessageType: 0x23, checkpointRevision: 0,
        }));
        notify?.(encodeEncryptedUploadV2Transfer({
          type: 'error', common: common(0x4f), result: 0xff,
          failedMessageType: 0x23, checkpointRevision: 1,
        }));
      });
      const handler = new ProtocolHandler();
      jest.spyOn(handler, 'sendEncryptedUploadV2Document').mockResolvedValue(undefined);
      const pending = handler.confirmEncryptedUploadV2('device-1', {
        transportSessionId: 7n, uploadSessionUuid: sessionUuid,
        recordingUuid: uuid, recordingGeneration: 3, ownerRevision: 4,
        receipt: document('BOTARCPT', 336, 0x24), maximumSignedBlobBytes: 1024, writeId: 14,
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'encrypted_upload_v2_confirmation_uncertain', protocolStatus: 0xff,
        underlyingError: { code: 'encrypted_upload_v2_device_error', protocolStatus: 0xff },
      });
      await jest.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(removed.sort()).toEqual([CHAR_TRANSFER_STATUS_V2, CHAR_RECORDING_TRANSFER_V2].sort());
    } finally { jest.useRealTimers(); }
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
