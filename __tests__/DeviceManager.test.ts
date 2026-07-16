jest.mock(
  'react-native-ble-plx',
  () => ({
    State: {
      Unknown: 'Unknown',
      PoweredOn: 'PoweredOn',
      PoweredOff: 'PoweredOff',
      Unauthorized: 'Unauthorized',
      Unsupported: 'Unsupported',
    },
  }),
  { virtual: true }
);

jest.mock(
  '@react-native-async-storage/async-storage',
  () => ({
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  }),
  { virtual: true }
);

import { DeviceManager } from '../src/managers/DeviceManager';

describe('DeviceManager reconnect matching', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps scanning for an advertised MAC match without probing same-name devices', async () => {
    const wanted = {
      id: 'new-id',
      name: 'Bota Pin',
      deviceType: 'bota_pin',
      firmwareVersion: '0.0.0',
      pairingState: 'paired',
      rssi: -45,
      discoveredAt: new Date(),
    };
    const withoutMac = { ...wanted, macAddress: null };
    const withMac = { ...wanted, macAddress: 'EF:7F:26:9C:C7:73' };

    const manager = Object.create(DeviceManager.prototype) as any;
    manager.connectedDevices = new Map();
    manager.reconnectRegistry = {
      CKVYWO4LTS: {
        bleId: 'old-id',
        bleName: 'Bota Pin',
        mac: 'ef7f269cc773',
        deviceType: 'bota_pin',
      },
    };
    manager.startScan = jest.fn().mockResolvedValue(undefined);
    manager.stopScan = jest.fn();
    manager.connect = jest.fn().mockResolvedValue({ serialNumber: 'CKVYWO4LTS' });
    manager.bleManager = { flushPeripheralConnection: jest.fn() };

    let reads = 0;
    manager.getDiscoveredDevices = jest.fn(() => {
      reads++;
      return reads < 3 ? [withoutMac] : [withMac];
    });

    const reconnect = manager.doReconnect('CKVYWO4LTS', { scanTimeout: 1000 });

    await jest.advanceTimersByTimeAsync(200);
    await jest.advanceTimersByTimeAsync(200);

    await reconnect;

    expect(manager.startScan).toHaveBeenCalledWith({ timeout: 1000, allowDuplicates: true });
    expect(manager.connect).toHaveBeenCalledWith(withMac, 'background');
  });

  it('does not reconnect by probing a same-name Bota device when no stable identity matches', async () => {
    const sameNameCandidate = {
      id: 'candidate-id',
      name: 'Bota Pin',
      deviceType: 'bota_pin',
      firmwareVersion: '0.0.0',
      pairingState: 'paired',
      rssi: -45,
      macAddress: null,
      discoveredAt: new Date(),
    };

    const manager = Object.create(DeviceManager.prototype) as any;
    manager.connectedDevices = new Map();
    manager.reconnectRegistry = {
      EVFXXW67KP: {
        bleId: 'old-id',
        bleName: 'Bota Pin',
        deviceType: 'bota_pin',
      },
    };
    manager.startScan = jest.fn().mockResolvedValue(undefined);
    manager.stopScan = jest.fn();
    manager.connect = jest.fn();
    manager.bleManager = { flushPeripheralConnection: jest.fn().mockResolvedValue(undefined) };
    manager.getDiscoveredDevices = jest.fn(() => [sameNameCandidate]);

    const reconnect = manager.doReconnect('EVFXXW67KP', { scanTimeout: 1000 });
    const assertion = expect(reconnect).rejects.toThrow('Device EVFXXW67KP not found');

    await jest.advanceTimersByTimeAsync(1000);

    await assertion;
    expect(manager.connect).not.toHaveBeenCalled();
    expect(manager.bleManager.flushPeripheralConnection).toHaveBeenCalledWith('old-id');
  });

  it('skips reconnect scan when there is no stored peripheral id or advertised MAC', async () => {
    const manager = Object.create(DeviceManager.prototype) as any;
    manager.connectedDevices = new Map();
    manager.reconnectRegistry = {
      DS5WMKQONI: {
        bleName: 'Bota Pin',
        deviceType: 'bota_pin',
      },
    };
    manager.startScan = jest.fn();
    manager.stopScan = jest.fn();
    manager.connect = jest.fn();
    manager.bleManager = { flushPeripheralConnection: jest.fn() };

    await expect(manager.doReconnect('DS5WMKQONI', { scanTimeout: 1000 }))
      .rejects.toThrow('Device DS5WMKQONI not found');

    expect(manager.startScan).not.toHaveBeenCalled();
    expect(manager.stopScan).not.toHaveBeenCalled();
    expect(manager.connect).not.toHaveBeenCalled();
    expect(manager.bleManager.flushPeripheralConnection).not.toHaveBeenCalled();
  });
});

