/**
 * BLE Manager - Abstraction layer over react-native-ble-plx
 */

import {
  BleManager as RNBleManager,
  Device,
  State,
  Subscription,
  BleError,
} from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import EventEmitter from 'eventemitter3';

import {
  // DEVICE_NAME_PREFIX, // TODO: Re-enable after debugging
  DEFAULT_MTU,
  MAX_MTU,
  CONNECTION_TIMEOUT,
  SCAN_TIMEOUT,
} from './constants';
import type {
  DiscoveredDevice,
  DeviceType,
  PairingState,
  ScanOptions,
} from '../models/Device';
import { BluetoothError, DeviceError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  parseDeviceType,
  parsePairingState,
  parseFirmwareVersion,
} from './parsers';

const log = logger.tag('BleManager');

/**
 * Events emitted by BleManager
 */
interface BleManagerEvents {
  stateChange: (state: State) => void;
  deviceDiscovered: (device: DiscoveredDevice) => void;
  deviceConnected: (deviceId: string) => void;
  deviceDisconnected: (deviceId: string, error?: Error) => void;
}

/**
 * BLE Manager class - singleton wrapper around react-native-ble-plx
 */
export class BleManager extends EventEmitter<BleManagerEvents> {
  private manager: RNBleManager;
  private stateSubscription: Subscription | null = null;
  private disconnectSubscriptions: Map<string, Subscription> = new Map();
  private connectedDevices: Map<string, Device> = new Map();
  private discoveredDevices: Map<string, DiscoveredDevice> = new Map();
  private isScanning = false;
  private cachedState: State = State.Unknown;

  constructor() {
    super();
    this.manager = new RNBleManager();
    this.setupStateListener();
  }

  /**
   * Set up Bluetooth state change listener
   */
  private setupStateListener(): void {
    this.stateSubscription = this.manager.onStateChange((state) => {
      log.debug('Bluetooth state changed', { state });
      this.cachedState = state;
      this.emit('stateChange', state);
    }, true);
  }

  /**
   * Get current Bluetooth state
   */
  async getState(): Promise<State> {
    const state = await this.manager.state();
    this.cachedState = state;
    return state;
  }

  /**
   * Get cached Bluetooth state (synchronous)
   */
  getCachedState(): State {
    return this.cachedState;
  }

  /**
   * Check if Bluetooth is ready for operations
   */
  async isReady(): Promise<boolean> {
    const state = await this.getState();
    return state === State.PoweredOn;
  }

  /**
   * Wait for Bluetooth to be ready
   */
  async waitForReady(timeoutMs: number = 10000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const state = await this.getState();

      if (state === State.PoweredOn) {
        return;
      }

      if (state === State.Unsupported) {
        throw BluetoothError.unavailable();
      }

      if (state === State.Unauthorized) {
        throw BluetoothError.unauthorized();
      }

      if (state === State.PoweredOff) {
        throw BluetoothError.poweredOff();
      }

      // Wait a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new BluetoothError('Bluetooth did not become ready in time', 'TIMEOUT');
  }

  /**
   * Start scanning for Bota devices
   */
  async startScan(options: ScanOptions = {}): Promise<void> {
    if (this.isScanning) {
      log.warn('Scan already in progress');
      return;
    }

    await this.waitForReady();

    const {
      timeout = SCAN_TIMEOUT,
      deviceTypes,
      pairingState,
      minRssi,
      allowDuplicates = false,
    } = options;

    log.info('Starting BLE scan', { timeout, deviceTypes, pairingState });

    this.discoveredDevices.clear();
    this.isScanning = true;

    // Set up timeout
    const scanTimeout = setTimeout(() => {
      this.stopScan();
    }, timeout);

    // Start scanning
    this.manager.startDeviceScan(
      null, // Scan all services
      { allowDuplicates },
      (error, device) => {
        if (error) {
          log.error('Scan error', error);
          this.stopScan();
          clearTimeout(scanTimeout);
          return;
        }

        // Log all devices for debugging
        if (device?.name) {
          log.info('BLE device found', { name: device.name, id: device.id, rssi: device.rssi });
        }

        // For now, show all devices with a name (comment out Bota filter for debugging)
        if (!device || !device.name) {
          return;
        }
        // TODO: Re-enable this filter after debugging
        // if (!device.name.startsWith(DEVICE_NAME_PREFIX)) {
        //   return;
        // }

        // Parse device information from advertisement
        const discovered = this.parseDiscoveredDevice(device);
        if (!discovered) {
          return;
        }

        // Apply filters
        if (deviceTypes && !deviceTypes.includes(discovered.deviceType)) {
          return;
        }

        if (pairingState && discovered.pairingState !== pairingState) {
          return;
        }

        if (minRssi !== undefined && discovered.rssi < minRssi) {
          return;
        }

        // Check for duplicates
        const existingDevice = this.discoveredDevices.get(device.id);
        if (existingDevice && !allowDuplicates) {
          // Update RSSI
          existingDevice.rssi = discovered.rssi;
          return;
        }

        // Store and emit
        this.discoveredDevices.set(device.id, discovered);
        log.debug('Device discovered', {
          id: discovered.id,
          name: discovered.name,
          type: discovered.deviceType,
        });
        this.emit('deviceDiscovered', discovered);
      }
    );
  }

