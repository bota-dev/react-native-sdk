import { Buffer } from 'buffer';

import {
  DEVICE_DIAGNOSTICS_EVT_END,
  DEVICE_DIAGNOSTICS_EVT_DETAIL,
  DEVICE_DIAGNOSTICS_EVT_META,
  DEVICE_DIAGNOSTICS_EVT_SIGNATURE,
} from './constants';
import type {
  DeviceDiagnosticEvent,
  DeviceDiagnosticEventType,
  DeviceDiagnosticReasonCode,
  DeviceDiagnosticsBatch,
} from '../models/Device';

const EVENT_TYPES: Record<number, DeviceDiagnosticEventType> = {
  1: 'reset', 2: 'watchdog', 3: 'hard_fault', 4: 'storage',
  5: 'power', 6: 'radio', 7: 'security',
};
const REASONS: Record<number, DeviceDiagnosticReasonCode> = {
  1: 'watchdog_timeout', 2: 'cpu_illegal_instruction',
  3: 'cpu_misaligned_access', 4: 'cpu_stack_overflow',
  5: 'cpu_usage_fault', 6: 'memory_protection_fault',
  7: 'invalid_register_read', 8: 'invalid_register_write',
  9: 'audio_subsystem_fault', 10: 'wireless_subsystem_fault',
  11: 'flash_mmu_fault', 12: 'low_voltage_reset',
  255: 'unknown_cpu_exception',
};
const SUBSYSTEMS: Record<number, string> = {
  0: 'system', 1: 'audio', 2: 'wireless', 3: 'storage',
  4: 'power', 5: 'security',
};
const STATES: Record<number, string> = {
  0: 'boot', 1: 'deep_standby', 2: 'recording', 3: 'upload_preparing',
  4: 'uploading', 5: 'error_recovery', 6: 'full_sleep',
};
const BREADCRUMBS: Record<number, string> = {
  1: 'boot', 2: 'standby_entered', 3: 'recording_started',
  4: 'upload_preparing', 5: 'upload_started', 6: 'error_recovery',
  7: 'full_sleep',
};
const DETAIL_WIRE_SIZE = 176;

function u64LeHex(bytes: Buffer): string {
  return Buffer.from(bytes).reverse().toString('hex').padStart(16, '0');
}

export function diagnosticEventIdCommand(eventId: string): Buffer {
  if (!/^[0-9a-f]{16}$/.test(eventId)) {
    throw new Error('Diagnostic event_id must be 16 lowercase hex characters');
  }
  return Buffer.concat([
    Buffer.from([0x11]),
    Buffer.from(eventId, 'hex').reverse(),
  ]);
}

type PartialEvent = Omit<DeviceDiagnosticEvent, 'signature' | 'firmware_build_id' |
  'subsystem' | 'state_before_event'> & {
    signature?: string;
    firmware_build_id?: string;
    subsystem?: string;
    state_before_event?: string;
  };

interface DetailAssembly {
  buffer: Buffer;
  received: number;
}

function normalizedAddress(value: number): string | undefined {
  if (value === 0) return undefined;
  const region = (value & 0x80000000) !== 0
    ? 'sdram'
    : (value & 0x40000000) !== 0 ? 'ram' : 'rom';
  const offset = (value & 0x3fffffff).toString(16).padStart(8, '0');
  return `${region}:${offset}`;
}

function fixedHex32(value: number): string {
  return value.toString(16).padStart(8, '0');
}

