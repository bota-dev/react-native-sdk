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
