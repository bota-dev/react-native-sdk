/**
 * Device Manager - Handles device discovery, connection, and provisioning
 */

import { Buffer } from 'buffer';
import { Subscription } from 'react-native-ble-plx';
import EventEmitter from 'eventemitter3';

import { getBleManager, BleManager } from '../ble/BleManager';
import {
  SERVICE_DEVICE_INFO,
  SERVICE_BOTA_PROVISIONING,
  SERVICE_BOTA_CONTROL,
  CHAR_SERIAL_NUMBER,
  CHAR_FIRMWARE_REVISION,
  CHAR_HARDWARE_REVISION,
  CHAR_PAIRING_STATE,
  CHAR_DEVICE_TOKEN,
  CHAR_API_ENDPOINT,
  CHAR_PROVISIONING_RESULT,
  CHAR_DEVICE_STATUS,
  CHAR_TIME_SYNC,
  API_ENDPOINT_PRODUCTION,
  API_ENDPOINT_SANDBOX,
  PROVISIONING_SUCCESS,
  PROVISIONING_INVALID_TOKEN,
  PROVISIONING_STORAGE_ERROR,
  PROVISIONING_CHUNK_ERROR,
  OPERATION_TIMEOUT,
} from '../ble/constants';
import {
  parsePairingState,
  parseDeviceStatus,
  createTimeSyncData,
} from '../ble/parsers';
import type {
  DiscoveredDevice,
  ConnectedDevice,
  DeviceStatus,
  ScanOptions,
  Environment,
  ProvisioningResult,
} from '../models/Device';
import type { DeviceManagerEvents } from '../models/Status';
import {
  DeviceError,
  ProvisioningError,
} from '../utils/errors';
import { logger } from '../utils/logger';

const log = logger.tag('DeviceManager');

/**
 * Device Manager class
 */
export class DeviceManager extends EventEmitter<DeviceManagerEvents> {
  private bleManager: BleManager;
  private connectedDevices: Map<string, ConnectedDevice> = new Map();
  private statusSubscriptions: Map<string, Subscription> = new Map();
  private isInitialized = false;

  constructor() {
    super();
    this.bleManager = getBleManager();
    this.setupBleListeners();
  }

  /**
   * Initialize the device manager
   */
  initialize(): void {
    if (this.isInitialized) {
      return;
    }
    this.isInitialized = true;
    log.info('DeviceManager initialized');
  }

  /**
   * Set up BLE event listeners
   */
  private setupBleListeners(): void {
    this.bleManager.on('deviceDiscovered', (device) => {
      this.emit('deviceDiscovered', device);
    });

    this.bleManager.on('deviceConnected', (deviceId) => {
      const device = this.connectedDevices.get(deviceId);
      if (device) {
        this.emit('deviceConnected', device);
      }
    });

    this.bleManager.on('deviceDisconnected', (deviceId, error) => {
      const device = this.connectedDevices.get(deviceId);
      if (device) {
        // Update connection state
        device.connectionState = 'disconnected';
      }
      this.connectedDevices.delete(deviceId);

      // Clean up status subscription
      this.statusSubscriptions.get(deviceId)?.remove();
      this.statusSubscriptions.delete(deviceId);

      this.emit('deviceDisconnected', deviceId, error);
    });
  }

  /**
   * Start scanning for Bota devices
   */
  async startScan(options: ScanOptions = {}): Promise<void> {
    log.info('Starting device scan', options as Record<string, unknown>);
    this.emit('scanStarted');

    try {
      await this.bleManager.startScan(options);
    } catch (error) {
      this.emit('scanError', error as Error);
      throw error;
    }
  }

  /**
   * Stop scanning for devices
   */
  stopScan(): void {
    log.info('Stopping device scan');
    this.bleManager.stopScan();
    this.emit('scanStopped');
  }

  /**
   * Get list of discovered devices
   */
  getDiscoveredDevices(): DiscoveredDevice[] {
    return this.bleManager.getDiscoveredDevices();
  }

  /**
   * Get list of connected devices
   */
  getConnectedDevices(): ConnectedDevice[] {
    return Array.from(this.connectedDevices.values());
  }

