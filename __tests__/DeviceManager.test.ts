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
import {
  CHAR_DEVICE_COMMAND,
  CHAR_DEVICE_LOG_CONTROL,
  CHAR_DEVICE_LOG_DATA,
  CHAR_PROVISIONING_RESULT,
  CHAR_TIME_SYNC,
  DEVICE_CMD_BLE_FACTORY_RESET,
  DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK,
  DEVICE_LOG_CMD_START,
  DEVICE_LOG_CMD_STOP,
  SERVICE_BOTA_CONTROL,
  SERVICE_BOTA_DIAGNOSTICS,
  SERVICE_BOTA_PROVISIONING,
} from '../src/ble/constants';

const connectedDevice = {
  id: 'device-log-test',
  serialNumber: 'BOTA123',
  deviceType: 'bota_pin',
  firmwareVersion: '1.0.0',
  isProvisioned: true,
  connectionState: 'connected',
  mtu: 185,
} as const;

function createDeviceLogManager() {
  const monitor = { remove: jest.fn() };
  const bleManager = Object.assign(new (require('eventemitter3'))(), {
    isConnected: jest.fn(() => true),
    subscribeToCharacteristic: jest.fn(() => monitor),
    writeCharacteristic: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  });
  const manager = Object.create(DeviceManager.prototype) as any;
  manager.bleManager = bleManager;
  manager.connectedDevices = new Map([[connectedDevice.id, connectedDevice]]);
  manager.statusSubscriptions = new Map();
  manager.nonceSubscriptions = new Map();
  manager.nonceCache = new Map();
  manager.deviceLogSubscriptions = new Map();
  manager.deviceLogDecoders = new Map();
  manager.recordingStateCache = new Map();
  manager.stateCache = { clearAll: jest.fn(), removeAllListeners: jest.fn() };
  manager.stopAutoReconnectLoop = jest.fn();
  manager.emit = jest.fn();
  manager.removeAllListeners = jest.fn();

  return { manager, bleManager, monitor };
}

function createFactoryResetManager() {
  const monitor = { remove: jest.fn() };
  const bleManager = Object.assign(new (require('eventemitter3'))(), {
    isConnected: jest.fn(() => true),
    subscribeToCharacteristic: jest.fn(() => monitor),
    writeCharacteristic: jest.fn().mockResolvedValue(undefined),
  });
  const manager = Object.create(DeviceManager.prototype) as any;
  manager.bleManager = bleManager;
  manager.writeGrant = jest.fn().mockResolvedValue(undefined);

  return { manager, bleManager, monitor };
}

