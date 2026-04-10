/**
 * Device Manager - Handles device discovery, connection, and provisioning
 */

import { Buffer } from 'buffer';
import { State, Subscription } from 'react-native-ble-plx';
import EventEmitter from 'eventemitter3';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getBleManager, BleManager } from '../ble/BleManager';
import {
  SERVICE_DEVICE_INFO,
  SERVICE_BOTA_PROVISIONING,
  SERVICE_BOTA_CONTROL,
  SERVICE_BOTA_WIFI_CONFIG,
  CHAR_SERIAL_NUMBER,
  CHAR_FIRMWARE_REVISION,
  CHAR_HARDWARE_REVISION,
  CHAR_PAIRING_STATE,
  CHAR_DEVICE_TOKEN,
  CHAR_API_ENDPOINT,
  CHAR_PROVISIONING_RESULT,
  CHAR_DEVICE_STATUS,
  CHAR_RECORDING_CONTROL,
  CHAR_RECORDING_STATUS,
  CHAR_TIME_SYNC,
  CHAR_WIFI_GRANT,
  CHAR_WIFI_CREDENTIAL,
  CHAR_WIFI_STATUS,
  API_ENDPOINT_DEV,
  API_ENDPOINT_PROD,
  PROVISIONING_SUCCESS,
  PROVISIONING_INVALID_TOKEN,
  PROVISIONING_STORAGE_ERROR,
  PROVISIONING_CHUNK_ERROR,
  OPERATION_TIMEOUT,
  RECORDING_CMD_GRANT_START,
  RECORDING_CMD_GRANT_STOP,
  RECORDING_RESULT_SUCCESS,
  RECORDING_RESULT_ALREADY_RECORDING,
  RECORDING_RESULT_NOT_RECORDING,
  RECORDING_RESULT_INVALID_GRANT,
  RECORDING_RESULT_GRANT_EXPIRED,
  CHAR_DEVICE_COMMAND,
  DEVICE_CMD_FACTORY_RESET,
  CHAR_WIFI_SCAN,
  CHAR_DEVICE_SETTINGS,
  WIFI_SCAN_TIMEOUT,
} from '../ble/constants';
import {
  parsePairingState,
  parseDeviceStatus,
  createTimeSyncData,
  parseWiFiStatusInfo,
  parseWiFiConfigResult,
  createWiFiGrantPacket,
  createWiFiScanCommand,
  parseWiFiScanResult,
  serializeConnectionSettings,
  parseConnectionSettings,
} from '../ble/parsers';
import type {
  DiscoveredDevice,
  ConnectedDevice,
  DeviceType,
  DeviceStatus,
  ScanOptions,
  ReconnectOptions,
  Environment,
  ProvisioningResult,
  RecordingState,
  // RecordingCommand, // TODO: Re-enable when used
  StartRecordingOptions,
  StopRecordingOptions,
  WiFiConfigGrant,
  WiFiCredentials,
  WiFiConfigResult,
  WiFiStatusInfo,
  DeviceWiFiScanResult,
  DeviceConnectionSettings,
} from '../models/Device';
import type { DeviceManagerEvents } from '../models/Status';
import {
  DeviceError,
  ProvisioningError,
} from '../utils/errors';
import { logger } from '../utils/logger';
// TODO: Re-enable crypto imports once firmware mbedtls boot crash is resolved
// import { deriveSessionKey, encryptWiFiCredentials, formatWiFiCredentialPacket } from '../utils/crypto';

const log = logger.tag('DeviceManager');

const RECONNECT_REGISTRY_KEY = '@bota_sdk:reconnect_registry';
const DEFAULT_RECONNECT_SCAN_TIMEOUT = 10000; // 10 seconds

/** Stored info for reconnecting to a previously paired device */
interface ReconnectInfo {
  bleId: string;
  bleName: string;
  deviceType: DeviceType;
}

/**
 * Device Manager class
 */