function decodeDetail(bytes: Buffer): Pick<DeviceDiagnosticEvent,
  'firmware_build_id' | 'subsystem' | 'state_before_event' | 'report'> {
  if (bytes.length !== DETAIL_WIRE_SIZE || bytes[0] !== 1) {
    throw new Error('Unsupported diagnostic detail payload');
  }
  const hasReport = (bytes[1] & 1) !== 0;
  const firmwareBuildId = bytes.subarray(2, 14).toString('ascii');
  if (!/^[0-9a-f]{12}$/.test(firmwareBuildId)) {
    throw new Error('Invalid diagnostic firmware build id');
  }
  const common = {
    firmware_build_id: firmwareBuildId,
    subsystem: SUBSYSTEMS[bytes[14]] ?? 'system',
    state_before_event: STATES[bytes[15]] ?? 'unknown',
  };
  if (!hasReport) return common;

  const pcCount = Math.min(bytes[17], 6);
  const breadcrumbCount = Math.min(bytes[18], 8);
  const runtimeMask = bytes[19];
  const pcTrace: string[] = [];
  for (let index = 0; index < pcCount; index++) {
    const address = normalizedAddress(bytes.readUInt32LE(48 + index * 4));
    if (address) pcTrace.push(address);
  }
  const task = bytes.subarray(80, 96).toString('ascii').replace(/\0.*$/, '');
  const breadcrumbs = [];
  for (let index = 0; index < breadcrumbCount; index++) {
    const offset = 96 + index * 10;
    breadcrumbs.push({
      delta_ms: bytes.readInt32LE(offset),
      code: BREADCRUMBS[bytes.readUInt16LE(offset + 4)] ?? 'state_changed',
      arg0: bytes.readInt32LE(offset + 6),
    });
  }
  const reti = normalizedAddress(bytes.readUInt32LE(40));
  const rets = normalizedAddress(bytes.readUInt32LE(44));
  return {
    ...common,
    report: {
      fault: {
        cpu_id: bytes[16],
        cpu_emu: fixedHex32(bytes.readUInt32LE(20)),
        core_emu: fixedHex32(bytes.readUInt32LE(24)),
        hsb_emu: fixedHex32(bytes.readUInt32LE(28)),
        audio_emu: fixedHex32(bytes.readUInt32LE(32)),
        wireless_emu: fixedHex32(bytes.readUInt32LE(36)),
      },
      execution: {
        ...(task ? { task } : {}),
        ...(reti ? { reti } : {}),
        ...(rets ? { rets } : {}),
        pc_trace: pcTrace,
      },
      ...((runtimeMask & 3) !== 0 ? {
        runtime: {
          ...((runtimeMask & 1) !== 0
            ? { heap_free_bytes: bytes.readUInt32LE(72) } : {}),
          ...((runtimeMask & 2) !== 0
            ? { task_stack_remaining_bytes: bytes.readUInt32LE(76) } : {}),
        },
      } : {}),
      ...(breadcrumbs.length ? { breadcrumbs } : {}),
    },
  };
}

export class DeviceDiagnosticsDecoder {
  private events = new Map<number, PartialEvent>();
  private details = new Map<number, DetailAssembly>();

  push(packet: Buffer): DeviceDiagnosticsBatch | null {
    if (packet.length === 17 && packet[0] === DEVICE_DIAGNOSTICS_EVT_META) {
      const type = EVENT_TYPES[packet[2]];
      if (!type) return null;
      this.events.set(packet[1], {
        event_id: u64LeHex(packet.subarray(9, 17)),
        event_type: type,
        reason_code: REASONS[packet.readUInt16LE(3)] ?? 'unknown_cpu_exception',
        uptime_ms: packet.readUInt32LE(5),
      });
      return null;
    }
    if (packet.length === 10 && packet[0] === DEVICE_DIAGNOSTICS_EVT_SIGNATURE) {
      const event = this.events.get(packet[1]);
      if (event) event.signature = u64LeHex(packet.subarray(2, 10));
      return null;
    }
    if (packet.length >= 6 && packet.length <= 20 &&
        packet[0] === DEVICE_DIAGNOSTICS_EVT_DETAIL) {
      const index = packet[1];
      const offset = packet.readUInt16LE(2);
      const total = packet.readUInt16LE(4);
      if (total !== DETAIL_WIRE_SIZE || offset + packet.length - 6 > total) {
        this.reset();
        throw new Error('Invalid diagnostic detail chunk');
      }
      let detail = this.details.get(index);
      if (offset === 0) {
        if (detail) {
          this.reset();
          throw new Error(`Duplicate diagnostic detail at index ${index}`);
        }
        detail = { buffer: Buffer.alloc(total), received: 0 };
        this.details.set(index, detail);
      }
      if (!detail || detail.received !== offset) {
        this.reset();
        throw new Error(`Out-of-order diagnostic detail at index ${index}`);
      }
      packet.copy(detail.buffer, offset, 6);
      detail.received += packet.length - 6;
      if (detail.received === total) {
        const event = this.events.get(index);
        if (!event) {
          this.reset();
          throw new Error(`Diagnostic detail without metadata at index ${index}`);
        }
        Object.assign(event, decodeDetail(detail.buffer));
      }
      return null;
    }
    if (packet.length === 6 && packet[0] === DEVICE_DIAGNOSTICS_EVT_END) {
      const expected = packet[1];
      const events: DeviceDiagnosticEvent[] = [];
      for (let index = 0; index < expected; index++) {
        const event = this.events.get(index);
        if (!event?.signature || !event.firmware_build_id ||
            !event.subsystem || !event.state_before_event ||
            this.details.get(index)?.received !== DETAIL_WIRE_SIZE) {
          this.reset();
          throw new Error(`Incomplete diagnostic event at index ${index}`);
        }
        events.push(event as DeviceDiagnosticEvent);
      }
      const batch: DeviceDiagnosticsBatch = {
        schema_version: 1,
        dropped_count: packet.readUInt32LE(2),
        events,
      };
      this.reset();
      return batch;
    }
    return null;
  }

  reset(): void {
    this.events.clear();
    this.details.clear();
  }
}
