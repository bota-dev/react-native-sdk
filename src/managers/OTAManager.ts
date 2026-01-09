/**
 * OTA Manager - Handles firmware over-the-air updates
 *
 * Note: Full Nordic DFU implementation requires native modules.
 * This is a placeholder that handles version checking and update preparation.
 * Actual DFU transfer would need react-native-nordic-dfu or similar.
 */

import EventEmitter from 'eventemitter3';

import { getBleManager } from '../ble/BleManager';
import {
  SERVICE_BOTA_CONTROL,
  CHAR_DEVICE_COMMAND,
  DEVICE_CMD_ENTER_DFU,
} from '../ble/constants';
import type { ConnectedDevice } from '../models/Device';
import { DeviceError } from '../utils/errors';
import { logger } from '../utils/logger';
import { Buffer } from 'buffer';

const log = logger.tag('OTAManager');

/**
 * Firmware info
 */
export interface FirmwareInfo {
  version: string;
  url: string;
  checksum: string;
  releaseNotes?: string;
  size: number;
}

/**
 * OTA progress stages
 */
export type OtaStage =
  | 'checking'
  | 'downloading'
  | 'preparing'
  | 'updating'
  | 'verifying'
  | 'completed'
  | 'failed';

/**
 * OTA progress
 */
export interface OtaProgress {
  stage: OtaStage;
  progress: number;
  error?: string;
}

/**
 * Events emitted by OTAManager
 */
interface OTAManagerEvents {
  updateAvailable: (firmware: FirmwareInfo) => void;
  progress: (deviceId: string, progress: OtaProgress) => void;
  completed: (deviceId: string, version: string) => void;
  failed: (deviceId: string, error: Error) => void;
}

/**
 * OTA Manager class
 */
export class OTAManager extends EventEmitter<OTAManagerEvents> {
  private firmwareCdnUrl: string;

  constructor(firmwareCdnUrl: string = 'https://cdn.bota.dev/firmware') {
    super();
    this.firmwareCdnUrl = firmwareCdnUrl;
  }

  /**
   * Check for available firmware updates
   */
  async checkForUpdate(device: ConnectedDevice): Promise<FirmwareInfo | null> {
    log.info('Checking for firmware update', {
      deviceId: device.id,
      currentVersion: device.firmwareVersion,
      deviceType: device.deviceType,
    });

    this.emit('progress', device.id, { stage: 'checking', progress: 0 });

    try {
      // Fetch latest firmware info from CDN
      const response = await fetch(
        `${this.firmwareCdnUrl}/latest?device_type=${device.deviceType}&current=${device.firmwareVersion}`
      );

      if (!response.ok) {
        if (response.status === 404) {
          log.info('No update available', { deviceId: device.id });
          return null;
        }
        throw new Error(`Failed to check for updates: ${response.status}`);
      }

      const firmware = (await response.json()) as FirmwareInfo;

      // Compare versions
      if (this.isNewerVersion(firmware.version, device.firmwareVersion)) {
        log.info('Update available', {
          deviceId: device.id,
          currentVersion: device.firmwareVersion,
          newVersion: firmware.version,
        });

        this.emit('updateAvailable', firmware);
        return firmware;
      }

      log.info('Device is up to date', {
        deviceId: device.id,
        version: device.firmwareVersion,
      });

      return null;
    } catch (error) {
      log.error('Failed to check for update', error as Error, {
        deviceId: device.id,
      });
      throw error;
    }
  }

  /**
   * Download firmware package
   */
  async downloadFirmware(firmware: FirmwareInfo): Promise<ArrayBuffer> {
    log.info('Downloading firmware', {
      version: firmware.version,
      size: firmware.size,
    });

    const response = await fetch(firmware.url);

    if (!response.ok) {
      throw new Error(`Failed to download firmware: ${response.status}`);
    }

    const data = await response.arrayBuffer();

    // Verify checksum
    // Note: In production, implement proper checksum verification
    log.info('Firmware downloaded', { size: data.byteLength });

    return data;
  }

  /**
   * Prepare device for DFU mode
   */
  async enterDfuMode(device: ConnectedDevice): Promise<void> {
    if (!getBleManager().isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    log.info('Entering DFU mode', { deviceId: device.id });

    // Send DFU command to device
    await getBleManager().writeCharacteristic(
      device.id,
      SERVICE_BOTA_CONTROL,
      CHAR_DEVICE_COMMAND,
      Buffer.from([DEVICE_CMD_ENTER_DFU])
    );

    // Device will disconnect and reboot into DFU mode
    log.info('DFU command sent, device will reboot', { deviceId: device.id });
  }

  /**
   * Perform firmware update
   *
   * Note: This is a placeholder. Full implementation requires:
   * 1. react-native-nordic-dfu for actual DFU transfer
   * 2. Native module integration
   * 3. DFU package preparation
   */
  async performUpdate(
    device: ConnectedDevice,
    firmware: FirmwareInfo
  ): Promise<void> {
    log.info('Starting firmware update', {
      deviceId: device.id,
      version: firmware.version,
    });

    this.emit('progress', device.id, { stage: 'downloading', progress: 0 });

    try {
      // Download firmware
      await this.downloadFirmware(firmware);

      this.emit('progress', device.id, { stage: 'downloading', progress: 1 });
      this.emit('progress', device.id, { stage: 'preparing', progress: 0 });

      // Enter DFU mode
      await this.enterDfuMode(device);

      this.emit('progress', device.id, { stage: 'preparing', progress: 1 });

      // Note: At this point, we would use react-native-nordic-dfu
      // to perform the actual firmware transfer.
      // For now, we throw an error indicating this needs native implementation.

      throw new Error(
        'Full DFU implementation requires react-native-nordic-dfu native module. ' +
        'Device has entered DFU mode and is advertising as "BotaDFU-xxx".'
      );

      // After DFU completes:
      // this.emit('progress', device.id, { stage: 'completed', progress: 1 });
      // this.emit('completed', device.id, firmware.version);
    } catch (error) {
      const err = error as Error;
      log.error('Firmware update failed', err, { deviceId: device.id });

      this.emit('progress', device.id, {
        stage: 'failed',
        progress: 0,
        error: err.message,
      });
      this.emit('failed', device.id, err);

      throw error;
    }
  }

  /**
   * Compare semantic versions
   */
  private isNewerVersion(newVersion: string, currentVersion: string): boolean {
    const parseVersion = (v: string): number[] => {
      return v.split('.').map((n) => parseInt(n, 10) || 0);
    };

    const newParts = parseVersion(newVersion);
    const currentParts = parseVersion(currentVersion);

    for (let i = 0; i < Math.max(newParts.length, currentParts.length); i++) {
      const newPart = newParts[i] || 0;
      const currentPart = currentParts[i] || 0;

      if (newPart > currentPart) return true;
      if (newPart < currentPart) return false;
    }

    return false;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.removeAllListeners();
  }
}