export class DeviceManager extends EventEmitter<DeviceManagerEvents> {
  private bleManager: BleManager;
  private connectedDevices: Map<string, ConnectedDevice> = new Map();
  private statusSubscriptions: Map<string, Subscription> = new Map();
  private reconnectRegistry: Record<string, ReconnectInfo> = {};
  // Cache of last known recording state per device (populated from status notifications)
  private recordingStateCache: Map<string, RecordingState> = new Map();
  // Pending promise set while a recording command is in-flight — bridges the race where
  // the BLE heartbeat arrives before the recording status notification.
  private recordingStatePending: Map<string, Promise<RecordingState>> = new Map();
  private isInitialized = false;

  // Auto-reconnect state
  private autoReconnectEnabled = false;
  private autoReconnectSerial: string | null = null;
  private autoReconnectTimer: ReturnType<typeof setInterval> | null = null;
  private autoReconnectAttempting = false;
  private userDisconnected = false;

  constructor() {
    super();
    this.bleManager = getBleManager();
    this.setupBleListeners();
  }

  /**
   * Initialize the device manager
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    await this.loadReconnectRegistry();
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
      this.recordingStateCache.delete(deviceId);

      // Clean up status subscription
      this.statusSubscriptions.get(deviceId)?.remove();
      this.statusSubscriptions.delete(deviceId);

      this.emit('deviceDisconnected', deviceId, error);

      // Start auto-reconnect if enabled and not user-initiated
      if (this.autoReconnectEnabled && !this.userDisconnected) {
        this.startAutoReconnectLoop();
      }
    });

    // Auto-reconnect when Bluetooth powers back on
    let prevState: State = State.Unknown;
    this.bleManager.on('stateChange', (state) => {
      if (state === State.PoweredOn && prevState !== State.PoweredOn) {
        log.info('Bluetooth powered on — emitting bluetoothReady');
        this.emit('bluetoothReady');
        // Trigger auto-reconnect
        if (this.autoReconnectEnabled && this.autoReconnectSerial && !this.userDisconnected) {
          this.startAutoReconnectLoop();
        }
      }
      prevState = state;
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

      // Detect capabilities from discovered BLE services
      const hasWifiService = await this.bleManager.hasService(device.id, SERVICE_BOTA_WIFI_CONFIG);

      const connectedDevice: ConnectedDevice = {
        id: device.id,
        serialNumber,
        deviceType: device.deviceType,
        firmwareVersion,
        hardwareRevision,
        isProvisioned: pairingState === 'paired',
        connectionState: 'connected',
        mtu,
        capabilities: {
          bleSync: true,
          wifiUpload: hasWifiService,
          lteUpload: device.deviceType === 'bota_pin_4g',
          remoteRecord: true,
        },
      };

      this.connectedDevices.set(device.id, connectedDevice);

      // Persist reconnect info for future reconnect() calls
      this.reconnectRegistry[serialNumber] = {
        bleId: device.id,
        bleName: device.name,
        deviceType: device.deviceType,
      };
      this.saveReconnectRegistry().catch(() => {});

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
   * Disconnect from a device (user-initiated)
   */
  async disconnect(device: ConnectedDevice): Promise<void> {
    log.info('Disconnecting from device', { deviceId: device.id });

    this.userDisconnected = true;
    this.stopAutoReconnectLoop();

    this.emit('connectionStateChanged', device.id, 'disconnecting');

    // Clean up status subscription
    this.statusSubscriptions.get(device.id)?.remove();
    this.statusSubscriptions.delete(device.id);

    await this.bleManager.disconnect(device.id);
    this.connectedDevices.delete(device.id);

    this.emit('connectionStateChanged', device.id, 'disconnected');
  }

  // ============================================================================
  // Auto-Reconnect
  // ============================================================================

  /**
   * Enable auto-reconnect for a device by serial number.
   * When enabled, the SDK will automatically attempt to reconnect when:
   * - The device disconnects unexpectedly (out of range, power loss)
   * - Bluetooth is toggled off and back on
   *
   * Auto-reconnect is paused when disconnect() is called (user-initiated).
   * Call enableAutoReconnect() again or reconnect() to resume.
   */
  enableAutoReconnect(serialNumber: string): void {
    this.autoReconnectSerial = serialNumber;
    this.autoReconnectEnabled = true;
    this.userDisconnected = false;
    log.info('Auto-reconnect enabled', { serialNumber });
  }

