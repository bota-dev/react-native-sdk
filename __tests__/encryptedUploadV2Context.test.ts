import { Buffer } from 'buffer';
import {
  decodeUploadContextSnapshot, encodeUploadContextBegin, exchangeUploadContext,
} from '../src/protocol/encryptedUploadV2Context';

function snapshot(state: number, payload = Buffer.alloc(0), attempt = 7, result = 0) {
  const bytes = Buffer.alloc(12 + payload.length);
  bytes[0] = 0x66; bytes[1] = 2; bytes[2] = state;
  bytes.writeUInt32LE(attempt, 4); bytes.writeUInt16LE(result, 8);
  bytes.writeUInt16LE(payload.length, 10); payload.copy(bytes, 12);
  return bytes;
}
function document(magic: string, length: number) {
  const bytes = Buffer.alloc(length, 9); bytes.write(magic);
  bytes.writeUInt16LE(1, 8); bytes.writeUInt16LE(length, 10); return bytes;
}
function fixture() {
  const events: string[] = [];
  const nonce = Buffer.alloc(16, 3); const proof = Buffer.alloc(147, 4);
  const challenge = document('BOTACTXQ', 196); const result = document('BOTACTXR', 264);
  const io = {
    begin: jest.fn(async (bytes: Buffer) => { events.push('begin'); expect(bytes).toEqual(Buffer.from('6502000007000000', 'hex')); }),
    read: jest.fn().mockResolvedValueOnce(snapshot(1, nonce)).mockResolvedValueOnce(snapshot(2, proof)).mockResolvedValueOnce(snapshot(3)),
    sendDocument: jest.fn(async (kind: number, bytes: Buffer) => { events.push(`document${kind}`); expect(bytes).toEqual(kind === 3 ? challenge : result); }),
  };
  const exchangeProof = jest.fn(async (bytes: Buffer) => { events.push('proof'); expect(bytes).toEqual(proof); return result; });
  const provider = jest.fn(async (bytes: Buffer, _signal?: AbortSignal) => { events.push('challenge'); expect(bytes).toEqual(nonce); return { challenge, exchangeProof }; });
  return { events, nonce, proof, challenge, result, io, provider, exchangeProof };
}

describe('opaque upload context exchange', () => {
  afterEach(() => jest.useRealTimers());

  it('encodes a nonzero correlation ID, not an app-generated security nonce', () => {
    expect(encodeUploadContextBegin(7)).toEqual(Buffer.from('6502000007000000', 'hex'));
    for (const id of [0, -1, 1.5, 0x100000000]) expect(() => encodeUploadContextBegin(id)).toThrow();
  });

  it.each([
    snapshot(1, Buffer.alloc(15)), snapshot(2, Buffer.alloc(115)), snapshot(2, Buffer.alloc(367)),
    snapshot(3, Buffer.alloc(1)), snapshot(4), snapshot(0, Buffer.alloc(0), 7, 1),
    snapshot(5), snapshot(1, Buffer.alloc(16), 0),
  ])('rejects malformed context state %#', (bytes) => {
    expect(() => decodeUploadContextSnapshot(bytes)).toThrow();
  });

  it('relays exact bytes and resolves only after device result acceptance', async () => {
    const f = fixture();
    await exchangeUploadContext(f.io, f.provider, 7);
    expect(f.events).toEqual(['begin', 'challenge', 'document3', 'proof', 'document4']);
    expect(f.io.read).toHaveBeenCalledTimes(3);
  });

  it('polls past stale attempts and earlier phases until each expected state arrives', async () => {
    const f = fixture();
    f.io.read.mockReset()
      .mockResolvedValueOnce(snapshot(3, Buffer.alloc(0), 6))
      .mockResolvedValueOnce(snapshot(0))
      .mockResolvedValueOnce(snapshot(1, f.nonce))
      .mockResolvedValueOnce(snapshot(1, f.nonce))
      .mockResolvedValueOnce(snapshot(2, f.proof))
      .mockResolvedValueOnce(snapshot(2, f.proof))
      .mockResolvedValueOnce(snapshot(3));

    await exchangeUploadContext(f.io, f.provider, 7);

    expect(f.events).toEqual(['begin', 'challenge', 'document3', 'proof', 'document4']);
    expect(f.io.read).toHaveBeenCalledTimes(7);
  });

  it('does not send a result after a device proof rejection or wrong attempt', async () => {
    const f = fixture(); f.io.read.mockReset().mockResolvedValueOnce(snapshot(1, f.nonce)).mockResolvedValueOnce(snapshot(4, Buffer.alloc(0), 7, 4));
    await expect(exchangeUploadContext(f.io, f.provider, 7)).rejects.toMatchObject({ code: 'encrypted_upload_v2_device_error', protocolStatus: 4 });
    expect(f.exchangeProof).not.toHaveBeenCalled();
    const controller = new AbortController();
    const g = fixture(); g.io.read.mockReset().mockResolvedValue(snapshot(1, g.nonce, 8));
    const pending = exchangeUploadContext(g.io, g.provider, 7, controller.signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'encrypted_upload_v2_cancelled' });
    expect(g.provider).not.toHaveBeenCalled();
  });

  it('rejects malformed provider documents before relaying them', async () => {
    const f = fixture(); f.challenge[0] |= 0x80;
    await expect(exchangeUploadContext(f.io, f.provider, 7)).rejects.toThrow();
    expect(f.io.sendDocument).not.toHaveBeenCalled();
    const g = fixture(); g.result.writeUInt16LE(2, 8);
    await expect(exchangeUploadContext(g.io, g.provider, 7)).rejects.toThrow();
    expect(g.io.sendDocument).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung provider by the original deadline and ignores a late result', async () => {
    jest.useFakeTimers();
    const f = fixture();
    let finish: (value: { challenge: Buffer; exchangeProof: typeof f.exchangeProof }) => void = () => undefined;
    f.provider.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const exchange = exchangeUploadContext(f.io, f.provider, 7);
    const rejected = expect(exchange).rejects.toMatchObject({ code: 'encrypted_upload_v2_context_timeout' });
    await jest.advanceTimersByTimeAsync(30_000); await rejected;
    finish({ challenge: f.challenge, exchangeProof: f.exchangeProof }); await Promise.resolve();
    expect(f.io.sendDocument).not.toHaveBeenCalled();
    expect(f.provider.mock.calls[0][1]?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('polling never resets the deadline and cancellation tears down pending work', async () => {
    jest.useFakeTimers();
    const f = fixture(); f.io.read.mockReset().mockResolvedValue(snapshot(0));
    const controller = new AbortController();
    const pending = exchangeUploadContext(f.io, f.provider, 7, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'encrypted_upload_v2_cancelled' });
    await jest.advanceTimersByTimeAsync(300); controller.abort(); await rejected;
    expect(f.provider).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });
});
