/**
 * OTA Manager - Handles firmware over-the-air updates via BLE
 *
 * Downloads firmware from backend, transfers to device via BLE,
 * device writes to SD card as update.ufw and reboots to apply.
 */

import EventEmitter from 'eventemitter3';

import { getBleManager } from '../ble/BleManager';
import type { ConnectedDevice } from '../models/Device';
import type { DeviceManager } from './DeviceManager';
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
  | 'restarting'
  | 'completed'
  | 'failed';

/**
 * OTA progress
 */
export interface OtaProgress {
  stage: OtaStage;
  progress: number;
  /** Bytes transferred during stages that expose byte-level progress. */
  bytesTransferred?: number;
  /** Total bytes expected during stages that expose byte-level progress. */
  totalBytes?: number;
  error?: string;
}

/** Receives byte-level progress while a firmware package is downloaded. */
export type FirmwareDownloadProgressCallback = (
  bytesDownloaded: number,
  totalBytes: number
) => void;

interface FirmwareDownloadProgressEvent {
  loaded: number;
  total: number;
  lengthComputable: boolean;
}

interface FirmwareDownloadRequest {
  status: number;
  response: unknown;
  responseType: string;
  onprogress: ((event: FirmwareDownloadProgressEvent) => void) | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  open(method: string, url: string): void;
  send(): void;
}

type FirmwareDownloadRequestConstructor = new () => FirmwareDownloadRequest;

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
  private deviceManager: DeviceManager;

  constructor(deviceManager: DeviceManager, firmwareCdnUrl: string = 'https://cdn.bota.dev/firmware') {
    super();
    this.deviceManager = deviceManager;
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
  async downloadFirmware(
    firmware: FirmwareInfo,
    onProgress?: FirmwareDownloadProgressCallback
  ): Promise<ArrayBuffer> {
    log.info('Downloading firmware', {
      version: firmware.version,
      size: firmware.size,
    });

    const data = await new Promise<ArrayBuffer>((resolve, reject) => {
      const Request = (globalThis as unknown as {
        XMLHttpRequest?: FirmwareDownloadRequestConstructor;
      }).XMLHttpRequest;
      if (!Request) {
        reject(new Error('Failed to download firmware: XMLHttpRequest is unavailable'));
        return;
      }

      const request = new Request();
      request.open('GET', firmware.url);
      request.responseType = 'arraybuffer';

      request.onprogress = (event) => {
        const totalBytes = event.lengthComputable && event.total > 0
          ? event.total
          : firmware.size;
        onProgress?.(event.loaded, totalBytes);
      };

      request.onload = () => {
        if (request.status < 200 || request.status >= 300) {
          reject(new Error(`Failed to download firmware: ${request.status}`));
          return;
        }

        if (!(request.response instanceof ArrayBuffer)) {
          reject(new Error('Failed to download firmware: empty response'));
          return;
        }

        resolve(request.response);
      };
      request.onerror = () => reject(new Error('Failed to download firmware: network error'));
      request.onabort = () => reject(new Error('Failed to download firmware: request aborted'));
      request.send();
    });

    // Verify checksum
    // Note: In production, implement proper checksum verification
    log.info('Firmware downloaded', { size: data.byteLength });

    return data;
  }

  /**
   * Perform firmware update via Bluetooth transfer to SD card.
   *
   * Downloads firmware from URL, transfers to device via BLE,
   * device writes to SD card as update.ufw and reboots to apply.
   *
   * @param grantBlob - P7: Base64-encoded 207-byte OTA grant blob. When provided,
   *                    written to CHAR_DEVICE_COMMAND before upload begins so the
   *                    device can verify the transfer against the grant's SHA-256.
   */
  async performUpdate(
    device: ConnectedDevice,
    firmware: FirmwareInfo,
    grantBlob?: string
  ): Promise<void> {
    log.info('Starting firmware update', {
      deviceId: device.id,
      version: firmware.version,
    });

    try {
      // 1. Download firmware
      this.emit('progress', device.id, {
        stage: 'downloading',
        progress: 0,
        bytesTransferred: 0,
        totalBytes: firmware.size,
      });
      const arrayBuffer = await this.downloadFirmware(firmware, (bytesDownloaded, totalBytes) => {
        this.emit('progress', device.id, {
          stage: 'downloading',
          progress: totalBytes > 0 ? Math.min(bytesDownloaded / totalBytes, 1) : 0,
          bytesTransferred: bytesDownloaded,
          totalBytes,
        });
      });
      const firmwareBuffer = Buffer.from(arrayBuffer);
      this.emit('progress', device.id, {
        stage: 'downloading',
        progress: 1,
        bytesTransferred: arrayBuffer.byteLength,
        totalBytes: arrayBuffer.byteLength,
      });

      // 2. Prepare for Bluetooth transfer
      this.emit('progress', device.id, { stage: 'preparing', progress: 0 });

      if (!getBleManager().isConnected(device.id)) {
        throw DeviceError.notConnected(device.id);
      }

      // P7: Write OTA grant to device before upload so firmware can verify SHA-256
      if (grantBlob) {
        await this.deviceManager.writeGrant(device, grantBlob);
        log.info('OTA grant written to device', { deviceId: device.id });
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

      // 4. Device verifies CRC and reboots; wait for it to come back online
      this.emit('progress', device.id, { stage: 'verifying', progress: 1 });
      this.emit('progress', device.id, { stage: 'restarting', progress: 0 });

      this.deviceManager.enableAutoReconnect(device.serialNumber);
      await this.waitForReconnect(device.serialNumber);

      this.emit('progress', device.id, { stage: 'completed', progress: 1 });
      this.emit('completed', device.id, firmware.version);

      log.info('Firmware update complete, device reconnected after reboot', {
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

  private waitForReconnect(serialNumber: string, timeoutMs = 120000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for device to restart'));
      }, timeoutMs);

      const onConnected = (connectedDevice: ConnectedDevice) => {
        if (connectedDevice.serialNumber === serialNumber) {
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.deviceManager.off('deviceConnected', onConnected);
      };

      this.deviceManager.on('deviceConnected', onConnected);
    });
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
