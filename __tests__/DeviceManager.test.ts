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

  it('recovers by serial number when the stored advertised MAC is stale', async () => {
    const candidate = {
      id: 'rotated-ios-id',
      name: 'Bota Pin',
      deviceType: 'bota_pin',
      firmwareVersion: '0.0.0',
      pairingState: 'paired',
      rssi: -45,
      macAddress: '11:22:33:44:55:66',
      discoveredAt: new Date(),
    };

    const manager = Object.create(DeviceManager.prototype) as any;
    manager.connectedDevices = new Map();
    manager.reconnectRegistry = {
      E1285U6OMJ: {
        bleId: 'stale-ios-id',
        bleName: 'Bota Pin',
        mac: 'bb95835172d9',
        deviceType: 'bota_pin',
      },
    };
    manager.startScan = jest.fn().mockResolvedValue(undefined);
    manager.stopScan = jest.fn();
    manager.connect = jest.fn().mockResolvedValue({ serialNumber: 'E1285U6OMJ' });
    manager.probeSerialNumber = jest.fn().mockResolvedValue('E1285U6OMJ');
    manager.bleManager = {
      flushPeripheralConnection: jest.fn(),
      isUserOpInFlight: jest.fn(() => false),
    };
    manager.getDiscoveredDevices = jest.fn(() => [candidate]);

    const reconnect = manager.doReconnect('E1285U6OMJ', { scanTimeout: 1000 });

    await jest.advanceTimersByTimeAsync(1000);

    await reconnect;
    expect(manager.probeSerialNumber).toHaveBeenCalledWith(candidate.id);
    expect(manager.connect).toHaveBeenCalledWith(candidate, 'background');
    expect(manager.bleManager.flushPeripheralConnection).not.toHaveBeenCalled();
  });

  it('does not reconnect by probing a same-name Bota device while user work is in flight', async () => {
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
    manager.bleManager = {
      flushPeripheralConnection: jest.fn().mockResolvedValue(undefined),
      isUserOpInFlight: jest.fn(() => true),
    };
    manager.getDiscoveredDevices = jest.fn(() => [sameNameCandidate]);

    const reconnect = manager.doReconnect('EVFXXW67KP', { scanTimeout: 1000 });
    const assertion = expect(reconnect).rejects.toThrow('Device EVFXXW67KP not found');

    await jest.advanceTimersByTimeAsync(1000);

    await assertion;
    expect(manager.connect).not.toHaveBeenCalled();
    expect(manager.bleManager.flushPeripheralConnection).toHaveBeenCalledWith('old-id');
  });

  it('reconnects legacy entries by serial probe when the iOS peripheral id rotated', async () => {
    const rotatedIdCandidate = {
      id: 'rotated-id',
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
      C8SU2XXWHI: {
        bleId: 'old-ios-id',
        bleName: 'Bota Pin',
        deviceType: 'bota_pin',
      },
    };
    manager.startScan = jest.fn().mockResolvedValue(undefined);
    manager.stopScan = jest.fn();
    manager.connect = jest.fn().mockResolvedValue({ serialNumber: 'C8SU2XXWHI' });
    manager.probeSerialNumber = jest.fn().mockResolvedValue('C8SU2XXWHI');
    manager.bleManager = {
      flushPeripheralConnection: jest.fn(),
      isUserOpInFlight: jest.fn(() => false),
    };
    manager.getDiscoveredDevices = jest.fn(() => [rotatedIdCandidate]);

    const reconnect = manager.doReconnect('C8SU2XXWHI', { scanTimeout: 1000 });

    await jest.advanceTimersByTimeAsync(1000);

    await reconnect;
    expect(manager.probeSerialNumber).toHaveBeenCalledWith('rotated-id');
    expect(manager.connect).toHaveBeenCalledWith(rotatedIdCandidate, 'background');
    expect(manager.bleManager.flushPeripheralConnection).not.toHaveBeenCalled();
  });

  it('recovers after app reinstall by probing Bota candidates for the known serial number', async () => {
    const candidate = {
      id: 'new-ios-id',
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
    manager.reconnectRegistry = {};
    manager.startScan = jest.fn().mockResolvedValue(undefined);
    manager.stopScan = jest.fn();
    manager.connect = jest.fn().mockResolvedValue({ serialNumber: 'EVFXXW67KP' });
    manager.probeSerialNumber = jest.fn().mockResolvedValue('EVFXXW67KP');
    manager.bleManager = {
      flushPeripheralConnection: jest.fn(),
      isUserOpInFlight: jest.fn(() => false),
    };
    manager.getDiscoveredDevices = jest.fn(() => [candidate]);

    const reconnect = manager.doReconnect('EVFXXW67KP', { scanTimeout: 1000 });

    await jest.advanceTimersByTimeAsync(1000);

    await reconnect;
    expect(manager.startScan).toHaveBeenCalledWith({ timeout: 1000, allowDuplicates: true });
    expect(manager.probeSerialNumber).toHaveBeenCalledWith('new-ios-id');
    expect(manager.connect).toHaveBeenCalledWith(candidate, 'background');
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
