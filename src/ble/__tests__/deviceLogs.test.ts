import { Buffer } from 'buffer';

import { DeviceLogDecoder } from '../deviceLogs';
import { DEVICE_LOG_FLAG_BACKLOG, DEVICE_LOG_FLAG_DROPPED } from '../constants';

function packet(sequence: number, flags: number, text: Buffer | string): Buffer {
  const payload = typeof text === 'string' ? Buffer.from(text) : text;
  const header = Buffer.alloc(3);
  header.writeUInt16LE(sequence, 0);
  header[2] = flags;
  return Buffer.concat([header, payload]);
}

describe('DeviceLogDecoder', () => {
  it('emits a complete line as a debug event', () => {
    const decoder = new DeviceLogDecoder();

    expect(decoder.push(packet(0, 0, 'boot pass\n'))).toEqual([
      { level: 'debug', message: 'boot pass', isBacklog: false },
    ]);
  });

  it('emits multiple lines from one packet and marks backlog events', () => {
    const decoder = new DeviceLogDecoder();

    expect(decoder.push(packet(0, DEVICE_LOG_FLAG_BACKLOG, 'one\ntwo\n'))).toEqual([
      { level: 'debug', message: 'one', isBacklog: true },
      { level: 'debug', message: 'two', isBacklog: true },
    ]);
  });

  it('normalizes CRLF line endings', () => {
    const decoder = new DeviceLogDecoder();

    expect(decoder.push(packet(0, 0, 'one\r\ntwo\n'))).toEqual([
      { level: 'debug', message: 'one', isBacklog: false },
      { level: 'debug', message: 'two', isBacklog: false },
    ]);
  });

  it('retains a line split across packets until the newline arrives', () => {
    const decoder = new DeviceLogDecoder();

    expect(decoder.push(packet(0, 0, 'boot pa'))).toEqual([]);
    expect(decoder.push(packet(1, 0, 'ss\n'))).toEqual([
      { level: 'debug', message: 'boot pass', isBacklog: false },
    ]);
  });

  it('preserves a multibyte UTF-8 character split across packets', () => {
    const decoder = new DeviceLogDecoder();
    const line = Buffer.from('battery 电量\n', 'utf8');
    const split = line.indexOf(0xe7) + 1;

    expect(decoder.push(packet(0, 0, line.subarray(0, split)))).toEqual([]);
    expect(decoder.push(packet(1, 0, line.subarray(split)))).toEqual([
      { level: 'debug', message: 'battery 电量', isBacklog: false },
    ]);
  });

  it('accepts sequence wrap from 0xffff to 0x0000', () => {
    const decoder = new DeviceLogDecoder();

    expect(decoder.push(packet(0xffff, 0, 'last\n'))).toEqual([
      { level: 'debug', message: 'last', isBacklog: false },
    ]);
    expect(decoder.push(packet(0x0000, 0, 'next\n'))).toEqual([
      { level: 'debug', message: 'next', isBacklog: false },
    ]);
  });

  it('warns on a sequence gap, clears the partial line, and decodes the current packet', () => {
    const decoder = new DeviceLogDecoder();

    expect(decoder.push(packet(10, 0, 'partial'))).toEqual([]);
    expect(decoder.push(packet(12, 0, 'recovered\n'))).toEqual([
      expect.objectContaining({ level: 'warn', isBacklog: false }),
      { level: 'debug', message: 'recovered', isBacklog: false },
    ]);
    expect(decoder.push(packet(13, 0, 'after\n'))).toEqual([
      { level: 'debug', message: 'after', isBacklog: false },
    ]);
  });

  it('warns when firmware reports dropped bytes and clears the partial line', () => {
    const decoder = new DeviceLogDecoder();

    expect(decoder.push(packet(0, 0, 'partial'))).toEqual([]);
    expect(decoder.push(packet(1, DEVICE_LOG_FLAG_DROPPED, 'recovered\n'))).toEqual([
      expect.objectContaining({ level: 'warn', isBacklog: false }),
      { level: 'debug', message: 'recovered', isBacklog: false },
    ]);
  });

  it('ignores malformed packets without changing sequence state', () => {
    const decoder = new DeviceLogDecoder();

    expect(() => decoder.push(Buffer.alloc(0))).not.toThrow();
    expect(() => decoder.push(Buffer.from([0x00, 0x01]))).not.toThrow();
    expect(decoder.push(packet(4, 0, 'first\n'))).toEqual([
      { level: 'debug', message: 'first', isBacklog: false },
    ]);
    expect(decoder.push(packet(5, 0, 'second\n'))).toEqual([
      { level: 'debug', message: 'second', isBacklog: false },
    ]);
  });

  it('resets buffered text and sequence tracking', () => {
    const decoder = new DeviceLogDecoder();

    expect(decoder.push(packet(9, 0, 'partial'))).toEqual([]);
    decoder.reset();

    expect(decoder.push(packet(2, 0, 'fresh\n'))).toEqual([
      { level: 'debug', message: 'fresh', isBacklog: false },
    ]);
  });
});