  /**
   * Connect to a discovered device
   */
  async connect(device: DiscoveredDevice): Promise<ConnectedDevice> {
    log.info('Connecting to device', { deviceId: device.id, name: device.name });

    // Check if already connected
    const existing = this.connectedDevices.get(device.id);
    if (existing && existing.connectionState === 'connected') {
      log.debug('Device already connected', { deviceId: device.id });
      return existing;
    }

    // Emit connecting state
    this.emit('connectionStateChanged', device.id, 'connecting');

    try {
      // Connect via BLE manager
      await this.bleManager.connect(device.id);

      // Read device information
      const serialNumber = await this.readSerialNumber(device.id);
      const firmwareVersion = await this.readFirmwareVersion(device.id);
      const hardwareRevision = await this.readHardwareRevision(device.id);
      const pairingState = await this.readPairingState(device.id);
      const mtu = await this.bleManager.getMtu(device.id);

      const connectedDevice: ConnectedDevice = {
        id: device.id,
        serialNumber,
        deviceType: device.deviceType,
        firmwareVersion,
        hardwareRevision,
        isProvisioned: pairingState === 'paired',
        connectionState: 'connected',
        mtu,
      };

      this.connectedDevices.set(device.id, connectedDevice);

      log.info('Device connected successfully', {
        deviceId: device.id,
        serialNumber,
        isProvisioned: connectedDevice.isProvisioned,
      });

      this.emit('connectionStateChanged', device.id, 'connected');

      return connectedDevice;
    } catch (error) {
      this.emit('connectionStateChanged', device.id, 'disconnected');
      throw error;
    }
  }

  /**
   * Disconnect from a device
   */
  async disconnect(device: ConnectedDevice): Promise<void> {
    log.info('Disconnecting from device', { deviceId: device.id });

    this.emit('connectionStateChanged', device.id, 'disconnecting');

    // Clean up status subscription
    this.statusSubscriptions.get(device.id)?.remove();
    this.statusSubscriptions.delete(device.id);

    await this.bleManager.disconnect(device.id);
    this.connectedDevices.delete(device.id);

    this.emit('connectionStateChanged', device.id, 'disconnected');
  }

  /**
   * Check if a device is connected
   */
  isConnected(deviceId: string): boolean {
    return this.bleManager.isConnected(deviceId);
  }

  /**
   * Provision a device with a token
   */
  async provision(
    device: ConnectedDevice,
    deviceToken: string,
    environment: Environment = 'production'
  ): Promise<void> {
    log.info('Provisioning device', {
      deviceId: device.id,
      environment,
    });

    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    // Check current pairing state
    const pairingState = await this.readPairingState(device.id);
    if (pairingState === 'paired') {
      log.warn('Device is already provisioned', { deviceId: device.id });
      throw ProvisioningError.alreadyProvisioned(device.id);
    }

    // Set up provisioning result listener
    const resultPromise = this.waitForProvisioningResult(device.id);

    try {
      // Write API endpoint
      await this.writeApiEndpoint(device.id, environment);

      // Write device token (chunked)
      await this.writeDeviceToken(device.id, deviceToken);

      // Wait for provisioning result
      const result = await resultPromise;

      if (!result.success) {
        switch (result.error) {
          case 'invalid_token':
            throw ProvisioningError.invalidToken(device.id);
          case 'storage_error':
            throw ProvisioningError.storageError(device.id);
          case 'chunk_error':
            throw ProvisioningError.chunkError(device.id);
          default:
            throw new ProvisioningError(
              'Provisioning failed',
              'PROVISIONING_FAILED',
              device.id
            );
        }
      }

      // Sync time to device
      await this.syncTime(device.id);

      // Update device state
      device.isProvisioned = true;

      log.info('Device provisioned successfully', { deviceId: device.id });
    } catch (error) {
      log.error('Provisioning failed', error as Error, { deviceId: device.id });
      throw error;
    }
  }

  /**
   * Check if a device is provisioned
   */
  async isProvisioned(device: ConnectedDevice): Promise<boolean> {
    const pairingState = await this.readPairingState(device.id);
    return pairingState === 'paired';
  }

  /**
   * Get device status
   */
  async getStatus(device: ConnectedDevice): Promise<DeviceStatus> {
    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    const data = await this.bleManager.readCharacteristic(
      device.id,
      SERVICE_BOTA_CONTROL,
      CHAR_DEVICE_STATUS
    );

    return parseDeviceStatus(data);
  }

  /**
   * Subscribe to device status updates
   */
  subscribeToStatus(
    device: ConnectedDevice,
    callback: (status: DeviceStatus) => void
  ): () => void {
    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    // Remove existing subscription
    this.statusSubscriptions.get(device.id)?.remove();

    const subscription = this.bleManager.subscribeToCharacteristic(
      device.id,
      SERVICE_BOTA_CONTROL,
      CHAR_DEVICE_STATUS,
      (data) => {
        try {
          const status = parseDeviceStatus(data);
          this.emit('deviceStatusUpdated', device.id, status);
          callback(status);
        } catch (error) {
          log.error('Failed to parse status update', error as Error);
        }
      },
      (error) => {
        log.error('Status subscription error', error);
      }
    );

    this.statusSubscriptions.set(device.id, subscription);

    return () => {
      subscription.remove();
      this.statusSubscriptions.delete(device.id);
    };
  }

  /**
   * Sync time to device
   */
  async syncTime(deviceId: string): Promise<void> {
    log.debug('Syncing time to device', { deviceId });

    const timeSyncData = createTimeSyncData();

    await this.bleManager.writeCharacteristic(
      deviceId,
      SERVICE_BOTA_CONTROL,
      CHAR_TIME_SYNC,
      timeSyncData
    );
  }