describe('DeviceManager connect identity reads', () => {
  it('refreshes identity for user-initiated connects even when the BLE id is already connected', async () => {
    const bleManager = {
      beginUserTransaction: jest.fn(() => jest.fn()),
      connect: jest.fn().mockResolvedValue(undefined),
      getMtu: jest.fn().mockResolvedValue(185),
      hasService: jest.fn().mockResolvedValue(true),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    const manager = Object.create(DeviceManager.prototype) as any;
    manager.bleManager = bleManager;
    manager.connectedDevices = new Map([
      ['ios-peripheral-id', {
        id: 'ios-peripheral-id',
        serialNumber: 'FY7DBSUMQK',
        deviceType: 'bota_pin',
        firmwareVersion: '1.0.0',
        connectionState: 'connected',
        mtu: 185,
        capabilities: { bleSync: true, wifiUpload: true, lteUpload: false, remoteRecord: true },
      }],
    ]);
    manager.reconnectRegistry = {};
    manager.emit = jest.fn();
    manager.readSerialNumber = jest.fn().mockResolvedValue('EVFXXW67KP');
    manager.readFirmwareVersion = jest.fn().mockResolvedValue('1.0.1');
    manager.readHardwareRevision = jest.fn().mockResolvedValue('B');
    manager.readPairingState = jest.fn().mockResolvedValue('unpaired');
    manager.subscribeToNonce = jest.fn();
    manager.saveReconnectRegistry = jest.fn().mockResolvedValue(undefined);

    const result = await manager.connect({
      id: 'ios-peripheral-id',
      name: 'Bota Pin',
      deviceType: 'bota_pin',
      firmwareVersion: '0.0.0',
      pairingState: 'unpaired',
      rssi: -50,
      discoveredAt: new Date(),
    }, 'user');

    expect(manager.readSerialNumber).toHaveBeenCalledWith('ios-peripheral-id');
    expect(result.serialNumber).toBe('EVFXXW67KP');
  });

  it('reads serial fresh for user-initiated connects even when BLE id is cached', async () => {
    const bleManager = {
      beginUserTransaction: jest.fn(() => jest.fn()),
      connect: jest.fn().mockResolvedValue(undefined),
      getMtu: jest.fn().mockResolvedValue(185),
      hasService: jest.fn().mockResolvedValue(true),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    const manager = Object.create(DeviceManager.prototype) as any;
    manager.bleManager = bleManager;
    manager.connectedDevices = new Map();
    manager.reconnectRegistry = {
      FY7DBSUMQK: {
        bleId: 'ios-peripheral-id',
        bleName: 'Bota Pin',
        serialNumber: 'FY7DBSUMQK',
        firmwareVersion: '1.0.0',
        hardwareRevision: 'A',
        wifiUploadCapable: true,
      },
    };
    manager.emit = jest.fn();
    manager.readSerialNumber = jest.fn().mockResolvedValue('EVFXXW67KP');
    manager.readFirmwareVersion = jest.fn().mockResolvedValue('1.0.1');
    manager.readHardwareRevision = jest.fn().mockResolvedValue('B');
    manager.readPairingState = jest.fn().mockResolvedValue('unpaired');
    manager.subscribeToNonce = jest.fn();
    manager.saveReconnectRegistry = jest.fn().mockResolvedValue(undefined);

    const result = await manager.connect({
      id: 'ios-peripheral-id',
      name: 'Bota Pin',
      deviceType: 'bota_pin',
      firmwareVersion: '0.0.0',
      pairingState: 'unpaired',
      rssi: -50,
      discoveredAt: new Date(),
    }, 'user');

    expect(manager.readSerialNumber).toHaveBeenCalledWith('ios-peripheral-id');
    expect(result.serialNumber).toBe('EVFXXW67KP');
    expect(manager.reconnectRegistry.FY7DBSUMQK).toBeUndefined();
    expect(manager.reconnectRegistry.EVFXXW67KP.bleId).toBe('ios-peripheral-id');
  });
});