  /**
   * Disable auto-reconnect
   */
  disableAutoReconnect(): void {
    this.autoReconnectEnabled = false;
    this.autoReconnectSerial = null;
    this.userDisconnected = false;
    this.stopAutoReconnectLoop();
    log.info('Auto-reconnect disabled');
  }

  private startAutoReconnectLoop(): void {
    if (this.autoReconnectTimer || !this.autoReconnectSerial) return;

    log.info('Starting auto-reconnect loop', { serialNumber: this.autoReconnectSerial });
    this.emit('bluetoothReady'); // Signal apps that reconnection is starting

    const attempt = async () => {
      if (!this.autoReconnectEnabled || !this.autoReconnectSerial || this.userDisconnected) {
        this.stopAutoReconnectLoop();
        return;
      }

      // Already connected?
      for (const device of this.connectedDevices.values()) {
        if (device.serialNumber === this.autoReconnectSerial && device.connectionState === 'connected') {
          log.debug('Auto-reconnect: already connected');
          this.stopAutoReconnectLoop();
          return;
        }
      }

      // Bluetooth available?
      if (this.bleManager.getCachedState() !== State.PoweredOn) {
        return; // Wait for next tick
      }

      if (this.autoReconnectAttempting) return;
      this.autoReconnectAttempting = true;

      try {
        log.debug('Auto-reconnect: attempting', { serialNumber: this.autoReconnectSerial });
        await this.reconnect(this.autoReconnectSerial, { scanTimeout: 5000 });
        log.info('Auto-reconnect: success');
        this.stopAutoReconnectLoop();
      } catch {
        log.debug('Auto-reconnect: failed, will retry');
      } finally {
        this.autoReconnectAttempting = false;
      }
    };

    // Attempt immediately, then retry every 3 seconds
    attempt();
    this.autoReconnectTimer = setInterval(attempt, 3000);
  }

  private stopAutoReconnectLoop(): void {
    if (this.autoReconnectTimer) {
      clearInterval(this.autoReconnectTimer);
      this.autoReconnectTimer = null;
    }
  }

  /**
   * Reconnect to a previously paired device by serial number.
   *
   * The SDK stores the BLE name and peripheral ID from the initial pairing.
   * This method scans for nearby devices, matches by stored BLE name,
   * stored peripheral ID, or Bota-prefix fallback, then connects.
   *
   * @param serialNumber - Serial number of the device to reconnect to
   * @param options - Optional reconnection options
   * @returns The connected device
   * @throws DeviceError.notFound if no matching device is found during scan
   */
  async reconnect(
    serialNumber: string,
    options?: ReconnectOptions
  ): Promise<ConnectedDevice> {
    const scanTimeout = options?.scanTimeout ?? DEFAULT_RECONNECT_SCAN_TIMEOUT;

    log.info('Reconnecting to device', { serialNumber });

    // Check if already connected by serial number
    for (const device of this.connectedDevices.values()) {
      if (device.serialNumber === serialNumber && device.connectionState === 'connected') {
        log.debug('Device already connected', { serialNumber });
        return device;
      }
    }

    // Look up stored reconnect info
    const info = this.reconnectRegistry[serialNumber];
    const storedName = info?.bleName;
    const storedId = info?.bleId;

    log.debug('Reconnect info', { serialNumber, storedName: storedName ?? '(none)', storedId: storedId ?? '(none)' });

    // Scan for devices
    await this.startScan({ timeout: scanTimeout });
    await new Promise((resolve) => setTimeout(resolve, scanTimeout));

    const discovered = this.getDiscoveredDevices();
    log.debug('Reconnect scan done', {
      count: discovered.length,
      devices: discovered.map((d) => `${d.name}(${d.id})`).join(', '),
    });

    // Match by: 1) stored BLE name, 2) stored peripheral ID, 3) any Bota-prefix device
    const target =
      discovered.find((d) => storedName && d.name === storedName) ||
      discovered.find((d) => storedId && d.id === storedId) ||
      discovered.find((d) => d.name?.startsWith('Bota'));

    // Stop scan before connecting — on iOS a running scan can cancel the connection
    try { this.stopScan(); } catch { /* ignore */ }

    if (!target) {
      log.warn('No matching device found for reconnection', { serialNumber });
      throw DeviceError.notFound(serialNumber);
    }

    log.info('Matched device for reconnection', { serialNumber, name: target.name, id: target.id });
    return this.connect(target);
  }

