const mockGetBleManager = jest.fn();

jest.mock('../src/ble/BleManager', () => ({
  getBleManager: () => mockGetBleManager(),
}));

import { Buffer } from 'buffer';

import {
  CHAR_RECORDING_TRANSFER,
  CHAR_TRANSFER_CONTROL,
} from '../src/ble/constants';
import { ProtocolHandler } from '../src/protocol/ProtocolHandler';

type StatusCallback = (data: Buffer) => void;

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

describe('ProtocolHandler firmware upload', () => {
  let onStatus: StatusCallback;
  let removeSubscription: jest.Mock;
  let writeCharacteristic: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    removeSubscription = jest.fn();
    writeCharacteristic = jest.fn();

    mockGetBleManager.mockReset();
    mockGetBleManager.mockReturnValue({
      isConnected: jest.fn(() => true),
      subscribeToCharacteristic: jest.fn(
        (
          _deviceId: string,
          _serviceUuid: string,
          _characteristicUuid: string,
          callback: StatusCallback
        ) => {
          onStatus = callback;
          return { remove: removeSubscription };
        }
      ),
      writeCharacteristic,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ['legacy generic', 0x01],
    ['storage-specific', 0x02],
  ])('fails immediately for a %s write error', async (_label, resultCode) => {
    writeCharacteristic.mockImplementation(
      async (
        _deviceId: string,
        _serviceUuid: string,
        characteristicUuid: string,
        data: Buffer
      ) => {
        if (characteristicUuid === CHAR_TRANSFER_CONTROL && data[0] === 0x08) {
          onStatus(Buffer.from([0x08, 0x00]));
        } else if (characteristicUuid === CHAR_RECORDING_TRANSFER) {
          onStatus(Buffer.from([0x08, resultCode]));
        } else if (characteristicUuid === CHAR_TRANSFER_CONTROL && data[0] === 0x09) {
          onStatus(Buffer.from([0x09, 0x00]));
        }
      }
    );

    const handler = new ProtocolHandler();

    await expect(handler.uploadFirmware('device-1', Buffer.alloc(1000))).rejects.toMatchObject({
      code: 'FW_STORAGE_WRITE_FAILED',
    });
    expect(removeSubscription).toHaveBeenCalledTimes(1);
  });

  it('uses an ACK that arrives before the flow-control wait begins', async () => {
    writeCharacteristic.mockImplementation(
      async (
        _deviceId: string,
        _serviceUuid: string,
        characteristicUuid: string,
        data: Buffer
      ) => {
        if (characteristicUuid === CHAR_TRANSFER_CONTROL && data[0] === 0x08) {
          onStatus(Buffer.from([0x08, 0x00]));
        } else if (characteristicUuid === CHAR_RECORDING_TRANSFER) {
          const seq = data.readUInt16LE(1);
          onStatus(Buffer.from([0x10, seq & 0xff, seq >> 8]));
        } else if (characteristicUuid === CHAR_TRANSFER_CONTROL && data[0] === 0x09) {
          onStatus(Buffer.from([0x09, 0x00]));
        }
      }
    );

    const handler = new ProtocolHandler();
    let settled = false;
    const upload = handler.uploadFirmware('device-1', Buffer.alloc(4000)).then(() => {
      settled = true;
    });

    await flushAsyncWork();
    const settledBeforeTimeout = settled;
    await jest.runAllTimersAsync();
    await upload;

    expect(settledBeforeTimeout).toBe(true);
    expect(removeSubscription).toHaveBeenCalledTimes(1);
  });

  it('fails when the expected flow-control ACK never arrives', async () => {
    writeCharacteristic.mockImplementation(
      async (
        _deviceId: string,
        _serviceUuid: string,
        characteristicUuid: string,
        data: Buffer
      ) => {
        if (characteristicUuid === CHAR_TRANSFER_CONTROL && data[0] === 0x08) {
          onStatus(Buffer.from([0x08, 0x00]));
        } else if (characteristicUuid === CHAR_RECORDING_TRANSFER) {
          const seq = data.readUInt16LE(1);
          if (seq < 7) {
            onStatus(Buffer.from([0x10, seq & 0xff, seq >> 8]));
          }
        } else if (characteristicUuid === CHAR_TRANSFER_CONTROL && data[0] === 0x09) {
          onStatus(Buffer.from([0x09, 0x00]));
        }
      }
    );

    const handler = new ProtocolHandler();
    const result = handler.uploadFirmware('device-1', Buffer.alloc(4000)).then(
      () => ({ error: null }),
      (error: unknown) => ({ error })
    );

    await flushAsyncWork();
    await jest.advanceTimersByTimeAsync(5000);

    await expect(result).resolves.toMatchObject({
      error: { code: 'FW_UPLOAD_ACK_TIMEOUT' },
    });
    expect(removeSubscription).toHaveBeenCalledTimes(1);
  });
});
