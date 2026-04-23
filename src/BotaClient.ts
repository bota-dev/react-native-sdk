/**
 * Bota Client - Main entry point for the Bota React Native SDK
 */

import { State } from 'react-native-ble-plx';
import EventEmitter from 'eventemitter3';

import { getBleManager, resetBleManager, BleManager } from './ble/BleManager';
import { DeviceManager } from './managers/DeviceManager';
import { RecordingManager } from './managers/RecordingManager';
import { OTAManager } from './managers/OTAManager';
import type {
  BotaConfig,
  SdkState,
  BluetoothState,
  BotaClientEvents,
} from './models/Status';
import { SdkError } from './utils/errors';
import { logger, type LogHandler } from './utils/logger';
import type { LogLevel } from './models/Status';

const log = logger.tag('BotaClient');

/**
 * Map react-native-ble-plx State to BluetoothState
 */
function mapBluetoothState(state: State): BluetoothState {
  switch (state) {
    case State.Unknown:
      return 'unknown';
    case State.Resetting:
      return 'resetting';
    case State.Unsupported:
      return 'unsupported';
    case State.Unauthorized:
      return 'unauthorized';
    case State.PoweredOff:
      return 'poweredOff';
    case State.PoweredOn:
      return 'poweredOn';
    default:
      return 'unknown';
  }
}

/**
 * Bota Client class - singleton SDK entry point
 */
class BotaClientImpl extends EventEmitter<BotaClientEvents> {
  private _config: BotaConfig | null = null;
  private _state: SdkState = 'uninitialized';
  private _bluetoothState: BluetoothState = 'unknown';

  private _bleManager: BleManager | null = null;
  private _deviceManager: DeviceManager | null = null;
  private _recordingManager: RecordingManager | null = null;
  private _otaManager: OTAManager | null = null;

  /**
   * Get current SDK state
   */
  get state(): SdkState {
    return this._state;
  }

  /**
   * Get current Bluetooth state
   */
  get bluetoothState(): BluetoothState {
    return this._bluetoothState;
  }

  /**
   * Check if Bluetooth is ready
   */
  get isBluetoothReady(): boolean {
    return this._bluetoothState === 'poweredOn';
  }

  /**
   * Check if SDK is initialized
   */
  get isInitialized(): boolean {
    return this._state === 'ready';
  }

  /**
   * Get current configuration
   */
  get config(): BotaConfig | null {
    return this._config;
  }

  /**
   * Get device manager
   */
  get devices(): DeviceManager {
    if (!this._deviceManager) {
      throw SdkError.notInitialized();
    }
    return this._deviceManager;
  }

  /**
   * Get recording manager
   */
  get recordings(): RecordingManager {
    if (!this._recordingManager) {
      throw SdkError.notInitialized();
    }
    return this._recordingManager;
  }

  /**
   * Get OTA manager
   */
  get ota(): OTAManager {
    if (!this._otaManager) {
      throw SdkError.notInitialized();
    }
    return this._otaManager;
  }

  /**
   * Configure and initialize the SDK
   */
  async configure(config: BotaConfig = {}): Promise<void> {
    if (this._state === 'ready') {
      log.warn('SDK already configured, reconfiguring');
      await this.destroy();
    }

    log.info('Configuring SDK', config as Record<string, unknown>);

    this._config = {
      environment: config.environment ?? 'production',
      backgroundSyncEnabled: config.backgroundSyncEnabled ?? true,
      wifiOnlyUpload: config.wifiOnlyUpload ?? false,
      logLevel: config.logLevel ?? 'warn',
      debug: config.debug ?? false,
    };

    // Set log level
    logger.setLevel(this._config.logLevel!);

    this.setState('initializing');

    try {
      // Initialize BLE manager
      this._bleManager = getBleManager();

      // Set up Bluetooth state listener
      this._bleManager.on('stateChange', (state) => {
        const mappedState = mapBluetoothState(state);
        if (mappedState !== this._bluetoothState) {
          this._bluetoothState = mappedState;
          this.emit('bluetoothStateChanged', mappedState);
        }
      });

      // Get initial Bluetooth state
      const initialState = await this._bleManager.getState();
      this._bluetoothState = mapBluetoothState(initialState);

      // Initialize managers
      this._deviceManager = new DeviceManager();
      await this._deviceManager.initialize();

      this._recordingManager = new RecordingManager();
      await this._recordingManager.initialize();

      this._otaManager = new OTAManager(this._deviceManager);

      this.setState('ready');

      log.info('SDK configured successfully', {
        environment: this._config.environment,
        bluetoothState: this._bluetoothState,
      });
    } catch (error) {
      this.setState('error');
      log.error('Failed to configure SDK', error as Error);
      throw error;
    }
  }

  /**
   * Wait for Bluetooth to be ready
   */
  async waitForBluetooth(timeoutMs: number = 10000): Promise<void> {
    if (!this._bleManager) {
      throw SdkError.notInitialized();
    }

    await this._bleManager.waitForReady(timeoutMs);
  }

  /**
   * Change the SDK log level at runtime without reinitializing
   */
  setLogLevel(level: LogLevel): void {
    logger.setLevel(level);
    if (this._config) {
      this._config.logLevel = level;
    }
  }

  /**
   * Set an external log handler to receive SDK log entries
   */
  setLogHandler(handler: LogHandler | null): void {
    logger.setHandler(handler);
  }

  /**
   * Destroy the SDK and clean up resources
   */
  async destroy(): Promise<void> {
    log.info('Destroying SDK');

    this._deviceManager?.destroy();
    this._recordingManager?.destroy();
    this._otaManager?.destroy();

    resetBleManager();

    this._deviceManager = null;
    this._recordingManager = null;
    this._otaManager = null;
    this._bleManager = null;
    this._config = null;

    this.setState('uninitialized');
    this.removeAllListeners();
  }

  /**
   * Set SDK state and emit event
   */
  private setState(state: SdkState): void {
    if (state !== this._state) {
      this._state = state;
      this.emit('stateChanged', state);
    }
  }
}

/**
 * Singleton instance
 */
export const BotaClient = new BotaClientImpl();

/**
 * Export types
 */
export type { BotaConfig, SdkState, BluetoothState };
