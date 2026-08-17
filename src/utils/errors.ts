/**
 * Custom error types for the Bota SDK
 */

import { BLE_ERROR_STORAGE_KEY_UNAVAILABLE } from '../ble/constants';

/**
 * Base error class for all Bota SDK errors
 */
export class BotaError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'BotaError';
    Object.setPrototypeOf(this, BotaError.prototype);
  }
}

/**
 * Bluetooth-related errors
 */
export class BluetoothError extends BotaError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, cause);
    this.name = 'BluetoothError';
    Object.setPrototypeOf(this, BluetoothError.prototype);
  }

  static unavailable(): BluetoothError {
    return new BluetoothError(
      'Bluetooth is not available on this device',
      'BLUETOOTH_UNAVAILABLE'
    );
  }

  static unauthorized(): BluetoothError {
    return new BluetoothError(
      'Bluetooth permission not granted',
      'BLUETOOTH_UNAUTHORIZED'
    );
  }

  static poweredOff(): BluetoothError {
    return new BluetoothError('Bluetooth is powered off', 'BLUETOOTH_OFF');
  }
}

/**
 * Device-related errors
 */
export class DeviceError extends BotaError {
  constructor(
    message: string,
    code: string,
    public readonly deviceId?: string,
    cause?: Error
  ) {
    super(message, code, cause);
    this.name = 'DeviceError';
    Object.setPrototypeOf(this, DeviceError.prototype);
  }

  static notFound(deviceId: string): DeviceError {
    return new DeviceError(
      `Device ${deviceId} not found`,
      'DEVICE_NOT_FOUND',
      deviceId
    );
  }

  static connectionFailed(deviceId: string, cause?: Error): DeviceError {
    return new DeviceError(
      `Failed to connect to device ${deviceId}`,
      'CONNECTION_FAILED',
      deviceId,
      cause
    );
  }

  static connectionLost(deviceId: string, during?: string): DeviceError {
    const message = during
      ? `Connection to device ${deviceId} lost during ${during}`
      : `Connection to device ${deviceId} lost`;
    return new DeviceError(message, 'CONNECTION_LOST', deviceId);
  }

  static bondingFailed(deviceId: string, cause?: Error): DeviceError {
    return new DeviceError(
      `Bonding failed for device ${deviceId}`,
      'BONDING_FAILED',
      deviceId,
      cause
    );
  }

  static notConnected(deviceId: string): DeviceError {
    return new DeviceError(
      `Device ${deviceId} is not connected`,
      'NOT_CONNECTED',
      deviceId
    );
  }

  static alreadyConnected(deviceId: string): DeviceError {
    return new DeviceError(
      `Device ${deviceId} is already connected`,
      'ALREADY_CONNECTED',
      deviceId
    );
  }
}

/**
 * Provisioning-related errors
 */
export class ProvisioningError extends BotaError {
  constructor(
    message: string,
    code: string,
    public readonly deviceId?: string,
    cause?: Error
  ) {
    super(message, code, cause);
    this.name = 'ProvisioningError';
    Object.setPrototypeOf(this, ProvisioningError.prototype);
  }

  static invalidToken(deviceId: string): ProvisioningError {
    return new ProvisioningError(
      'Device rejected the token as invalid',
      'INVALID_TOKEN',
      deviceId
    );
  }

  static storageError(deviceId: string): ProvisioningError {
    return new ProvisioningError(
      'Device failed to store the token',
      'STORAGE_ERROR',
      deviceId
    );
  }

  static chunkError(deviceId: string): ProvisioningError {
    return new ProvisioningError(
      'Token chunk transfer failed',
      'CHUNK_ERROR',
      deviceId
    );
  }

  static alreadyProvisioned(deviceId: string): ProvisioningError {
    return new ProvisioningError(
      'Device is already provisioned',
      'ALREADY_PROVISIONED',
      deviceId
    );
  }

