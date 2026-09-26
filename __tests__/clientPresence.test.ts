jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true });
jest.mock('react-native-quick-crypto', () => require('node:crypto'), { virtual: true });
jest.mock('react-native-ble-plx', () => ({ State: { Unknown: 'Unknown', PoweredOn: 'PoweredOn' } }), { virtual: true });
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn() }), { virtual: true });
jest.mock('../src/ble/BleManager', () => ({ getBleManager: () => mockBle }));

import EventEmitter from 'eventemitter3';
import { DeviceManager } from '../src/managers/DeviceManager';
import { BotaClient } from '../src/BotaClient';
import fixture from '../protocol/vendor/app-sdk/client-presence-v1.json';

let identity: object | null = null;
const mockBle = Object.assign(new EventEmitter(), {
  connect: jest.fn(async () => (identity ??= {})),
  disconnect: jest.fn(async () => { identity = null; mockBle.emit('deviceDisconnected', 'device-1'); }),
  getConnectionIdentity: jest.fn(() => identity),
  isConnected: jest.fn(() => identity !== null),
  beginUserTransaction: jest.fn(() => jest.fn()),
  getMtu: jest.fn(async () => 185),
  hasService: jest.fn(async () => true),
  writeCharacteristic: jest.fn(async () => {}),
  readCharacteristic: jest.fn(async () => Buffer.alloc(16)),
  subscribeToCharacteristic: jest.fn(() => ({ remove: jest.fn() })),
});

const candidate = { id: 'device-1', name: 'Bota Pin', deviceType: 'bota_pin', discoveredAt: new Date(), rssi: -50 } as const;
function manager() {
  const value = new DeviceManager();
  jest.spyOn(value as any, 'readSerialNumber').mockResolvedValue('GDPPSBZJN6');
  jest.spyOn(value as any, 'readFirmwareVersion').mockResolvedValue('1.0');
  jest.spyOn(value as any, 'readHardwareRevision').mockResolvedValue('A');
  jest.spyOn(value as any, 'readPairingState').mockResolvedValue('paired');
  return value;
}

beforeEach(() => {
  identity = null;
  mockBle.removeAllListeners();
  jest.clearAllMocks();
});

it('runs the pinned cross-platform lifecycle fixture through SDK connections', async () => {
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const source = require('../protocol/vendor/app-sdk/client-presence-v1.source.json');
  expect(crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../protocol/vendor/app-sdk/client-presence-v1.json'))).digest('hex')).toBe(source.sha256);
  const value = manager();
  const connections = new Map<string, object>();
  const sessions: string[] = [];
  const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
  try {
    for (const step of fixture.steps) {
      if (step.action === 'verified_connect') {
        identity = {};
        connections.set(step.connection!, identity);
        await value.connect(candidate);
      } else if (step.action === 'disconnect') {
        // BleManager owns native callback fencing (covered by its regression).
        if (identity === connections.get(step.connection!)) {
          identity = null;
          mockBle.emit('deviceDisconnected', candidate.id);
        }
      } else if (step.action === 'destroy') {
        value.destroy();
      } else {
        const report = await value.clientPresence.nextReport(step.device_id!);
        if (!step.expected) expect(report).toBeNull();
        else {
          sessions[step.expected.session] ??= report!.session_id;
          expect(report).toMatchObject({ session_id: sessions[step.expected.session], sequence: step.expected.sequence });
        }
      }
    }
    expect(new Set(sessions).size).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});

it('exposes an additive passive getter before SDK configuration', async () => {
  expect(BotaClient.clientPresence).toEqual({ nextReport: expect.any(Function) });
  await expect(BotaClient.clientPresence.nextReport('device-1')).resolves.toBeNull();
});

it('reports verified sessions, keeps cached reuse, and performs no extra I/O', async () => {
  const value = manager();
  expect(value.clientPresence).toBeDefined();
  await expect(value.clientPresence.nextReport(candidate.id)).resolves.toBeNull();
  const device = await value.connect(candidate);
  const calls = [mockBle.connect.mock.calls.length, mockBle.writeCharacteristic.mock.calls.length, mockBle.subscribeToCharacteristic.mock.calls.length];
  const first = await value.clientPresence.nextReport(device.id);
  expect(first).toEqual({
    schema_version: 1, session_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    sequence: 1, platform: 'ios', sdk_package: require('../package.json').name, sdk_version: require('../package.json').version,
  });
  await expect(value.clientPresence.nextReport('other')).resolves.toBeNull();
  await expect(value.connect(candidate, 'background')).resolves.toBe(device);
  await expect(value.clientPresence.nextReport(device.id)).resolves.toEqual({ ...first, sequence: 2 });
  expect([mockBle.connect.mock.calls.length, mockBle.writeCharacteristic.mock.calls.length, mockBle.subscribeToCharacteristic.mock.calls.length]).toEqual(calls);
  await value.disconnect(device);
  await expect(value.clientPresence.nextReport(device.id)).resolves.toBeNull();
  await value.connect(candidate, 'background');
  const second = await value.clientPresence.nextReport(device.id);
  expect(second.sequence).toBe(1);
  expect(second.session_id).not.toBe(first.session_id);
  identity = null;
  mockBle.emit('deviceDisconnected', device.id);
  await expect(value.clientPresence.nextReport(device.id)).resolves.toBeNull();
  value.destroy();
});

it('cannot publish an abandoned connect after destroy', async () => {
  const value = manager();
  let resolve!: (value: string) => void;
  (value as any).readSerialNumber.mockImplementation(() => new Promise(r => { resolve = r; }));
  const connecting = value.connect(candidate);
  await Promise.resolve();
  value.destroy();
  resolve('GDPPSBZJN6');
  await connecting;
  await expect(value.clientPresence.nextReport(candidate.id)).resolves.toBeNull();
});

it('cannot publish a pending identity read after explicit disconnect', async () => {
  const value = manager();
  const device = await value.connect(candidate);
  let resolve!: (value: string) => void;
  (value as any).readSerialNumber.mockImplementation(() => new Promise(r => { resolve = r; }));
  const connecting = value.connect(candidate);
  await Promise.resolve();
  // Queue native disconnect: the old handle remains locally visible for now.
  let finishDisconnect!: () => void;
  mockBle.disconnect.mockImplementationOnce(() => new Promise<void>(r => { finishDisconnect = r; }));
  const disconnecting = value.disconnect(device);
  resolve('GDPPSBZJN6');
  await connecting;
  await expect(value.clientPresence.nextReport(candidate.id)).resolves.toBeNull();
  finishDisconnect();
  await disconnecting;
  value.destroy();
});

it('invalidates metadata immediately when the adapter is powered off', async () => {
  const value = manager();
  await value.connect(candidate);
  mockBle.emit('stateChange', 'PoweredOff');
  await expect(value.clientPresence.nextReport(candidate.id)).resolves.toBeNull();
  mockBle.emit('stateChange', 'PoweredOn');
  await expect(value.clientPresence.nextReport(candidate.id)).resolves.toBeNull();
  value.destroy();
});

it('fails closed when secure randomness is unavailable without failing the BLE connection', async () => {
  const crypto = require('react-native-quick-crypto');
  const random = jest.spyOn(crypto, 'randomBytes').mockImplementation(() => { throw new Error('unavailable'); });
  try {
    const value = manager();
    await expect(value.connect(candidate)).resolves.toMatchObject({ serialNumber: 'GDPPSBZJN6' });
    await expect(value.clientPresence.nextReport(candidate.id)).resolves.toBeNull();
    value.destroy();
  } finally { random.mockRestore(); }
});
