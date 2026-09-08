import { createHash } from 'node:crypto';
import { Buffer } from 'buffer';

jest.mock('react-native-quick-crypto', () => require('node:crypto'), { virtual: true });

import {
  EncryptedUploadV2TransferReceiver,
  type EncryptedUploadV2CiphertextSink,
  type EncryptedUploadV2Checkpoint,
} from '../src/protocol/encryptedUploadV2Runtime';
import {
  decodeEncryptedUploadV2Transfer,
  encodeEncryptedUploadV2Transfer,
} from '../src/protocol/encryptedUploadV2';

const digest = (value: Uint8Array): Buffer =>
  createHash('sha256').update(value).digest();

class TestSink implements EncryptedUploadV2CiphertextSink {
  private bytes = Buffer.alloc(0);

  async prepare(checkpoint: EncryptedUploadV2Checkpoint): Promise<void> {
    this.bytes = this.bytes.subarray(0, Number(checkpoint.nextCiphertextOffset));
  }

  async write(offset: bigint, bytes: Buffer): Promise<void> {
    const end = Number(offset) + bytes.length;
    if (end > this.bytes.length) {
      this.bytes = Buffer.concat([this.bytes, Buffer.alloc(end - this.bytes.length)]);
    }
    bytes.copy(this.bytes, Number(offset));
  }

  async byteLength(): Promise<bigint> {
    return BigInt(this.bytes.length);
  }

  async sha256Prefix(length: bigint): Promise<Buffer> {
    return digest(this.bytes.subarray(0, Number(length)));
  }
}

const common = (messageType: number) => ({
  messageType,
  flags: 0,
  transportSessionId: 7n,
});

const initialCheckpoint = (): EncryptedUploadV2Checkpoint => ({
  revision: 0,
  nextCiphertextOffset: 0n,
  prefixSha256: digest(Buffer.alloc(0)),
});

