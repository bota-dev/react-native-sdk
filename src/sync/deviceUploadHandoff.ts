import { TRIGGER_UPLOAD_BUSY } from '../ble/constants';

const BLE_DISCONNECTED_DURING_UPLOAD = 'BLE disconnected during device upload';

interface DeviceUploadTriggerResponse {
  accepted?: boolean;
  errorCode?: number;
}

export type DeviceUploadMonitorOutcome = 'completed' | 'failed' | 'detached';
export type DeviceUploadOwnership = 'active' | 'inactive' | 'unavailable';

/** Returns whether a trigger response means firmware already owns an upload. */
export function isDeviceUploadBusyResponse(
  response: DeviceUploadTriggerResponse | null | undefined,
): boolean {
  return response?.accepted === false && response.errorCode === TRIGGER_UPLOAD_BUSY;
}

/** Distinguishes a lost BLE observation link from a real direct-upload failure. */
export function classifyDeviceUploadFailure(
  error: string | undefined,
  bleConnected: boolean,
): Exclude<DeviceUploadMonitorOutcome, 'completed'> {
  if (!bleConnected || error === BLE_DISCONNECTED_DURING_UPLOAD) {
    return 'detached';
  }
  return 'failed';
}

/** BLE fallback is safe only after a fresh status confirms no direct upload. */
export function canFallbackToBleUpload(ownership: DeviceUploadOwnership): boolean {
  return ownership === 'inactive';
}
