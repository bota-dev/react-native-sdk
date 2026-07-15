import { Buffer } from 'buffer';
import { parseRecordingList } from '../src/ble/parsers';

describe('parseRecordingList', () => {
  it('keeps the recording ID independent from the encryption flag', () => {
    const entry = Buffer.alloc(24);
    entry.set([0xa1, 0xb2, 0xc3, 0xd4], 0);
    entry[4] = 0x01;

    const [recording] = parseRecordingList(entry);

    expect(recording?.uuid).toBe('a1b2c3d4-0000-0000-0000-000000000000');
    expect(recording?.isEncrypted).toBe(true);
  });
});