  /**
   * Send factory reset command to a device.
   * Clears stored token and recordings on the device.
   * Device returns to unpaired state after this.
   */
  async factoryReset(device: ConnectedDevice): Promise<void> {
    log.info('Sending factory reset to device', { deviceId: device.id });

    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    const resultPromise = this.waitForProvisioningResult(device.id);

    await this.bleManager.writeCharacteristic(
      device.id,
      SERVICE_BOTA_CONTROL,
      CHAR_DEVICE_COMMAND,
      Buffer.from([DEVICE_CMD_FACTORY_RESET])
    );

    try {
      await resultPromise;
    } catch {
      // Timeout is acceptable — device may disconnect before responding
      log.warn('Factory reset result not received (device may have disconnected)');
    }

    log.info('Factory reset sent', { deviceId: device.id });
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

    // Check current pairing state — skip if already provisioned
    const pairingState = await this.readPairingState(device.id);
    if (pairingState === 'paired') {
      log.info('Device is already provisioned, skipping', { deviceId: device.id });
      device.isProvisioned = true;
      return;
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
        log.debug(`Status subscription ended: ${error?.message}`);
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

  /**
   * Read connection settings from device via BLE DEVICE_SETTINGS characteristic.
   * Returns parsed settings (enabled connections + network preference).
   */
  async readConnectionSettings(device: ConnectedDevice): Promise<DeviceConnectionSettings> {
    log.debug('Reading connection settings', { deviceId: device.id });

    const data = await this.bleManager.readCharacteristic(
      device.id,
      SERVICE_BOTA_PROVISIONING,
      CHAR_DEVICE_SETTINGS
    );

    return parseConnectionSettings(data);
  }

  /**
   * Write connection settings to device via BLE DEVICE_SETTINGS characteristic.
   * Serializes settings to 8-byte binary format.
   */
  async writeConnectionSettings(device: ConnectedDevice, settings: DeviceConnectionSettings): Promise<void> {
    if (!this.isConnected(device.id)) {
      log.debug('Skipping writeConnectionSettings — device not connected', { deviceId: device.id });
      return;
    }

    log.debug('Writing connection settings', { deviceId: device.id, settings });

    const data = serializeConnectionSettings(settings);

    await this.bleManager.writeCharacteristic(
      device.id,
      SERVICE_BOTA_PROVISIONING,
      CHAR_DEVICE_SETTINGS,
      data
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
      environment === 'production' ? API_ENDPOINT_PROD : API_ENDPOINT_DEV;

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

  // ============================================================================
  // Remote Recording Control (MVP)
  // ============================================================================

  /**
   * Request to start recording on a device remotely.
   * This writes a signed grant token to the device via BLE.
   *
   * @param device - Connected device
   * @param grantToken - Signed JWT grant token from backend
   * @param _options - Optional recording options (for future use)
   * @returns Recording command result
   */
  async requestStartRecording(
    device: ConnectedDevice,
    grantToken: string,
    _options?: StartRecordingOptions
  ): Promise<{ success: boolean; error?: string }> {
    log.info('Requesting start recording', { deviceId: device.id });

    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    try {
      // Create payload: [opcode, grant_token_bytes]
      const tokenBuffer = Buffer.from(grantToken, 'utf8');
      const payload = Buffer.alloc(1 + tokenBuffer.length);
      payload.writeUInt8(RECORDING_CMD_GRANT_START, 0);
      tokenBuffer.copy(payload, 1);

      // Set up response listener before writing
      const resultPromise = this.waitForRecordingResult(device.id);

      // Write to recording control characteristic
      await this.bleManager.writeCharacteristic(
        device.id,
        SERVICE_BOTA_CONTROL,
        CHAR_RECORDING_CONTROL,
        payload
      );

      // Wait for device response
      const result = await resultPromise;

      log.info('Start recording result', { deviceId: device.id, result });

      return result;
    } catch (error) {
      log.error('Failed to start recording', error as Error, { deviceId: device.id });
      throw error;
    }
  }

  /**
   * Request to stop recording on a device remotely.
   * This writes a signed grant token to the device via BLE.
   *
   * @param device - Connected device
   * @param grantToken - Signed JWT grant token from backend
   * @param _options - Optional stop options (for future use)
   * @returns Recording command result
   */
  async requestStopRecording(
    device: ConnectedDevice,
    grantToken: string,
    _options?: StopRecordingOptions
  ): Promise<{ success: boolean; error?: string }> {
    log.info('Requesting stop recording', { deviceId: device.id });

    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    try {
      // Create payload: [opcode, grant_token_bytes]
      const tokenBuffer = Buffer.from(grantToken, 'utf8');
      const payload = Buffer.alloc(1 + tokenBuffer.length);
      payload.writeUInt8(RECORDING_CMD_GRANT_STOP, 0);
      tokenBuffer.copy(payload, 1);

      // Set up response listener before writing
      const resultPromise = this.waitForRecordingResult(device.id);

      // Write to recording control characteristic
      await this.bleManager.writeCharacteristic(
        device.id,
        SERVICE_BOTA_CONTROL,
        CHAR_RECORDING_CONTROL,
        payload
      );

      // Wait for device response
      const result = await resultPromise;

      log.info('Stop recording result', { deviceId: device.id, result });

      return result;
    } catch (error) {
      log.error('Failed to stop recording', error as Error, { deviceId: device.id });
      throw error;
    }
  }

  /**
   * Get current recording state from device
   */
  async getRecordingState(device: ConnectedDevice): Promise<RecordingState> {
    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    // CHAR_RECORDING_STATUS is notify-only — the device only sends it as a notification
    // on state change (not readable via BLE read).
    // Check pending FIRST: if a recording command is in-flight its result supersedes stale cache.
    const pending = this.recordingStatePending.get(device.id);
    if (pending) return pending;
    const cached = this.recordingStateCache.get(device.id);
    if (cached) return cached;
    return { active: false, initiatedBy: 'local' };
  }

  /**
   * Subscribe to recording state changes
   */
  subscribeToRecordingState(
    device: ConnectedDevice,
    callback: (state: RecordingState) => void
  ): () => void {
    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    const subscription = this.bleManager.subscribeToCharacteristic(
      device.id,
      SERVICE_BOTA_CONTROL,
      CHAR_RECORDING_STATUS,
      (data) => {
        try {
          const state = this.parseRecordingState(data);
          callback(state);
        } catch (error) {
          log.error('Failed to parse recording state', error as Error);
        }
      },
      (error) => {
        log.debug(`Recording state subscription ended: ${error?.message}`);
      }
    );

    return () => {
      subscription.remove();
    };
  }

  /**
   * Wait for recording control result from device
   */
  private waitForRecordingResult(
    deviceId: string
  ): Promise<{ success: boolean; error?: string }> {
    // Set up a pending promise so getRecordingState() can await the result
    // rather than returning stale cache while the command is in-flight.
    let resolvePending!: (state: RecordingState) => void;
    const pendingPromise = new Promise<RecordingState>(resolve => { resolvePending = resolve; });
    this.recordingStatePending.set(deviceId, pendingPromise);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.remove();
        resolvePending({ active: false, initiatedBy: 'local' });
        this.recordingStatePending.delete(deviceId);
        resolve({ success: false, error: 'timeout' });
      }, OPERATION_TIMEOUT);

      const subscription = this.bleManager.subscribeToCharacteristic(
        deviceId,
        SERVICE_BOTA_CONTROL,
        CHAR_RECORDING_STATUS,
        (data) => {
          clearTimeout(timeout);
          subscription.remove();

          if (data.length < 1) {
            resolvePending({ active: false, initiatedBy: 'local' });
            this.recordingStatePending.delete(deviceId);
            resolve({ success: false, error: 'invalid_response' });
            return;
          }

          // Cache the parsed recording state and resolve pending for getRecordingState()
          const parsedState = this.parseRecordingState(data);
          this.recordingStateCache.set(deviceId, parsedState);
          resolvePending(parsedState);
          this.recordingStatePending.delete(deviceId);

          // Parse response: byte 0 = is_recording state
          const resultCode = data.length >= 6 ? data[5] : data[0];

          switch (resultCode) {
            case RECORDING_RESULT_SUCCESS:
              resolve({ success: true });
              break;
            case RECORDING_RESULT_ALREADY_RECORDING:
              resolve({ success: false, error: 'already_recording' });
              break;
            case RECORDING_RESULT_NOT_RECORDING:
              resolve({ success: false, error: 'not_recording' });
              break;
            case RECORDING_RESULT_INVALID_GRANT:
              resolve({ success: false, error: 'invalid_grant' });
              break;
            case RECORDING_RESULT_GRANT_EXPIRED:
              resolve({ success: false, error: 'grant_expired' });
              break;
            default:
              // State 0x01 = recording, 0x00 = idle
              if (data[0] === 0x01 || data[0] === 0x00) {
                resolve({ success: true });
              } else {
                resolve({ success: false, error: 'unknown_error' });
              }
          }
        },
        (error) => {
          clearTimeout(timeout);
          subscription.remove();
          resolvePending({ active: false, initiatedBy: 'local' });
          this.recordingStatePending.delete(deviceId);
          reject(new DeviceError(
            `Recording control error: ${error.message}`,
            'RECORDING_CONTROL_ERROR',
            deviceId,
            error
          ));
        }
      );
    });
  }

