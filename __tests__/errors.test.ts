import { BLE_ERROR_STORAGE_KEY_UNAVAILABLE } from '../src/ble/constants';
import { TransferError } from '../src/utils/errors';

describe('TransferError.deviceError', () => {
  it('identifies an encrypted recording whose device key is unavailable', () => {
    const uuid = 'cca15e84-0000-0000-0000-000000000000';

    const error = TransferError.deviceError(
      uuid,
      BLE_ERROR_STORAGE_KEY_UNAVAILABLE
    );

    expect(error.code).toBe('STORAGE_KEY_UNAVAILABLE');
    expect(error.recordingUuid).toBe(uuid);
    expect(error.message).toContain('storage key is unavailable');
  });

  it('keeps unknown firmware codes as generic device errors', () => {
    const error = TransferError.deviceError('recording-id', 0x7e);

    expect(error.code).toBe('DEVICE_ERROR');
    expect(error.message).toContain('code: 126');
  });
});
