/**
 * OTA Manager - Handles firmware over-the-air updates via BLE
 *
 * Downloads firmware from backend, transfers to device via BLE,
 * device writes to SD card as update.ufw and reboots to apply.
 */

import EventEmitter from 'eventemitter3';

import { getBleManager } from '../ble/BleManager';
import type { ConnectedDevice } from '../models/Device';
import { DeviceError } from '../utils/errors';
import { logger } from '../utils/logger';
import { ProtocolHandler } from '../protocol/ProtocolHandler';
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
   * Perform firmware update via BLE transfer to SD card.
   *
   * Downloads firmware from URL, transfers to device via BLE,
   * device writes to SD card as update.ufw and reboots to apply.
   */
  async performUpdate(
    device: ConnectedDevice,
    firmware: FirmwareInfo
  ): Promise<void> {
    log.info('Starting firmware update', {
      deviceId: device.id,
      version: firmware.version,
    });

    try {
      // 1. Download firmware
      this.emit('progress', device.id, { stage: 'downloading', progress: 0 });
      const arrayBuffer = await this.downloadFirmware(firmware);
      const firmwareBuffer = Buffer.from(arrayBuffer);
      this.emit('progress', device.id, { stage: 'downloading', progress: 1 });

      // 2. Prepare for BLE transfer
      this.emit('progress', device.id, { stage: 'preparing', progress: 0 });

      if (!getBleManager().isConnected(device.id)) {
        throw DeviceError.notConnected(device.id);
      }

      const protocolHandler = new ProtocolHandler();
      this.emit('progress', device.id, { stage: 'preparing', progress: 1 });

      // 3. Transfer via BLE
      this.emit('progress', device.id, { stage: 'updating', progress: 0 });

      await protocolHandler.uploadFirmware(
        device.id,
        firmwareBuffer,
        (bytesSent: number, totalBytes: number) => {
          this.emit('progress', device.id, {
            stage: 'updating',
            progress: bytesSent / totalBytes,
          });
        }
      );

      // 4. Device will verify CRC and reboot
      this.emit('progress', device.id, { stage: 'verifying', progress: 1 });
      this.emit('progress', device.id, { stage: 'completed', progress: 1 });
      this.emit('completed', device.id, firmware.version);

      log.info('Firmware update complete, device will reboot', {
        deviceId: device.id,
        version: firmware.version,
      });
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