  /**
   * Stop scanning for devices
   */
  stopScan(): void {
    if (!this.isScanning) {
      return;
    }

    log.info('Stopping BLE scan');
    this.manager.stopDeviceScan();
    this.isScanning = false;
  }

  /**
   * Get list of discovered devices
   */
  getDiscoveredDevices(): DiscoveredDevice[] {
    return Array.from(this.discoveredDevices.values());
  }

  /**
   * Parse a discovered device from BLE advertisement data
   */
  private parseDiscoveredDevice(device: Device): DiscoveredDevice | null {
    if (!device.name) {
      return null;
    }

    // Parse manufacturer data if available
    let deviceType: DeviceType = 'bota_pin';
    let firmwareVersion = '0.0.0';
    let pairingState: PairingState = 'unpaired';
    let manufacturerData: Uint8Array | undefined;

    if (device.manufacturerData) {
      try {
        manufacturerData = Buffer.from(device.manufacturerData, 'base64');
        if (manufacturerData.length >= 4) {
          deviceType = parseDeviceType(manufacturerData[0]);
          firmwareVersion = parseFirmwareVersion(
            manufacturerData[1],
            manufacturerData[2]
          );
          pairingState = parsePairingState(manufacturerData[3]);
        }
      } catch (e) {
        log.warn('Failed to parse manufacturer data', { deviceId: device.id });
      }
    } else {
      // Infer device type from name
      if (device.name.includes('Pin4G')) {
        deviceType = 'bota_pin_4g';
      } else if (device.name.includes('Note')) {
        deviceType = 'bota_note';
      } else if (device.name.includes('Pin')) {
        deviceType = 'bota_pin';
      }
    }

    return {
      id: device.id,
      name: device.name,
      deviceType,
      firmwareVersion,
      pairingState,
      rssi: device.rssi ?? -100,
      manufacturerData,
      discoveredAt: new Date(),
    };
  }

  /**
   * Connect to a device
   */
  async connect(deviceId: string): Promise<Device> {
    log.info('Connecting to device', { deviceId });

    // Check if already connected
    if (this.connectedDevices.has(deviceId)) {
      log.debug('Device already connected', { deviceId });
      return this.connectedDevices.get(deviceId)!;
    }

    try {
      // Connect with timeout
      const device = await this.manager.connectToDevice(deviceId, {
        timeout: CONNECTION_TIMEOUT,
        requestMTU: MAX_MTU,
      });

      log.debug('Device connected, discovering services', { deviceId });

      // Discover services and characteristics
      await device.discoverAllServicesAndCharacteristics();

      // Store connected device
      this.connectedDevices.set(deviceId, device);

      // Set up disconnect listener
      const disconnectSub = device.onDisconnected((error, disconnectedDevice) => {
        log.info('Device disconnected', {
          deviceId: disconnectedDevice.id,
          error: error?.message,
        });
        this.connectedDevices.delete(disconnectedDevice.id);
        this.disconnectSubscriptions.get(disconnectedDevice.id)?.remove();
        this.disconnectSubscriptions.delete(disconnectedDevice.id);
        this.emit(
          'deviceDisconnected',
          disconnectedDevice.id,
          error ? new Error(error.message) : undefined
        );
      });
      this.disconnectSubscriptions.set(deviceId, disconnectSub);

      this.emit('deviceConnected', deviceId);
      return device;
    } catch (error) {
      const bleError = error as BleError;
      log.error('Connection failed', new Error(bleError.message), { deviceId });
      throw DeviceError.connectionFailed(deviceId, new Error(bleError.message));
    }
  }

  /**
   * Disconnect from a device
   */
  async disconnect(deviceId: string): Promise<void> {
    log.info('Disconnecting from device', { deviceId });

    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      log.warn('Device not found in connected devices', { deviceId });
      return;
    }

    try {
      await device.cancelConnection();
    } catch (error) {
      const bleError = error as BleError;
      log.warn('Disconnect error (may be expected)', { error: bleError.message });
    }