  // Private helper methods

  private async readSerialNumber(deviceId: string): Promise<string> {
    const data = await this.bleManager.readCharacteristic(
      deviceId,
      SERVICE_DEVICE_INFO,
      CHAR_SERIAL_NUMBER
    );
    return data.toString('utf8').replace(/\0/g, '');
  }

  private async readFirmwareVersion(deviceId: string): Promise<string> {
    const data = await this.bleManager.readCharacteristic(
      deviceId,
      SERVICE_DEVICE_INFO,
      CHAR_FIRMWARE_REVISION
    );
    return data.toString('utf8').replace(/\0/g, '');
  }

  private async readHardwareRevision(deviceId: string): Promise<string | undefined> {
    try {
      const data = await this.bleManager.readCharacteristic(
        deviceId,
        SERVICE_DEVICE_INFO,
        CHAR_HARDWARE_REVISION
      );
      return data.toString('utf8').replace(/\0/g, '');
    } catch {
      return undefined;
    }
  }

  private async readPairingState(deviceId: string): Promise<'unpaired' | 'pairing' | 'paired' | 'error'> {
    const data = await this.bleManager.readCharacteristic(
      deviceId,
      SERVICE_BOTA_PROVISIONING,
      CHAR_PAIRING_STATE
    );

    if (data.length < 1) {
      return 'unpaired';
    }

    return parsePairingState(data[0]);
  }

  private async writeApiEndpoint(
    deviceId: string,
    environment: Environment
  ): Promise<void> {
    const endpointByte =
      environment === 'production' ? API_ENDPOINT_PRODUCTION : API_ENDPOINT_SANDBOX;

    await this.bleManager.writeCharacteristic(
      deviceId,
      SERVICE_BOTA_PROVISIONING,
      CHAR_API_ENDPOINT,
      Buffer.from([endpointByte])
    );
  }

  private async writeDeviceToken(
    deviceId: string,
    token: string
  ): Promise<void> {
    const mtu = await this.bleManager.getMtu(deviceId);
    const maxChunkSize = mtu - 5; // Account for BLE overhead + chunk header

    const tokenBuffer = Buffer.from(token, 'utf8');
    const totalChunks = Math.ceil(tokenBuffer.length / (maxChunkSize - 2));

    log.debug('Writing device token', {
      deviceId,
      tokenLength: token.length,
      totalChunks,
      mtu,
    });

    for (let i = 0; i < totalChunks; i++) {
      const start = i * (maxChunkSize - 2);
      const end = Math.min(start + (maxChunkSize - 2), tokenBuffer.length);
      const chunkData = tokenBuffer.slice(start, end);

      // Create chunk with header: [chunk_index, total_chunks, ...data]
      const chunk = Buffer.alloc(2 + chunkData.length);
      chunk.writeUInt8(i, 0);
      chunk.writeUInt8(totalChunks, 1);
      chunkData.copy(chunk, 2);

      await this.bleManager.writeCharacteristic(
        deviceId,
        SERVICE_BOTA_PROVISIONING,
        CHAR_DEVICE_TOKEN,
        chunk
      );

      log.debug('Wrote token chunk', { chunk: i + 1, total: totalChunks });
    }
  }

  private waitForProvisioningResult(deviceId: string): Promise<ProvisioningResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.remove();
        reject(ProvisioningError.timeout(deviceId));
      }, OPERATION_TIMEOUT);

      const subscription = this.bleManager.subscribeToCharacteristic(
        deviceId,
        SERVICE_BOTA_PROVISIONING,
        CHAR_PROVISIONING_RESULT,
        (data) => {
          clearTimeout(timeout);
          subscription.remove();

          if (data.length < 1) {
            resolve({ success: false, error: 'unknown' });
            return;
          }

          const resultCode = data[0];
          switch (resultCode) {
            case PROVISIONING_SUCCESS:
              resolve({ success: true });
              break;
            case PROVISIONING_INVALID_TOKEN:
              resolve({ success: false, error: 'invalid_token' });
              break;
            case PROVISIONING_STORAGE_ERROR:
              resolve({ success: false, error: 'storage_error' });
              break;
            case PROVISIONING_CHUNK_ERROR:
              resolve({ success: false, error: 'chunk_error' });
              break;
            default:
              resolve({ success: false, error: 'unknown' });
          }
        },
        (error) => {
          clearTimeout(timeout);
          subscription.remove();
          reject(new ProvisioningError(
            `Provisioning notification error: ${error.message}`,
            'NOTIFICATION_ERROR',
            deviceId,
            error
          ));
        }
      );
    });
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    log.info('Destroying DeviceManager');

    // Clean up all status subscriptions
    for (const sub of this.statusSubscriptions.values()) {
      sub.remove();
    }
    this.statusSubscriptions.clear();

    this.connectedDevices.clear();
    this.removeAllListeners();
    this.isInitialized = false;
  }
}
