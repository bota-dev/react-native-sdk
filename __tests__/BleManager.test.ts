jest.mock(
  'react-native-ble-plx',
  () => {
    const State = {
      Unknown: 'Unknown',
      PoweredOn: 'PoweredOn',
      PoweredOff: 'PoweredOff',
      Unauthorized: 'Unauthorized',
      Unsupported: 'Unsupported',
    };

    class MockNativeBleManager {
      onStateChange(callback: (state: string) => void, emitCurrentState?: boolean) {
        if (emitCurrentState) callback(State.PoweredOn);
        return { remove: jest.fn() };
      }

      state = jest.fn(async () => State.PoweredOn);
      connectToDevice = jest.fn(async () => {
        throw new Error('native connect failed');
      });
      cancelDeviceConnection = jest.fn(async () => {});
      stopDeviceScan = jest.fn();
      destroy = jest.fn();
    }

    return { BleManager: MockNativeBleManager, State };
  },
  { virtual: true }
);

import { BleManager } from '../src/ble/BleManager';
import { logger, type SdkLogEntry } from '../src/utils/logger';

describe('BleManager connection failure logging', () => {
  let entries: SdkLogEntry[];

  beforeEach(() => {
    entries = [];
    logger.setLevel('debug');
    logger.setHandler((entry) => entries.push(entry));
  });

  afterEach(() => {
    logger.setHandler(null);
  });

  it('logs background connection failures as debug entries without an Error stack', async () => {
    const manager = new BleManager();

    await expect(manager.connect('device-1', 'background')).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });

    expect(entries.find((entry) => entry.level === 'error')).toBeUndefined();
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'debug',
          message: '[BleManager] Connection failed',
          context: expect.objectContaining({
            deviceId: 'device-1',
            priority: 'background',
            error: 'native connect failed',
          }),
        }),
      ])
    );

    manager.destroy();
  });

  it('keeps user-initiated connection failures at error level', async () => {
    const manager = new BleManager();

    await expect(manager.connect('device-1', 'user')).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          message: '[BleManager] Connection failed',
          context: expect.objectContaining({
            deviceId: 'device-1',
            priority: 'user',
            error: 'native connect failed',
          }),
        }),
      ])
    );

    manager.destroy();
  });
});

it('ignores a late disconnect from the previous connection of the same peripheral', async () => {
  const manager = new BleManager();
  const callbacks: Array<(error: null, device: any) => void> = [];
  const makeDevice = () => ({
    id: 'device-1', isConnected: async () => false,
    discoverAllServicesAndCharacteristics: async () => {},
    onDisconnected: (callback: typeof callbacks[number]) => { callbacks.push(callback); return { remove: jest.fn() }; },
  });
  const first = makeDevice();
  const second = makeDevice();
  (manager as any).manager.connectToDevice.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const disconnected = jest.fn();
  manager.on('deviceDisconnected', disconnected);
  await manager.connect(first.id, 'background');
  await manager.connect(second.id, 'background');
  callbacks[0](null, first);
  expect(manager.isConnected(second.id)).toBe(true);
  expect(manager.getConnectionIdentity(second.id)).toBe(second);
  expect(disconnected).not.toHaveBeenCalled();
  callbacks[1](null, second);
  expect(manager.getConnectionIdentity(second.id)).toBeNull();
  expect(disconnected).toHaveBeenCalledTimes(1);
  manager.destroy();
});
