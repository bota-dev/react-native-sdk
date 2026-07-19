import { Buffer } from 'buffer';
import { parseConnectionSettings, parseRecordingList, serializeConnectionSettings } from '../src/ble/parsers';

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

describe('DEVICE_SETTINGS heartbeat channel mask', () => {
  const oldShape = {
    enabled_connections: { wifi: true, cellular: true },
    upload_network_preference: ['wifi', 'ble', 'cellular'] as const,
  };

  it.each([
    [0x80, { wifi: false, cellular: false }],
    [0x81, { wifi: true, cellular: false }],
    [0x82, { wifi: false, cellular: true }],
    [0x83, { wifi: true, cellular: true }],
  ])('parses explicit mask 0x%s', (mask, expected) => {
    const payload = Buffer.alloc(12);
    payload[0] = 0x02;
    payload[1] = 0x03;
    payload[9] = mask as number;

    expect(parseConnectionSettings(payload).heartbeat_enabled_connections).toEqual(expected);
  });

  it.each([8, 12])('defaults a legacy %i-byte payload to both channels enabled', (length) => {
    const payload = Buffer.alloc(length);
    payload[0] = length === 8 ? 0x01 : 0x02;
    payload[1] = 0x03;

    expect(parseConnectionSettings(payload).heartbeat_enabled_connections).toEqual({
      wifi: true,
      cellular: true,
    });
  });

  it('serializes an omitted heartbeat setting as explicit both-enabled', () => {
    expect(serializeConnectionSettings(oldShape)[9]).toBe(0x83);
  });

  it.each([
    [{ wifi: false, cellular: false }, 0x80],
    [{ wifi: true, cellular: false }, 0x81],
    [{ wifi: false, cellular: true }, 0x82],
    [{ wifi: true, cellular: true }, 0x83],
  ])('serializes %o as 0x%s', (heartbeat_enabled_connections, expected) => {
    expect(serializeConnectionSettings({
      ...oldShape,
      heartbeat_enabled_connections,
    })[9]).toBe(expected);
  });
});

describe('DEVICE_SETTINGS power management', () => {
  const baseSettings = {
    enabled_connections: { wifi: true, cellular: true },
    upload_network_preference: ['wifi', 'ble', 'cellular'] as const,
  };

  it.each([
    [-1, 0xFF],
    [0, 0x00],
    [15, 0x01],
    [180, 0x12],
    [2540, 0xFE],
  ])('serializes %i seconds as 0x%s', (seconds, expected) => {
    const payload = serializeConnectionSettings({
      ...baseSettings,
      power_management: {
        wifi_idle_timeout_seconds: seconds,
        cellular_idle_timeout_seconds: seconds,
      },
    });

    expect(payload[5]).toBe(expected);
    expect(payload[6]).toBe(expected);
  });

  it('serializes omitted power management as the 180-second default', () => {
    const payload = serializeConnectionSettings(baseSettings);

    expect(payload[5]).toBe(18);
    expect(payload[6]).toBe(18);
  });

  it.each([-2, 1, 9, 2541])('rejects invalid timeout %i', (seconds) => {
    expect(() => serializeConnectionSettings({
      ...baseSettings,
      power_management: {
        wifi_idle_timeout_seconds: seconds,
        cellular_idle_timeout_seconds: 180,
      },
    })).toThrow(RangeError);
  });

  it.each([
    [0xFF, -1],
    [0x00, 0],
    [0x01, 10],
    [0x12, 180],
    [0xFE, 2540],
  ])('parses byte 0x%s as %i seconds', (raw, expected) => {
    const payload = Buffer.alloc(12);
    payload[0] = 0x02;
    payload[1] = 0x03;
    payload[5] = raw;
    payload[6] = raw;

    const settings = parseConnectionSettings(payload);

    expect(settings.power_management).toEqual({
      wifi_idle_timeout_seconds: expected,
      cellular_idle_timeout_seconds: expected,
    });
  });
});
