import { createHash } from 'node:crypto';
import { Buffer } from 'buffer';

jest.mock('react-native-quick-crypto', () => require('node:crypto'), { virtual: true });

import { EncryptedUploadV2FileSink, type EncryptedUploadV2File } from '../src/storage/EncryptedUploadV2FileSink';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest();
const checkpoint = (bytes = Buffer.alloc(0)) => ({
  revision: 0, nextCiphertextOffset: BigInt(bytes.length), prefixSha256: digest(bytes),
});

function fixture(initial = Buffer.alloc(0), maximumLength = 100_000n) {
  let bytes = Buffer.from(initial);
  const events: string[] = [];
  const file: EncryptedUploadV2File = {
    size: jest.fn(async () => bytes.length),
    truncate: jest.fn(async length => { events.push('truncate'); bytes = bytes.subarray(0, length); }),
    write: jest.fn(async (offset, value) => {
      events.push('write');
      if (offset + value.length > bytes.length) {
        bytes = Buffer.concat([bytes, Buffer.alloc(offset + value.length - bytes.length)]);
      }
      value.copy(bytes, offset);
    }),
    read: jest.fn(async (offset, length) => { events.push('read'); return bytes.subarray(offset, offset + length); }),
    flush: jest.fn(async () => { events.push('flush'); }),
  };
  return { sink: new EncryptedUploadV2FileSink(file, maximumLength), file, events, bytes: () => bytes };
}

describe('durable opaque v2 file sink', () => {
  it('flushes ciphertext before returning a checkpoint digest and hashes in bounded chunks', async () => {
    const { sink, file, events } = fixture();
    await sink.prepare(checkpoint());
    const bytes = Buffer.alloc(70_000, 0xab);
    await sink.write(0n, bytes.subarray(0, 35_000));
    await sink.write(35_000n, bytes.subarray(35_000));
    events.length = 0;
    expect(await sink.sha256Prefix(70_000n)).toEqual(digest(bytes));
    expect(events[0]).toBe('flush');
    expect(jest.mocked(file.read).mock.calls.every(([, length]) => length <= 64 * 1024)).toBe(true);
    expect(await sink.byteLength()).toBe(70_000n);
  });

  it('proves the saved prefix before truncating an unacknowledged tail', async () => {
    const { sink, events, bytes } = fixture(Buffer.from('provedTAIL'));
    await sink.prepare(checkpoint(Buffer.from('proved')));
    expect(events.indexOf('read')).toBeLessThan(events.indexOf('truncate'));
    expect(events.at(-1)).toBe('flush');
    expect(bytes().toString()).toBe('proved');
  });

  it('extends the incremental digest without re-reading earlier windows', async () => {
    const { sink, file } = fixture();
    await sink.prepare(checkpoint());
    await sink.write(0n, Buffer.from('abc'));
    expect(await sink.sha256Prefix(3n)).toEqual(digest(Buffer.from('abc')));
    jest.mocked(file.read).mockClear();
    await sink.write(3n, Buffer.from('def'));
    expect(await sink.sha256Prefix(6n)).toEqual(digest(Buffer.from('abcdef')));
    expect(file.read).toHaveBeenCalledTimes(1);
    expect(file.read).toHaveBeenCalledWith(3, 3);
    await sink.write(0n, Buffer.from('z'));
    expect(await sink.sha256Prefix(6n)).toEqual(digest(Buffer.from('zbcdef')));
  });

  it('retains bytes and rejects a mismatched or missing checkpoint', async () => {
    const { sink, file } = fixture(Buffer.from('wrong'));
    await expect(sink.prepare(checkpoint(Buffer.from('right')))).rejects.toThrow('checkpoint_mismatch');
    await expect(sink.prepare(checkpoint(Buffer.from('too long')))).rejects.toThrow('checkpoint_mismatch');
    expect(file.truncate).not.toHaveBeenCalled();
    await expect(sink.write(0n, Buffer.from('x'))).rejects.toThrow('not_prepared');
  });

  it('never acknowledges a failed flush or short read', async () => {
    const { sink, file } = fixture();
    await sink.prepare(checkpoint());
    await sink.write(0n, Buffer.from('abc'));
    jest.mocked(file.flush).mockRejectedValueOnce(new Error('disk sync failed'));
    await expect(sink.sha256Prefix(3n)).rejects.toThrow('disk sync failed');
    jest.mocked(file.read).mockResolvedValueOnce(Buffer.from('a'));
    await expect(sink.sha256Prefix(3n)).rejects.toThrow('integrity_mismatch');
  });

  it('rejects unsafe offsets, file growth beyond the authorized object, and cancellation', async () => {
    expect(() => fixture(Buffer.alloc(0), BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow();
    const { sink, file } = fixture(Buffer.alloc(0), 5n);
    await sink.prepare(checkpoint());
    await expect(sink.write(-1n, Buffer.from('a'))).rejects.toThrow();
    await expect(sink.write(5n, Buffer.from('a'))).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(sink.write(0n, Buffer.from('a'), controller.signal)).rejects.toThrow('cancelled');
    expect(file.write).not.toHaveBeenCalled();
  });
});