describe('EncryptedUploadV2TransferReceiver', () => {
  it.each([185, 247])('repairs short checkpoint tails across real-size windows at MTU %i', async (mtu) => {
    // Opaque fixture with the size/boundaries of header + two full AEAD blocks
    // + trailer. The SDK does not parse these bytes or require this structure.
    const ciphertext = Buffer.from(Array.from({ length: 8504 }, (_, i) => i % 251));
    const manifest = Buffer.alloc(580, 0xa5);
    const frameLimit = mtu - 3;
    const payloadLimit = Math.min(484, frameLimit - 28);
    const windowLimit = Math.min(44, Math.floor((frameLimit - 68) / 4));
    const persistCheckpoint = jest.fn(async (_checkpoint: EncryptedUploadV2Checkpoint) => {});
    const sink = new TestSink();
    const receiver = new EncryptedUploadV2TransferReceiver({
      transportSessionId: 7n,
      expectedCiphertextLength: BigInt(ciphertext.length),
      expectedCiphertextSha256: digest(ciphertext),
      maximumDataPayloadBytes: payloadLimit,
      maximumWindowPackets: windowLimit,
      maximumMissingSequences: windowLimit,
      checkpoint: initialCheckpoint(),
      sink,
      persistCheckpoint,
    });
    await receiver.prepare();
    let offset = 0;
    let sequence = 0;
    for (const [windowIndex, end] of [4244, 8504].entries()) {
      const firstSequence = sequence;
      const packets: Buffer[] = [];
      while (offset < end) {
        const next = Math.min(offset + payloadLimit, end);
        const frame = encodeEncryptedUploadV2Transfer({
          type: 'data', common: common(0x41), sequence,
          offset: BigInt(offset), data: ciphertext.subarray(offset, next),
        });
        expect(frame.length).toBeLessThanOrEqual(frameLimit);
        packets.push(frame);
        offset = next;
        sequence += 1;
      }
      expect(packets.length).toBeLessThanOrEqual(windowLimit);
      const tail = packets[packets.length - 1]!;
      expect(tail.length).toBeLessThan(28 + payloadLimit);
      const windowEnd = encodeEncryptedUploadV2Transfer({
        type: 'windowEnd', common: common(0x42), windowIndex,
        firstSequence, lastSequence: sequence - 1,
        nextCiphertextOffset: BigInt(end),
        prefixSha256: digest(ciphertext.subarray(0, end)),
        checkpointRevision: windowIndex + 1,
      });
      for (const packet of packets.slice(0, -1)) await receiver.receive(packet);
      const missing = await receiver.receive(windowEnd);
      expect(persistCheckpoint).toHaveBeenCalledTimes(windowIndex);
      if (missing.type !== 'control') throw new Error('expected repair ACK');
      expect(missing.frame.length).toBeLessThanOrEqual(frameLimit);
      expect(decodeEncryptedUploadV2Transfer(missing.frame)).toMatchObject({
        type: 'windowAck', checkpointRevision: windowIndex,
        missingSequences: [sequence - 1],
      });
      // A repaired short tail and its exact duplicate retain transmitted
      // offsets/lengths; neither is derived as sequence * negotiated payload.
      await receiver.receive(tail);
      await receiver.receive(tail);
      const accepted = await receiver.receive(windowEnd);
      expect(persistCheckpoint).toHaveBeenCalledTimes(windowIndex + 1);
      expect(persistCheckpoint).toHaveBeenLastCalledWith(expect.objectContaining({
        revision: windowIndex + 1, nextCiphertextOffset: BigInt(end),
        highestContiguousSequence: sequence - 1,
      }));
      if (accepted.type !== 'control') throw new Error('expected durable ACK');
      expect(decodeEncryptedUploadV2Transfer(accepted.frame)).toMatchObject({
        type: 'windowAck', checkpointRevision: windowIndex + 1,
        nextCiphertextOffset: BigInt(end), missingSequences: [],
      });
    }
    expect(await sink.sha256Prefix(8504n)).toEqual(digest(ciphertext));
    for (let chunkOffset = 0; chunkOffset < 580; chunkOffset += 100) {
      const frame = encodeEncryptedUploadV2Transfer({
        type: 'manifestChunk', common: common(0x43), totalManifestLength: 580,
        chunkOffset, manifestSha256: digest(manifest),
        chunk: manifest.subarray(chunkOffset, chunkOffset + 100),
      });
      expect(frame.length).toBeLessThanOrEqual(frameLimit);
      await receiver.receive(frame);
    }
    const completed = await receiver.receive(encodeEncryptedUploadV2Transfer({
      type: 'eof', common: common(0x44), finalSequence: sequence - 1,
      blockCount: 2, ciphertextLength: 8504n,
      ciphertextSha256: digest(ciphertext), manifestSha256: digest(manifest),
    }));
    expect(completed).toMatchObject({ type: 'complete', manifest });
  });

  it('persists a complete window before returning its ACK and completes exact evidence', async () => {
    const ciphertext = Buffer.from('opaque ciphertext');
    const manifest = Buffer.alloc(580, 0x5a);
    const operations: string[] = [];
    const sink = new TestSink();
    const receiver = new EncryptedUploadV2TransferReceiver({
      transportSessionId: 7n,
      expectedCiphertextLength: BigInt(ciphertext.length),
      expectedCiphertextSha256: digest(ciphertext),
      maximumDataPayloadBytes: 64,
      maximumWindowPackets: 4,
      maximumMissingSequences: 2,
      checkpoint: initialCheckpoint(),
      sink: {
        prepare: async (checkpoint) => sink.prepare(checkpoint),
        write: async (offset, bytes) => {
          operations.push('write');
          await sink.write(offset, bytes);
        },
        byteLength: () => sink.byteLength(),
        sha256Prefix: (length) => sink.sha256Prefix(length),
      },
      persistCheckpoint: async () => {
        operations.push('persist');
      },
    });
    await receiver.prepare();

    await receiver.receive(encodeEncryptedUploadV2Transfer({
      type: 'data',
      common: common(0x41),
      sequence: 0,
      offset: 0n,
      data: ciphertext,
    }));
    const window = await receiver.receive(encodeEncryptedUploadV2Transfer({
      type: 'windowEnd',
      common: common(0x42),
      windowIndex: 0,
      firstSequence: 0,
      lastSequence: 0,
      nextCiphertextOffset: BigInt(ciphertext.length),
      prefixSha256: digest(ciphertext),
      checkpointRevision: 1,
    }));

    expect(operations).toEqual(['write', 'persist']);
    expect(window.type).toBe('control');
    if (window.type !== 'control') throw new Error('expected control action');
    expect(decodeEncryptedUploadV2Transfer(window.frame)).toMatchObject({
      type: 'windowAck',
      checkpointRevision: 1,
      missingSequences: [],
    });

    for (let offset = 0; offset < manifest.length; offset += 200) {
      const chunk = manifest.subarray(offset, Math.min(offset + 200, manifest.length));
      await receiver.receive(encodeEncryptedUploadV2Transfer({
        type: 'manifestChunk',
        common: common(0x43),
        totalManifestLength: 580,
        chunkOffset: offset,
        manifestSha256: digest(manifest),
        chunk,
      }));
    }
    const completed = await receiver.receive(encodeEncryptedUploadV2Transfer({
      type: 'eof',
      common: common(0x44),
      finalSequence: 0,
      blockCount: 1,
      ciphertextLength: BigInt(ciphertext.length),
      ciphertextSha256: digest(ciphertext),
      manifestSha256: digest(manifest),
    }));

    expect(completed.type).toBe('complete');
    if (completed.type !== 'complete') throw new Error('expected completion');
    expect(completed.manifest).toEqual(manifest);
    expect(completed.evidence).toEqual({
      ciphertextLength: BigInt(ciphertext.length),
      ciphertextSha256: digest(ciphertext),
      manifestLength: 580,
      manifestSha256: digest(manifest),
      blockCount: 1,
    });
  });

  it('requests only missing packets without advancing the durable checkpoint', async () => {
    const sink = new TestSink();
    const persistCheckpoint = jest.fn();
    const receiver = new EncryptedUploadV2TransferReceiver({
      transportSessionId: 7n,
      expectedCiphertextLength: 4n,
      expectedCiphertextSha256: digest(Buffer.from('abcd')),
      maximumDataPayloadBytes: 2,
      maximumWindowPackets: 2,
      maximumMissingSequences: 2,
      checkpoint: initialCheckpoint(),
      sink,
      persistCheckpoint,
    });
    await receiver.prepare();
    await receiver.receive(encodeEncryptedUploadV2Transfer({
      type: 'data', common: common(0x41), sequence: 0, offset: 0n, data: Buffer.from('ab'),
    }));

    const action = await receiver.receive(encodeEncryptedUploadV2Transfer({
      type: 'windowEnd',
      common: common(0x42),
      windowIndex: 0,
      firstSequence: 0,
      lastSequence: 1,
      nextCiphertextOffset: 4n,
      prefixSha256: digest(Buffer.from('abcd')),
      checkpointRevision: 1,
    }));

    expect(persistCheckpoint).not.toHaveBeenCalled();
    expect(action.type).toBe('control');
    if (action.type !== 'control') throw new Error('expected control action');
    expect(decodeEncryptedUploadV2Transfer(action.frame)).toMatchObject({
      type: 'windowAck',
      checkpointRevision: 0,
      nextCiphertextOffset: 2n,
      missingSequences: [1],
    });
  });

  it('rejects a packet from another transport session before touching the sink', async () => {
    const sink = new TestSink();
    const write = jest.spyOn(sink, 'write');
    const receiver = new EncryptedUploadV2TransferReceiver({
      transportSessionId: 7n,
      expectedCiphertextLength: 1n,
      expectedCiphertextSha256: digest(Buffer.from('x')),
      maximumDataPayloadBytes: 1,
      maximumWindowPackets: 1,
      maximumMissingSequences: 1,
      checkpoint: initialCheckpoint(),
      sink,
      persistCheckpoint: jest.fn(),
    });
    await receiver.prepare();

    await expect(receiver.receive(encodeEncryptedUploadV2Transfer({
      type: 'data',
      common: { ...common(0x41), transportSessionId: 8n },
      sequence: 0,
      offset: 0n,
      data: Buffer.from('x'),
    }))).rejects.toMatchObject({ code: 'encrypted_upload_v2_session_mismatch' });
    expect(write).not.toHaveBeenCalled();
  });
});
