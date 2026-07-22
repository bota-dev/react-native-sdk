import { Buffer } from 'buffer';

import {
  DEVICE_LOG_FLAG_BACKLOG,
  DEVICE_LOG_FLAG_DROPPED,
} from './constants';
import type { DeviceLogEvent } from '../models/Device';

export type { DeviceLogEvent } from '../models/Device';

const PACKET_HEADER_SIZE = 3;

export class DeviceLogDecoder {
  private lineBuffer = Buffer.alloc(0);
  private expectedSequence: number | null = null;

  push(packet: Buffer): DeviceLogEvent[] {
    if (packet.length < PACKET_HEADER_SIZE) {
      return [];
    }

    const sequence = packet.readUInt16LE(0);
    const flags = packet[2];
    const hasSequenceGap = this.expectedSequence !== null
      && sequence !== this.expectedSequence;
    const hasDroppedBytes = (flags & DEVICE_LOG_FLAG_DROPPED) !== 0;
    const events: DeviceLogEvent[] = [];

    if (hasSequenceGap || hasDroppedBytes) {
      this.lineBuffer = Buffer.alloc(0);
    }

    this.expectedSequence = (sequence + 1) & 0xffff;
    this.lineBuffer = Buffer.concat([this.lineBuffer, packet.subarray(PACKET_HEADER_SIZE)]);

    const isBacklog = (flags & DEVICE_LOG_FLAG_BACKLOG) !== 0;
    let newlineIndex = this.lineBuffer.indexOf(0x0a);
    while (newlineIndex !== -1) {
      let line = this.lineBuffer.subarray(0, newlineIndex);
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      events.push({
        level: 'debug',
        message: Buffer.from(line).toString('utf8'),
        isBacklog,
      });
      this.lineBuffer = this.lineBuffer.subarray(newlineIndex + 1);
      newlineIndex = this.lineBuffer.indexOf(0x0a);
    }

    return events;
  }

  reset(): void {
    this.lineBuffer = Buffer.alloc(0);
    this.expectedSequence = null;
  }
}