  /**
   * Parse recording state from BLE data
   */
  private parseRecordingState(data: Buffer): RecordingState {
    // Format from firmware bota_build_recording_status() (18 bytes):
    // Byte 0:     is_recording (0=idle, 1=active)
    // Byte 1:     initiated_by (0=button, 1=remote)
    // Bytes 2-17: recording_uuid (16 bytes)
    const active = data.length >= 1 && data[0] === 0x01;
    const initiatedBy: 'local' | 'remote' = data.length >= 2 && data[1] === 0x01 ? 'remote' : 'local';

    let recordingId: string | undefined;
    if (active && data.length >= 18) {
      const hex = data.slice(2, 18).toString('hex');
      recordingId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    }

    return { active, recordingId, initiatedBy };
  }

  // ============================================================================
  // WiFi Upload Configuration
  // ============================================================================

  /**
   * Configure WiFi credentials on device via BLE.
   * Requires a WiFi configuration grant from backend.
   *
   * @param deviceId - Connected device ID
   * @param credentials - WiFi network credentials
   * @param grant - WiFi config grant from backend
   * @returns Configuration result
   *
   * @example
   * ```typescript
   * // 1. Get grant from backend
   * const grant = await api.createWiFiConfigGrant(deviceId);
   *
   * // 2. Configure device via BLE
   * const result = await deviceManager.configureWiFi(
   *   deviceId,
   *   { ssid: 'MyNetwork', password: 'password123', securityType: 'WPA2' },
   *   grant
   * );
   *
   * if (result.success) {
   *   console.log('WiFi configured successfully');
   * }
   * ```
   */
  async configureWiFi(
    deviceId: string,
    credentials: WiFiCredentials,
    grant: WiFiConfigGrant
  ): Promise<WiFiConfigResult> {
    log.info('Configuring WiFi on device', { deviceId, ssid: credentials.ssid });

    try {
      // Step 1: Submit WiFi config grant to device
      const grantPacket = createWiFiGrantPacket(grant.grantBlob);
      await this.bleManager.writeCharacteristic(
        deviceId,
        SERVICE_BOTA_WIFI_CONFIG,
        CHAR_WIFI_GRANT,
        grantPacket
      );

      log.debug('WiFi grant submitted');

      // Step 2: Subscribe to result BEFORE writing credentials (avoid race)
      const resultPromise = this.waitForWiFiConfigResult(deviceId);

      // Step 3: Build plaintext credential packet
      // TODO: Re-enable encryption once firmware mbedtls boot crash is resolved
      // Format: [ssid_len (1)][ssid][pwd_len (1)][password]
      const ssidBuf = Buffer.from(credentials.ssid, 'utf-8');
      const pwdBuf = Buffer.from(credentials.password, 'utf-8');
      const credentialPacket = Buffer.alloc(1 + ssidBuf.length + 1 + pwdBuf.length);
      credentialPacket.writeUInt8(ssidBuf.length, 0);
      ssidBuf.copy(credentialPacket, 1);
      credentialPacket.writeUInt8(pwdBuf.length, 1 + ssidBuf.length);
      pwdBuf.copy(credentialPacket, 1 + ssidBuf.length + 1);

      log.debug('Sending WiFi credentials (plaintext mode)', {
        packetSize: credentialPacket.length,
        ssidLen: ssidBuf.length,
      });

      // Step 4: Write credentials to device
      await this.bleManager.writeCharacteristic(
        deviceId,
        SERVICE_BOTA_WIFI_CONFIG,
        CHAR_WIFI_CREDENTIAL,
        credentialPacket
      );

      // Step 5: Wait for configuration result (subscription set up before write)
      const result = await resultPromise;

      if (result.success) {
        log.info('WiFi configuration successful', { deviceId });
      } else {
        log.warn('WiFi configuration failed', { deviceId, error: result.error });
      }

      return result;
    } catch (error) {
      log.error('WiFi configuration error', error instanceof Error ? error : undefined);
      throw new DeviceError(
        `Failed to configure WiFi: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'WIFI_CONFIG_ERROR',
        deviceId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Disconnect WiFi on device and forget stored credentials.
   *
   * @param deviceId - Connected device ID
   * @returns Configuration result
   */
  async disconnectWiFi(deviceId: string): Promise<WiFiConfigResult> {
    log.info('Disconnecting WiFi on device', { deviceId });

    try {
      // Subscribe to result before writing
      const resultPromise = this.waitForWiFiConfigResult(deviceId);

      // Send disconnect command: ssid_len=0
      await this.bleManager.writeCharacteristic(
        deviceId,
        SERVICE_BOTA_WIFI_CONFIG,
        CHAR_WIFI_CREDENTIAL,
        Buffer.from([0x00])
      );

      const result = await resultPromise;
      log.info('WiFi disconnect result', { deviceId, success: result.success });
      return result;
    } catch (error) {
      log.error('WiFi disconnect error', error instanceof Error ? error : undefined);
      throw new DeviceError(
        `Failed to disconnect WiFi: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'WIFI_DISCONNECT_ERROR',
        deviceId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get WiFi connection status from device.
   *
   * @param deviceId - Connected device ID
   * @returns WiFi status information
   *
   * @example
   * ```typescript
   * const status = await deviceManager.getWiFiStatus(deviceId);
   * console.log('WiFi status:', status.status);
   * if (status.status === 'connected') {
   *   console.log('Connected to:', status.ssid);
   *   console.log('Signal strength:', status.signalStrength);
   * }
   * ```
   */
  async getWiFiStatus(deviceId: string): Promise<WiFiStatusInfo> {
    log.debug('Reading WiFi status', { deviceId });

    try {
      const data = await this.bleManager.readCharacteristic(
        deviceId,
        SERVICE_BOTA_WIFI_CONFIG,
        CHAR_WIFI_STATUS
      );

      const status = parseWiFiStatusInfo(data);

      log.debug('WiFi status', { deviceId, status: status.status, ssid: status.ssid });

      return status;
    } catch (error) {
      log.debug('Failed to read WiFi status', { reason: error instanceof Error ? error.message : 'Unknown' });
      throw new DeviceError(
        `Failed to read WiFi status: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'WIFI_STATUS_ERROR',
        deviceId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Subscribe to WiFi status updates from device.
   *
   * @param deviceId - Connected device ID
   * @param callback - Callback function for status updates
   * @returns Subscription object (call .remove() to unsubscribe)
   *
   * @example
   * ```typescript
   * const subscription = deviceManager.subscribeToWiFiStatus(deviceId, (status) => {
   *   console.log('WiFi status update:', status.status);
   *   if (status.status === 'connected') {
   *     console.log('Connected to:', status.ssid);
   *   } else if (status.status === 'failed') {
   *     console.error('Connection failed:', status.lastError);
   *   }
   * });
   *
   * // Later: unsubscribe
   * subscription.remove();
   * ```
   */
  subscribeToWiFiStatus(
    deviceId: string,
    callback: (status: WiFiStatusInfo) => void
  ): Subscription {
    log.debug('Subscribing to WiFi status', { deviceId });

    return this.bleManager.subscribeToCharacteristic(
      deviceId,
      SERVICE_BOTA_WIFI_CONFIG,
      CHAR_WIFI_STATUS,
      (data) => {
        try {
          const status = parseWiFiStatusInfo(data);
          callback(status);
        } catch (error) {
          log.error('Failed to parse WiFi status', error instanceof Error ? error : undefined);
        }
      },
      (error) => {
        // Characteristic may not exist on older firmware — log as debug, not error
        log.debug(`WiFi status subscription ended: ${error.message}`);
      }
    );
  }

  /**
   * Scan for WiFi networks using the device's WiFi radio.
   * Sends a scan command via BLE and waits for the device to report results.
   *
   * @param device - Connected device with WiFi capability
   * @returns Scan result with networks sorted by signal quality
   */
  async scanWiFiNetworks(device: ConnectedDevice): Promise<DeviceWiFiScanResult> {
    log.info('Starting device-side WiFi scan', { deviceId: device.id });

    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.remove();
        reject(new DeviceError(
          'WiFi scan timeout',
          'WIFI_SCAN_TIMEOUT',
          device.id
        ));
      }, WIFI_SCAN_TIMEOUT);

      const subscription = this.bleManager.subscribeToCharacteristic(
        device.id,
        SERVICE_BOTA_WIFI_CONFIG,
        CHAR_WIFI_SCAN,
        (data) => {
          try {
            const result = parseWiFiScanResult(data);
            if (result) {
              clearTimeout(timeout);
              subscription.remove();
              log.info('WiFi scan complete', {
                deviceId: device.id,
                networkCount: result.networks.length,
              });
              resolve(result);
            }
            // null = still scanning, keep waiting
          } catch (error) {
            clearTimeout(timeout);
            subscription.remove();
            reject(error);
          }
        },
        (error) => {
          clearTimeout(timeout);
          subscription.remove();
          reject(new DeviceError(
            `WiFi scan error: ${error.message}`,
            'WIFI_SCAN_ERROR',
            device.id,
            error
          ));
        }
      );

      // Send scan command after subscribing
      this.bleManager.writeCharacteristic(
        device.id,
        SERVICE_BOTA_WIFI_CONFIG,
        CHAR_WIFI_SCAN,
        createWiFiScanCommand()
      ).catch((error) => {
        clearTimeout(timeout);
        subscription.remove();
        reject(error);
      });
    });
  }

  /**
   * Wait for WiFi configuration result from device.
   */
  private waitForWiFiConfigResult(deviceId: string): Promise<WiFiConfigResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.remove();
        reject(new DeviceError(
          'WiFi configuration timeout',
          'WIFI_CONFIG_TIMEOUT',
          deviceId
        ));
      }, OPERATION_TIMEOUT);

      const subscription = this.bleManager.subscribeToCharacteristic(
        deviceId,
        SERVICE_BOTA_WIFI_CONFIG,
        CHAR_WIFI_STATUS,
        (data) => {
          try {
            // Configuration result comes via status updates
            const result = parseWiFiConfigResult(data);

            clearTimeout(timeout);
            subscription.remove();
            resolve(result);
          } catch (error) {
            // Ignore parse errors, wait for valid result
            log.debug('Ignoring invalid WiFi config result', { error: error instanceof Error ? error.message : String(error) });
          }
        },
        (error) => {
          clearTimeout(timeout);
          subscription.remove();
          reject(new DeviceError(
            `WiFi config result error: ${error.message}`,
            'WIFI_CONFIG_RESULT_ERROR',
            deviceId,
            error
          ));
        }
      );
    });
  }

  // Reconnect Registry Persistence

  private async loadReconnectRegistry(): Promise<void> {
    try {
      const data = await AsyncStorage.getItem(RECONNECT_REGISTRY_KEY);
      if (data) {
        this.reconnectRegistry = JSON.parse(data);
      }
    } catch (error) {
      log.warn('Failed to load reconnect registry', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async saveReconnectRegistry(): Promise<void> {
    try {
      await AsyncStorage.setItem(RECONNECT_REGISTRY_KEY, JSON.stringify(this.reconnectRegistry));
    } catch (error) {
      log.warn('Failed to save reconnect registry', { error: error instanceof Error ? error.message : String(error) });
    }
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
