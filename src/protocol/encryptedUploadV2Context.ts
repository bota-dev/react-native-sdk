import { Buffer } from 'buffer';
import { EncryptedUploadV2RuntimeError } from './encryptedUploadV2Runtime';

/** The host owns HTTP authentication and polling. All supplied bytes remain
 * opaque: the device, not this provider or SDK, verifies trust and time. */
export type EncryptedUploadV2ContextProvider = (
  nonce: Buffer, signal?: AbortSignal
) => Promise<{
  challenge: Buffer;
  exchangeProof: (proof: Buffer, signal?: AbortSignal) => Promise<Buffer>;
}>;

interface ContextIO {
  begin(bytes: Buffer, signal: AbortSignal): Promise<void>;
  read(signal: AbortSignal): Promise<Buffer>;
  sendDocument(kind: 3 | 4, bytes: Buffer, signal: AbortSignal): Promise<void>;
}

function invalid(): never {
  throw new EncryptedUploadV2RuntimeError('encrypted_upload_v2_unexpected_message');
}

export function encodeUploadContextBegin(attemptId: number): Buffer {
  if (!Number.isInteger(attemptId) || attemptId <= 0 || attemptId > 0xffffffff) invalid();
  const bytes = Buffer.alloc(8);
  bytes[0] = 0x65; bytes[1] = 2; bytes.writeUInt32LE(attemptId, 4);
  return bytes;
}

export function decodeUploadContextSnapshot(value: Uint8Array) {
  const bytes = Buffer.from(value);
  if (bytes.length < 12 || bytes[0] !== 0x66 || bytes[1] !== 2 || bytes[3] !== 0) invalid();
  const state = bytes[2]; const attemptId = bytes.readUInt32LE(4);
  const result = bytes.readUInt16LE(8); const length = bytes.readUInt16LE(10);
  if (attemptId === 0 || state > 4 || bytes.length !== 12 + length ||
      (state === 4 ? result === 0 : result !== 0) ||
      (state === 1 ? length !== 16 : state === 2 ? length < 116 || length > 366 : length !== 0)) invalid();
  const payload = Buffer.from(bytes.subarray(12));
  if (state === 1 && !payload.some((byte) => byte !== 0)) invalid();
  return { state, attemptId, result, payload };
}

/** Shape validation only; never signature verification or trusted claims. */
export function decodeUploadContextDocument(kind: 3 | 4, value: Uint8Array): Buffer {
  const bytes = Buffer.from(value); const length = kind === 3 ? 196 : 264;
  if (bytes.length !== length ||
      !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from(kind === 3 ? 'BOTACTXQ' : 'BOTACTXR')) ||
      bytes.readUInt16LE(8) !== 1 || bytes.readUInt16LE(10) !== length) invalid();
  return bytes;
}

/** One bounded active attempt. Poll reads do not create or renew device
 * nonces; lost notifications are harmless because the snapshot is durable for
 * this volatile attempt. The firmware separately enforces its own deadline. */
export async function exchangeUploadContext(
  io: ContextIO, provider: EncryptedUploadV2ContextProvider,
  attemptId: number, signal?: AbortSignal
): Promise<void> {
  const begin = encodeUploadContextBegin(attemptId);
  const controller = new AbortController();
  let failure = new EncryptedUploadV2RuntimeError('encrypted_upload_v2_cancelled');
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const deadline = setTimeout(() => {
    failure = new EncryptedUploadV2RuntimeError('encrypted_upload_v2_context_timeout');
    controller.abort();
  }, 30_000);

  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    if (controller.signal.aborted) throw failure;
    let rejectAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(failure); });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    try {
      return await Promise.race([aborted, Promise.resolve().then(() => {
        if (controller.signal.aborted) throw failure;
        return operation();
      })]);
    } finally { controller.signal.removeEventListener('abort', rejectAbort); }
  }

  async function waitFor(state: 1 | 2 | 3): Promise<Buffer> {
    for (;;) {
      const snapshot = decodeUploadContextSnapshot(await bounded(() => io.read(controller.signal)));
      if (snapshot.attemptId === attemptId) {
        if (snapshot.state === 4) {
          throw new EncryptedUploadV2RuntimeError('encrypted_upload_v2_device_error', snapshot.result);
        }
        if (snapshot.state === state) return snapshot.payload;
        if (snapshot.state > state) invalid();
      }
      await bounded(() => new Promise<void>((resolve) => { pollTimer = setTimeout(resolve, 150); }));
    }
  }

  try {
    await bounded(() => io.begin(begin, controller.signal));
    const nonce = await waitFor(1);
    const exchange = await bounded(() => provider(nonce, controller.signal));
    const challenge = decodeUploadContextDocument(3, exchange.challenge);
    await bounded(() => io.sendDocument(3, challenge, controller.signal));
    const proof = await waitFor(2);
    const result = decodeUploadContextDocument(4,
      await bounded(() => exchange.exchangeProof(proof, controller.signal)));
    await bounded(() => io.sendDocument(4, result, controller.signal));
    await waitFor(3);
  } finally {
    clearTimeout(deadline);
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}
