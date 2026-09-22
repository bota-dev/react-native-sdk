import { Buffer } from 'buffer';

import { DeviceDiagnosticsDecoder, diagnosticEventIdCommand } from '../deviceDiagnostics';

describe('DeviceDiagnosticsDecoder', () => {
  it('assembles metadata, signature, and chunked v1 detail into a heartbeat batch', () => {
    const decoder = new DeviceDiagnosticsDecoder();
    const meta = Buffer.alloc(17);
    meta[0] = 0x90;
    meta[1] = 0;
    meta[2] = 3;
    meta.writeUInt16LE(5, 3);
    meta.writeUInt32LE(982341, 5);
    Buffer.from('000000000000002a', 'hex').reverse().copy(meta, 9);
    const signature = Buffer.concat([
      Buffer.from([0x91, 0]),
      Buffer.from('0123456789abcdef', 'hex').reverse(),
    ]);
    const detail = Buffer.alloc(176);
    detail[0] = 1;
    detail[1] = 1;
    detail.write('a4f02973d61c', 2, 'ascii');
    detail[14] = 0;
    detail[15] = 2;
    detail[16] = 0;
    detail[17] = 3;
    detail[18] = 1;
    detail[19] = 1;
    detail.writeUInt32LE(8, 20);
    detail.writeUInt32LE(0x00014bd0, 40);
    detail.writeUInt32LE(0x000082a4, 44);
    detail.writeUInt32LE(0x00004118, 48);
    detail.writeUInt32LE(0x000082a4, 52);
    detail.writeUInt32LE(0x00014bd0, 56);
    detail.writeUInt32LE(18320, 72);
    detail.write('btstack', 80, 'ascii');
    detail.writeInt32LE(-210, 96);
    detail.writeUInt16LE(3, 100);
    detail.writeInt32LE(2, 102);
    const end = Buffer.alloc(2);
    end[0] = 0x92;
    end[1] = 1;

    expect(decoder.push(meta)).toBeNull();
    expect(decoder.push(signature)).toBeNull();
    for (let offset = 0; offset < detail.length; offset += 14) {
      const bytes = detail.subarray(offset, Math.min(offset + 14, detail.length));
      const packet = Buffer.alloc(6 + bytes.length);
      packet[0] = 0x95;
      packet[1] = 0;
      packet.writeUInt16LE(offset, 2);
      packet.writeUInt16LE(detail.length, 4);
      bytes.copy(packet, 6);
      expect(decoder.push(packet)).toBeNull();
    }
    expect(decoder.push(end)).toEqual({
      schema_version: 1,
      events: [{
        event_id: '000000000000002a',
        event_type: 'hard_fault',
        reason_code: 'cpu_usage_fault',
        uptime_ms: 982341,
        signature: '0123456789abcdef',
        firmware_build_id: 'a4f02973d61c',
        subsystem: 'system',
        state_before_event: 'recording',
        report: {
          fault: {
            cpu_id: 0,
            cpu_emu: '00000008',
            core_emu: '00000000',
            hsb_emu: '00000000',
            audio_emu: '00000000',
            wireless_emu: '00000000',
          },
          execution: {
            task: 'btstack',
            reti: 'rom:00014bd0',
            rets: 'rom:000082a4',
            pc_trace: ['rom:00004118', 'rom:000082a4', 'rom:00014bd0'],
          },
          runtime: { heap_free_bytes: 18320 },
          breadcrumbs: [{
            delta_ms: -210,
            code: 'recording_started',
            arg0: 2,
          }],
        },
      }],
    });
  });

  it('encodes an acknowledged event id as little-endian wire bytes', () => {
    expect(diagnosticEventIdCommand('0123456789abcdef').toString('hex'))
      .toBe('11efcdab8967452301');
  });

  it('rejects malformed event ids', () => {
    expect(() => diagnosticEventIdCommand('ABC')).toThrow();
  });

  it('rejects duplicate and out-of-order detail chunks', () => {
    const first = Buffer.alloc(20);
    first[0] = 0x95;
    first.writeUInt16LE(0, 2);
    first.writeUInt16LE(176, 4);

    const duplicateDecoder = new DeviceDiagnosticsDecoder();
    expect(duplicateDecoder.push(first)).toBeNull();
    expect(() => duplicateDecoder.push(first)).toThrow('Duplicate diagnostic detail');

    const outOfOrder = Buffer.from(first);
    outOfOrder.writeUInt16LE(28, 2);
    const outOfOrderDecoder = new DeviceDiagnosticsDecoder();
    expect(() => outOfOrderDecoder.push(outOfOrder)).toThrow(
      'Out-of-order diagnostic detail',
    );
  });
});