  static alreadyPaired(deviceId: string): ProvisioningError {
    return new ProvisioningError(
      'Device is already paired with another credential. Factory reset the device before re-provisioning.',
      'ALREADY_PAIRED',
      deviceId
    );
  }

  static timeout(deviceId: string): ProvisioningError {
    return new ProvisioningError(
      'Provisioning timed out waiting for device response',
      'PROVISIONING_TIMEOUT',
      deviceId
    );
  }
}

/**
 * Transfer-related errors
 */
export class TransferError extends BotaError {
  constructor(
    message: string,
    code: string,
    public readonly recordingUuid?: string,
    cause?: Error
  ) {
    super(message, code, cause);
    this.name = 'TransferError';
    Object.setPrototypeOf(this, TransferError.prototype);
  }

  static recordingNotFound(uuid: string): TransferError {
    return new TransferError(
      `Recording ${uuid} not found on device`,
      'RECORDING_NOT_FOUND',
      uuid
    );
  }

  static checksumMismatch(uuid: string): TransferError {
    return new TransferError(
      `Checksum mismatch for recording ${uuid}`,
      'CHECKSUM_MISMATCH',
      uuid
    );
  }

  static interrupted(uuid: string, cause?: Error): TransferError {
    return new TransferError(
      `Transfer interrupted for recording ${uuid}`,
      'TRANSFER_INTERRUPTED',
      uuid,
      cause
    );
  }

  static timeout(uuid: string): TransferError {
    return new TransferError(
      `Transfer timed out for recording ${uuid}`,
      'TRANSFER_TIMEOUT',
      uuid
    );
  }

  static deviceError(uuid: string, errorCode: number): TransferError {
    if (errorCode === BLE_ERROR_STORAGE_KEY_UNAVAILABLE) {
      return new TransferError(
        `Recording ${uuid} exists, but its device storage key is unavailable`,
        'STORAGE_KEY_UNAVAILABLE',
        uuid
      );
    }
    return new TransferError(
      `Device error (code: ${errorCode}) during transfer of ${uuid}`,
      'DEVICE_ERROR',
      uuid
    );
  }
}

/**
 * Upload-related errors
 */
export class UploadError extends BotaError {
  constructor(
    message: string,
    code: string,
    public readonly taskId?: string,
    cause?: Error
  ) {
    super(message, code, cause);
    this.name = 'UploadError';
    Object.setPrototypeOf(this, UploadError.prototype);
  }

  static urlExpired(taskId: string): UploadError {
    return new UploadError(
      'Upload URL has expired',
      'URL_EXPIRED',
      taskId
    );
  }

  static networkUnavailable(): UploadError {
    return new UploadError(
      'Network is not available',
      'NETWORK_UNAVAILABLE'
    );
  }

  static uploadFailed(taskId: string, cause?: Error): UploadError {
    return new UploadError(
      `Upload failed for task ${taskId}`,
      'UPLOAD_FAILED',
      taskId,
      cause
    );
  }

  static completionFailed(taskId: string, cause?: Error): UploadError {
    return new UploadError(
      `Failed to notify completion for task ${taskId}`,
      'COMPLETION_FAILED',
      taskId,
      cause
    );
  }
}

/**
 * SDK state errors
 */
export class SdkError extends BotaError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, cause);
    this.name = 'SdkError';
    Object.setPrototypeOf(this, SdkError.prototype);
  }

  static notInitialized(): SdkError {
    return new SdkError(
      'SDK has not been initialized. Call BotaClient.configure() first.',
      'NOT_INITIALIZED'
    );
  }

  static invalidState(expected: string, actual: string): SdkError {
    return new SdkError(
      `Invalid state: expected ${expected}, got ${actual}`,
      'INVALID_STATE'
    );
  }

  static timeout(operation: string): SdkError {
    return new SdkError(`Operation timed out: ${operation}`, 'TIMEOUT');
  }
}

/**
 * Type guard to check if an error is a BotaError
 */
export function isBotaError(error: unknown): error is BotaError {
  return error instanceof BotaError;
}
