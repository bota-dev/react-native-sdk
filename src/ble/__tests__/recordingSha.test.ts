import { Buffer } from 'buffer';

import { parseTransferPacket } from '../parsers';
import {
  isRecordingHashForTransfer,
  recordingIdsEqual,
} from '../../protocol/recordingIdentity';

describe('recording SHA-256 packet', () => {
  const hash = Buffer.alloc(32, 0xab);
  const recordingId = Buffer.from('3713b295000000000000000000000000', 'hex');

  it('keeps accepting the legacy hash-only packet', () => {
    const packet = parseTransferPacket(Buffer.concat([Buffer.from([0x04]), hash]));

    expect(packet.sha256).toEqual(hash);
    expect(packet.recordingId).toBeUndefined();
  });

  it('parses the recording ID appended by fixed firmware', () => {
    const packet = parseTransferPacket(
      Buffer.concat([Buffer.from([0x04]), hash, recordingId])
    );

    expect(packet.sha256).toEqual(hash);
    expect(packet.recordingId).toEqual(recordingId);
  });

  it('distinguishes a hash for another recording', () => {
    expect(
      recordingIdsEqual(recordingId, '3713b295-0000-0000-0000-000000000000')
    ).toBe(true);
    expect(
      recordingIdsEqual(recordingId, 'e1e68441-0000-0000-0000-000000000000')
    ).toBe(false);
    expect(
      isRecordingHashForTransfer(
        recordingId,
        'e1e68441-0000-0000-0000-000000000000'
      )
    ).toBe(false);
    expect(
      isRecordingHashForTransfer(
        undefined,
        '3713b295-0000-0000-0000-000000000000'
      )
    ).toBe(true);
  });
});
