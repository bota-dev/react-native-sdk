const mockBleManager = {
  isConnected: jest.fn(() => true),
};

jest.mock('../src/ble/BleManager', () => ({
  getBleManager: () => mockBleManager,
}));

jest.mock('../src/protocol/ProtocolHandler', () => ({
  ProtocolHandler: jest.fn(),
}));

jest.mock('../src/storage/StorageManager', () => ({
  StorageManager: jest.fn(),
}));

jest.mock('../src/upload/UploadQueue', () => ({
  UploadQueue: jest.fn(),
}));

import {
  canFallbackToBleUpload,
  classifyDeviceUploadFailure,
  isDeviceUploadBusyResponse,
} from '../src/sync/deviceUploadHandoff';
import { RecordingManager } from '../src/managers/RecordingManager';

const connectedDevice = {
  id: 'device-upload-test',
  serialNumber: 'UPLOAD123',
} as any;

const recording = {
  uuid: 'recording-1',
  fileSizeBytes: 1024,
} as any;

const inactiveStatus = {
  flags: {
    syncActive: false,
    wifiConnected: true,
    lteConnected: false,
  },
  pendingRecordings: 1,
} as any;

const activeStatus = {
  ...inactiveStatus,
  flags: {
    ...inactiveStatus.flags,
    syncActive: true,
  },
} as any;

async function collectProgress(generator: AsyncGenerator<any>): Promise<any[]> {
  const progress: any[] = [];
  for await (const item of generator) {
    progress.push(item);
  }
  return progress;
}

function createRecordingManager() {
  const manager = Object.create(RecordingManager.prototype) as any;
  manager.listRecordings = jest.fn().mockResolvedValue([recording]);
  manager.protocolHandler = {
    triggerDeviceUpload: jest.fn(),
  };
  manager.syncRecording = jest.fn(() => (
    async function* () {
      yield { stage: 'completed', progress: 1 };
    }
  )());
  return manager;
}

describe('device upload handoff policy', () => {
  beforeEach(() => {
    mockBleManager.isConnected.mockReturnValue(true);
  });

  it('recognizes the trigger command busy response', () => {
    expect(isDeviceUploadBusyResponse({ accepted: false, errorCode: 0x02 })).toBe(true);
    expect(isDeviceUploadBusyResponse({ accepted: false, errorCode: 0x01 })).toBe(false);
  });

  it('treats BLE loss during direct upload as detached, not failed', () => {
    expect(classifyDeviceUploadFailure('BLE disconnected during device upload', false)).toBe(
      'detached',
    );
    expect(classifyDeviceUploadFailure('Status read interrupted', false)).toBe('detached');
    expect(classifyDeviceUploadFailure('Device upload stopped', true)).toBe('failed');
  });

  it('allows BLE fallback only after fresh inactive status', () => {
    expect(canFallbackToBleUpload('inactive')).toBe(true);
    expect(canFallbackToBleUpload('active')).toBe(false);
    expect(canFallbackToBleUpload('unavailable')).toBe(false);
  });

  it('does not start BLE when the direct-upload trigger reports busy', async () => {
    const manager = createRecordingManager();
    manager.readDeviceStatus = jest
      .fn()
      .mockResolvedValueOnce(inactiveStatus)
      .mockResolvedValueOnce(inactiveStatus);
    manager.protocolHandler.triggerDeviceUpload.mockResolvedValue({
      accepted: false,
      errorCode: 0x02,
    });
    const uploadInfoProvider = jest.fn();

    const progress = await collectProgress(
      manager.syncAllRecordings(connectedDevice, uploadInfoProvider),
    );

    expect(progress).toEqual([
      expect.objectContaining({ stage: 'device_uploading' }),
    ]);
    expect(manager.syncRecording).not.toHaveBeenCalled();
    expect(uploadInfoProvider).not.toHaveBeenCalled();
  });

  it('does not start BLE when trigger failure leaves ownership unreadable', async () => {
    const manager = createRecordingManager();
    manager.readDeviceStatus = jest
      .fn()
      .mockResolvedValueOnce(inactiveStatus)
      .mockResolvedValueOnce(null);
    manager.protocolHandler.triggerDeviceUpload.mockRejectedValue(new Error('BLE link lost'));
    const uploadInfoProvider = jest.fn();

    const progress = await collectProgress(
      manager.syncAllRecordings(connectedDevice, uploadInfoProvider),
    );

    expect(progress).toEqual([
      expect.objectContaining({ stage: 'device_uploading' }),
    ]);
    expect(manager.syncRecording).not.toHaveBeenCalled();
    expect(uploadInfoProvider).not.toHaveBeenCalled();
  });

  it('does not start BLE after a detached monitor even if reconnect reads inactive', async () => {
    const manager = createRecordingManager();
    manager.readDeviceStatus = jest
      .fn()
      .mockResolvedValueOnce(activeStatus)
      .mockResolvedValueOnce(inactiveStatus);
    manager.monitorDeviceUpload = jest.fn(() => (
      async function* () {
        yield {
          stage: 'failed',
          progress: 0,
          error: 'BLE disconnected during device upload',
        };
        return 'detached';
      }
    )());
    const uploadInfoProvider = jest.fn();

    const progress = await collectProgress(
      manager.syncAllRecordings(connectedDevice, uploadInfoProvider),
    );

    expect(progress).toEqual([
      expect.objectContaining({ stage: 'failed' }),
    ]);
    expect(manager.syncRecording).not.toHaveBeenCalled();
    expect(uploadInfoProvider).not.toHaveBeenCalled();
  });

  it('starts BLE only after direct upload fails and fresh status is inactive', async () => {
    const manager = createRecordingManager();
    manager.readDeviceStatus = jest
      .fn()
      .mockResolvedValueOnce(activeStatus)
      .mockResolvedValueOnce(inactiveStatus);
    manager.monitorDeviceUpload = jest.fn(() => (
      async function* () {
        yield { stage: 'failed', progress: 0, error: 'Device upload stopped' };
        return 'failed';
      }
    )());
    const uploadInfo = {
      uploadUrl: 'https://example.test/upload',
      recordingId: 'rec_123',
    };
    const uploadInfoProvider = jest.fn().mockResolvedValue(uploadInfo);

    const progress = await collectProgress(
      manager.syncAllRecordings(connectedDevice, uploadInfoProvider),
    );

    expect(progress).toEqual([
      expect.objectContaining({ stage: 'failed' }),
      expect.objectContaining({ stage: 'completed' }),
    ]);
    expect(uploadInfoProvider).toHaveBeenCalledWith(recording);
    expect(manager.syncRecording).toHaveBeenCalledWith(
      connectedDevice,
      recording,
      uploadInfo,
    );
  });
});