async function flushPromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('DeviceManager authenticated factory reset', () => {
  it('persists the three-byte success result before sending receipt opcode 0x0A', async () => {
    const { manager, bleManager, monitor } = createFactoryResetManager();
    const persistResult = jest.fn().mockResolvedValue(undefined);

    const reset = manager.bleFactoryReset(connectedDevice, 'grant-blob', persistResult);
    await flushPromises();

    expect(manager.writeGrant).toHaveBeenCalledWith(connectedDevice, 'grant-blob');
    expect(bleManager.subscribeToCharacteristic).toHaveBeenCalledWith(
      connectedDevice.id,
      SERVICE_BOTA_PROVISIONING,
      CHAR_PROVISIONING_RESULT,
      expect.any(Function),
      expect.any(Function)
    );
    expect(bleManager.writeCharacteristic).toHaveBeenCalledWith(
      connectedDevice.id,
      SERVICE_BOTA_CONTROL,
      CHAR_DEVICE_COMMAND,
      Buffer.from([DEVICE_CMD_BLE_FACTORY_RESET])
    );

    const onData = bleManager.subscribeToCharacteristic.mock.calls[0][3];
    onData(Buffer.from([0x00, 0x34, 0x12]));

    await expect(reset).resolves.toEqual({
      success: true,
      localRecordingsDeleted: 0x1234,
    });
    expect(persistResult).toHaveBeenCalledWith({
      success: true,
      localRecordingsDeleted: 0x1234,
    });
    expect(bleManager.writeCharacteristic).toHaveBeenLastCalledWith(
      connectedDevice.id,
      SERVICE_BOTA_CONTROL,
      CHAR_DEVICE_COMMAND,
      Buffer.from([DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK])
    );
    expect(persistResult.mock.invocationCallOrder[0]).toBeLessThan(
      bleManager.writeCharacteristic.mock.invocationCallOrder[1]
    );
    expect(monitor.remove).toHaveBeenCalledTimes(1);
  });

  it('does not send receipt when durable result persistence fails', async () => {
    const { manager, bleManager } = createFactoryResetManager();
    const persistResult = jest.fn().mockRejectedValue(new Error('storage unavailable'));

    const reset = manager.bleFactoryReset(connectedDevice, 'grant-blob', persistResult);
    await flushPromises();
    const onData = bleManager.subscribeToCharacteristic.mock.calls[0][3];
    onData(Buffer.from([0x00, 0x02, 0x00]));

    await expect(reset).rejects.toThrow('storage unavailable');
    expect(bleManager.writeCharacteristic).toHaveBeenCalledTimes(1);
    expect(bleManager.writeCharacteristic.mock.calls[0][3]).toEqual(
      Buffer.from([DEVICE_CMD_BLE_FACTORY_RESET])
    );
  });

  it('keeps the persisted wipe result retryable when receipt write fails', async () => {
    const { manager, bleManager } = createFactoryResetManager();
    const persistResult = jest.fn().mockResolvedValue(undefined);
    bleManager.writeCharacteristic
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('receipt write failed'));

    const reset = manager.bleFactoryReset(
      connectedDevice,
      'grant-blob',
      persistResult
    );
    await flushPromises();
    const onData = bleManager.subscribeToCharacteristic.mock.calls[0][3];
    onData(Buffer.from([0x00, 0x02, 0x00]));

    await expect(reset).rejects.toThrow('receipt write failed');
    expect(persistResult).toHaveBeenCalledWith({
      success: true,
      localRecordingsDeleted: 2,
    });
    expect(bleManager.writeCharacteristic).toHaveBeenCalledTimes(2);
  });

  it('returns a firmware failure without persisting or acknowledging success', async () => {
    const { manager, bleManager } = createFactoryResetManager();
    const persistResult = jest.fn();

    const reset = manager.bleFactoryReset(connectedDevice, 'grant-blob', persistResult);
    await flushPromises();
    const onData = bleManager.subscribeToCharacteristic.mock.calls[0][3];
    onData(Buffer.from([0x01]));

    await expect(reset).resolves.toEqual({
      success: false,
      error: 'invalid_token',
    });
    expect(persistResult).not.toHaveBeenCalled();
    expect(bleManager.writeCharacteristic).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a device wipe/storage failure from an invalid grant', async () => {
    const { manager, bleManager } = createFactoryResetManager();
    const persistResult = jest.fn();

    const reset = manager.bleFactoryReset(connectedDevice, 'grant-blob', persistResult);
    await flushPromises();
    const onData = bleManager.subscribeToCharacteristic.mock.calls[0][3];
    onData(Buffer.from([0x02]));

    await expect(reset).resolves.toEqual({
      success: false,
      error: 'storage_error',
    });
    expect(persistResult).not.toHaveBeenCalled();
    expect(bleManager.writeCharacteristic).toHaveBeenCalledTimes(1);
  });

  it.each([
    Buffer.from([0x00]),
    Buffer.from([0x00, 0x07]),
    Buffer.from([0x00, 0x07, 0x00, 0xff]),
  ])('rejects malformed reset success payload %p without sending receipt', async (payload) => {
    const { manager, bleManager } = createFactoryResetManager();
    const persistResult = jest.fn();

    const reset = manager.bleFactoryReset(connectedDevice, 'grant-blob', persistResult);
    await flushPromises();
    const onData = bleManager.subscribeToCharacteristic.mock.calls[0][3];
    onData(payload);

    await expect(reset).rejects.toMatchObject({
      code: 'INVALID_FACTORY_RESET_RESULT',
    });
    expect(persistResult).not.toHaveBeenCalled();
    expect(bleManager.writeCharacteristic).toHaveBeenCalledTimes(1);
  });

  it('rejects disconnect-before-result without sending a receipt', async () => {
    const { manager, bleManager, monitor } = createFactoryResetManager();
    const persistResult = jest.fn();

    const reset = manager.bleFactoryReset(connectedDevice, 'grant-blob', persistResult);
    await flushPromises();
    const onError = bleManager.subscribeToCharacteristic.mock.calls[0][4];
    onError(new Error('link lost'));

    await expect(reset).rejects.toMatchObject({ code: 'NOTIFICATION_ERROR' });
    expect(persistResult).not.toHaveBeenCalled();
    expect(bleManager.writeCharacteristic).toHaveBeenCalledTimes(1);
    expect(monitor.remove).toHaveBeenCalledTimes(1);
  });

  it('cancels the result subscription when the reset opcode write fails', async () => {
    const { manager, bleManager, monitor } = createFactoryResetManager();
    const persistResult = jest.fn();
    bleManager.writeCharacteristic.mockRejectedValueOnce(
      new Error('opcode write failed')
    );

    await expect(
      manager.bleFactoryReset(connectedDevice, 'grant-blob', persistResult)
    ).rejects.toThrow('opcode write failed');

    expect(persistResult).not.toHaveBeenCalled();
    expect(monitor.remove).toHaveBeenCalledTimes(1);
  });

  it('resumes a replayed WIPED result without re-sending grant or opcode 0x06', async () => {
    const { manager, bleManager } = createFactoryResetManager();
    const persistResult = jest.fn().mockResolvedValue(undefined);

    const resume = manager.resumeBleFactoryReset(connectedDevice, persistResult);
    await flushPromises();
    const onData = bleManager.subscribeToCharacteristic.mock.calls[0][3];
    onData(Buffer.from([0x00, 0x07, 0x00]));

    await expect(resume).resolves.toEqual({
      success: true,
      localRecordingsDeleted: 7,
    });
    expect(manager.writeGrant).not.toHaveBeenCalled();
    expect(bleManager.writeCharacteristic).toHaveBeenCalledTimes(1);
    expect(bleManager.writeCharacteristic.mock.calls[0][3]).toEqual(
      Buffer.from([DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK])
    );
  });
});