    this.connectedDevices.delete(deviceId);
    this.disconnectSubscriptions.get(deviceId)?.remove();
    this.disconnectSubscriptions.delete(deviceId);
  }

  /**
   * Check if a device is connected
   */
  isConnected(deviceId: string): boolean {
    return this.connectedDevices.has(deviceId);
  }

  /**
   * Get a connected device
   */
  getConnectedDevice(deviceId: string): Device | undefined {
    return this.connectedDevices.get(deviceId);
  }

  /**
   * Get negotiated MTU for a device
   */
  async getMtu(deviceId: string): Promise<number> {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      return DEFAULT_MTU;
    }

    try {
      // mtu is a property, not a method in react-native-ble-plx
      return device.mtu ?? DEFAULT_MTU;
    } catch {
      return DEFAULT_MTU;
    }
  }

  /**
   * Read a characteristic value
   */
  async readCharacteristic(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string
  ): Promise<Buffer> {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      throw DeviceError.notConnected(deviceId);
    }

    try {
      const characteristic = await device.readCharacteristicForService(
        serviceUuid,
        characteristicUuid
      );

      if (!characteristic.value) {
        return Buffer.alloc(0);
      }

      return Buffer.from(characteristic.value, 'base64');
    } catch (error) {
      const bleError = error as BleError;
      log.error('Read characteristic failed', new Error(bleError.message), {
        deviceId,
        serviceUuid,
        characteristicUuid,
      });
      throw new DeviceError(
        `Failed to read characteristic: ${bleError.message}`,
        'READ_FAILED',
        deviceId,
        new Error(bleError.message)
      );
    }
  }

  /**
   * Write a characteristic value
   */
  async writeCharacteristic(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
    data: Buffer,
    withResponse: boolean = true
  ): Promise<void> {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      throw DeviceError.notConnected(deviceId);
    }

    const base64Data = data.toString('base64');

    try {
      if (withResponse) {
        await device.writeCharacteristicWithResponseForService(
          serviceUuid,
          characteristicUuid,
          base64Data
        );
      } else {
        await device.writeCharacteristicWithoutResponseForService(
          serviceUuid,
          characteristicUuid,
          base64Data
        );
      }
    } catch (error) {
      const bleError = error as BleError;
      log.error('Write characteristic failed', new Error(bleError.message), {
        deviceId,
        serviceUuid,
        characteristicUuid,
      });
      throw new DeviceError(
        `Failed to write characteristic: ${bleError.message}`,
        'WRITE_FAILED',
        deviceId,
        new Error(bleError.message)
      );
    }
  }

  /**
   * Subscribe to characteristic notifications
   */
  subscribeToCharacteristic(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
    onData: (data: Buffer) => void,
    onError?: (error: Error) => void
  ): Subscription {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      throw DeviceError.notConnected(deviceId);
    }

    return device.monitorCharacteristicForService(
      serviceUuid,
      characteristicUuid,
      (error, characteristic) => {
        if (error) {
          // Handle subscription cancellation gracefully - this is expected when we remove the subscription
          const errorMessage = error.message || 'Unknown BLE error';
          const isCancelled = errorMessage.includes('cancelled') ||
                              errorMessage.includes('disconnected') ||
                              error.errorCode === 2; // BleErrorCode.OperationCancelled

          if (!isCancelled) {
            log.error('Notification error', new Error(errorMessage), {
              deviceId,
              characteristicUuid,
            });
            onError?.(new Error(errorMessage));
          } else {
            log.debug('Subscription ended', { deviceId, characteristicUuid, reason: errorMessage });
          }
          return;
        }

        if (characteristic?.value) {
          const data = Buffer.from(characteristic.value, 'base64');
          onData(data);
        }
      }
    );
  }

  /**
   * Destroy the BLE manager and clean up resources
   */
  destroy(): void {
    log.info('Destroying BLE manager');

    this.stopScan();

    // Remove all disconnect subscriptions
    for (const sub of this.disconnectSubscriptions.values()) {
      sub.remove();
    }
    this.disconnectSubscriptions.clear();

    // Disconnect all devices
    for (const deviceId of this.connectedDevices.keys()) {
      this.disconnect(deviceId).catch(() => {});
    }
    this.connectedDevices.clear();

    // Remove state subscription
    this.stateSubscription?.remove();
    this.stateSubscription = null;

    // Destroy the manager
    this.manager.destroy();

    this.removeAllListeners();
  }
}

/**
 * Singleton instance
 */
let instance: BleManager | null = null;

/**
 * Get or create the BLE manager singleton
 */
export function getBleManager(): BleManager {
  if (!instance) {
    instance = new BleManager();
  }
  return instance;
}

/**
 * Reset the BLE manager singleton (for testing)
 */
export function resetBleManager(): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}