describe('DeviceManager device log subscriptions', () => {
  it('rejects overlapping subscriptions without replacing the pending or active owner', async () => {
    const { manager, bleManager, monitor } = createDeviceLogManager();
    let resolveStart!: () => void;
    const startWrite = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    bleManager.writeCharacteristic.mockImplementationOnce(() => startWrite);

    const firstSubscription = manager.subscribeToDeviceLogs(connectedDevice, jest.fn());
    const pendingOverlap = manager.subscribeToDeviceLogs(connectedDevice, jest.fn());
    const pendingOverlapResult = pendingOverlap.then(
      () => null,
      (error: Error) => error
    );

    resolveStart();
    const unsubscribe = await firstSubscription;
    const pendingOverlapError = await pendingOverlapResult;
    expect(pendingOverlapError).toMatchObject({
      code: 'ALREADY_SUBSCRIBED',
      deviceId: connectedDevice.id,
      message: `Device logs are already subscribed for device ${connectedDevice.id}`,
    });

    expect(bleManager.subscribeToCharacteristic).toHaveBeenCalledTimes(1);
    expect(bleManager.writeCharacteristic).toHaveBeenCalledTimes(1);
    expect(monitor.remove).not.toHaveBeenCalled();

    await expect(manager.subscribeToDeviceLogs(connectedDevice, jest.fn())).rejects.toMatchObject({
      code: 'ALREADY_SUBSCRIBED',
      deviceId: connectedDevice.id,
    });
    expect(bleManager.subscribeToCharacteristic).toHaveBeenCalledTimes(1);
    expect(bleManager.writeCharacteristic).toHaveBeenCalledTimes(1);
    expect(monitor.remove).not.toHaveBeenCalled();

    unsubscribe();

    expect(bleManager.writeCharacteristic).toHaveBeenCalledTimes(2);
    expect(bleManager.writeCharacteristic.mock.calls[1][3]).toEqual(
      Buffer.from([DEVICE_LOG_CMD_STOP])
    );
    expect(monitor.remove).toHaveBeenCalledTimes(1);
  });

  it('subscribes before Start and cleanup sends Stop once', async () => {
    const { manager, bleManager, monitor } = createDeviceLogManager();
    const callback = jest.fn();

    const unsubscribe = await manager.subscribeToDeviceLogs(connectedDevice, callback);

    const subscribeInvocation = bleManager.subscribeToCharacteristic.mock.invocationCallOrder[0];
    const startWriteInvocation = bleManager.writeCharacteristic.mock.invocationCallOrder[0];
    const startWriteData = bleManager.writeCharacteristic.mock.calls[0][3];
    expect(subscribeInvocation).toBeLessThan(startWriteInvocation);
    expect(bleManager.subscribeToCharacteristic).toHaveBeenCalledWith(
      connectedDevice.id,
      SERVICE_BOTA_DIAGNOSTICS,
      CHAR_DEVICE_LOG_DATA,
      expect.any(Function),
      expect.any(Function),
      { logNotifications: false }
    );
    expect(startWriteData).toEqual(Buffer.from([DEVICE_LOG_CMD_START]));

    const onData = bleManager.subscribeToCharacteristic.mock.calls[0][3];
    onData(Buffer.from([0, 0, 0, ...Buffer.from('ready\n')]));
    expect(callback).toHaveBeenCalledWith({ level: 'debug', message: 'ready', isBacklog: false });

    unsubscribe();
    unsubscribe();

    const stopWriteData = bleManager.writeCharacteristic.mock.calls[1][3];
    expect(monitor.remove).toHaveBeenCalledTimes(1);
    expect(stopWriteData).toEqual(Buffer.from([DEVICE_LOG_CMD_STOP]));
    expect(bleManager.writeCharacteristic).toHaveBeenCalledTimes(2);
  });

  it('removes the monitor and reports FEATURE_UNAVAILABLE when Start fails', async () => {
    const { manager, bleManager, monitor } = createDeviceLogManager();
    bleManager.writeCharacteristic.mockRejectedValueOnce(new Error('unsupported'));

    await expect(manager.subscribeToDeviceLogs(connectedDevice, jest.fn())).rejects.toMatchObject({
      code: 'FEATURE_UNAVAILABLE',
      deviceId: connectedDevice.id,
    });

    expect(monitor.remove).toHaveBeenCalledTimes(1);
    expect(manager.deviceLogSubscriptions.has(connectedDevice.id)).toBe(false);
  });

  it('removes an active log monitor on user disconnect without writing Stop', async () => {
    const { manager, bleManager, monitor } = createDeviceLogManager();
    await manager.subscribeToDeviceLogs(connectedDevice, jest.fn());
    bleManager.writeCharacteristic.mockClear();

    await manager.disconnect(connectedDevice);

    expect(monitor.remove).toHaveBeenCalledTimes(1);
    expect(bleManager.writeCharacteristic).not.toHaveBeenCalled();
  });

  it('removes an active log monitor after an unexpected disconnect without writing Stop', async () => {
    const { manager, bleManager, monitor } = createDeviceLogManager();
    manager.setupBleListeners();
    await manager.subscribeToDeviceLogs(connectedDevice, jest.fn());
    bleManager.writeCharacteristic.mockClear();

    bleManager.emit('deviceDisconnected', connectedDevice.id);

    expect(monitor.remove).toHaveBeenCalledTimes(1);
    expect(bleManager.writeCharacteristic).not.toHaveBeenCalled();
  });

  it('removes active log monitors on destroy without writing Stop', async () => {
    const { manager, bleManager, monitor } = createDeviceLogManager();
    await manager.subscribeToDeviceLogs(connectedDevice, jest.fn());
    bleManager.writeCharacteristic.mockClear();

    manager.destroy();

    expect(monitor.remove).toHaveBeenCalledTimes(1);
    expect(bleManager.writeCharacteristic).not.toHaveBeenCalled();
  });
});

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
      writeCharacteristic: jest.fn().mockResolvedValue(undefined),
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
    expect(bleManager.writeCharacteristic).toHaveBeenCalledWith(
      'ios-peripheral-id',
      SERVICE_BOTA_CONTROL,
      CHAR_TIME_SYNC,
      expect.objectContaining({ length: 8 })
    );
    expect(bleManager.writeCharacteristic.mock.invocationCallOrder[0]).toBeLessThan(
      manager.emit.mock.invocationCallOrder[1]
    );
    expect(result.serialNumber).toBe('EVFXXW67KP');
  });

  it('reads serial fresh for user-initiated connects even when BLE id is cached', async () => {
    const bleManager = {
      beginUserTransaction: jest.fn(() => jest.fn()),
      connect: jest.fn().mockResolvedValue(undefined),
      getMtu: jest.fn().mockResolvedValue(185),
      hasService: jest.fn().mockResolvedValue(true),
      disconnect: jest.fn().mockResolvedValue(undefined),
      writeCharacteristic: jest.fn().mockRejectedValue(new Error('not supported')),
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

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let result;
    try {
      result = await manager.connect({
        id: 'ios-peripheral-id',
        name: 'Bota Pin',
        deviceType: 'bota_pin',
        firmwareVersion: '0.0.0',
        pairingState: 'unpaired',
        rssi: -50,
        discoveredAt: new Date(),
      }, 'user');
    } finally {
      warn.mockRestore();
    }

    expect(manager.readSerialNumber).toHaveBeenCalledWith('ios-peripheral-id');
    expect(result.serialNumber).toBe('EVFXXW67KP');
    expect(bleManager.writeCharacteristic).toHaveBeenCalledWith(
      'ios-peripheral-id',
      SERVICE_BOTA_CONTROL,
      CHAR_TIME_SYNC,
      expect.objectContaining({ length: 8 })
    );
    expect(manager.reconnectRegistry.FY7DBSUMQK).toBeUndefined();
    expect(manager.reconnectRegistry.EVFXXW67KP.bleId).toBe('ios-peripheral-id');
  });
});
