const mockGetBleManager = jest.fn();
const mockUploadFirmware = jest.fn();

jest.mock('../src/ble/BleManager', () => ({
  getBleManager: () => mockGetBleManager(),
}));

jest.mock('../src/protocol/ProtocolHandler', () => ({
  ProtocolHandler: jest.fn(() => ({
    uploadFirmware: (...args: unknown[]) => mockUploadFirmware(...args),
  })),
}));

import {
  OTAManager,
  type FirmwareInfo,
  type OtaProgress,
} from '../src/managers/OTAManager';
import type { DeviceManager } from '../src/managers/DeviceManager';
import type { ConnectedDevice } from '../src/models/Device';

type ProgressListener = (loaded: number, total: number) => void;

class MockXMLHttpRequest {
  static instances: MockXMLHttpRequest[] = [];

  status = 0;
  response: ArrayBuffer | null = null;
  responseType = '';
  onprogress: ((event: ProgressEvent) => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open = jest.fn();
  send = jest.fn();

  constructor() {
    MockXMLHttpRequest.instances.push(this);
  }

  emitProgress(loaded: number, total: number, lengthComputable = true): void {
    this.onprogress?.({ loaded, total, lengthComputable } as ProgressEvent);
  }

  complete(status: number, response: ArrayBuffer | null): void {
    this.status = status;
    this.response = response;
    this.onload?.();
  }
}

const firmware: FirmwareInfo = {
  version: '1.2.3',
  url: 'https://example.com/update.ufw',
  checksum: 'abc123',
  size: 200,
};

describe('OTAManager firmware download', () => {
  let manager: OTAManager;

  beforeEach(() => {
    MockXMLHttpRequest.instances = [];
    mockGetBleManager.mockReset();
    mockUploadFirmware.mockReset();
    global.XMLHttpRequest = MockXMLHttpRequest as unknown as typeof XMLHttpRequest;
    global.fetch = jest.fn(() => new Promise(() => undefined)) as unknown as typeof fetch;
    manager = new OTAManager({} as DeviceManager);
  });

  afterEach(() => {
    manager.destroy();
  });

  it('reports downloaded bytes while receiving firmware', async () => {
    const progress: Array<[number, number]> = [];
    const download = manager.downloadFirmware(firmware, ((loaded, total) => {
      progress.push([loaded, total]);
    }) as ProgressListener);
    const request = MockXMLHttpRequest.instances[0];

    expect(request.open).toHaveBeenCalledWith('GET', firmware.url);
    expect(request.responseType).toBe('arraybuffer');
    expect(request.send).toHaveBeenCalledTimes(1);

    request.emitProgress(50, 200);
    request.emitProgress(150, 200);
    const response = new ArrayBuffer(200);
    request.complete(200, response);

    await expect(download).resolves.toBe(response);
    expect(progress).toEqual([
      [50, 200],
      [150, 200],
    ]);
  });

  it('uses the firmware size when the response has no computable total', async () => {
    const progress: Array<[number, number]> = [];
    const download = manager.downloadFirmware(firmware, (loaded, total) => {
      progress.push([loaded, total]);
    });
    const request = MockXMLHttpRequest.instances[0];

    request.emitProgress(64, 0, false);
    request.complete(200, new ArrayBuffer(200));

    await download;
    expect(progress).toEqual([[64, firmware.size]]);
  });

  it('rejects unsuccessful HTTP responses', async () => {
    const download = manager.downloadFirmware(firmware);

    MockXMLHttpRequest.instances[0].complete(503, null);

    await expect(download).rejects.toThrow('Failed to download firmware: 503');
  });

  it('rejects network failures', async () => {
    const download = manager.downloadFirmware(firmware);

    MockXMLHttpRequest.instances[0].onerror?.();

    await expect(download).rejects.toThrow('Failed to download firmware: network error');
  });

  it('emits byte-level downloading progress during an OTA update', async () => {
    const deviceManager = {
      enableAutoReconnect: jest.fn(),
    } as unknown as DeviceManager;
    const otaManager = new OTAManager(deviceManager);
    const events: OtaProgress[] = [];
    const device = {
      id: 'device-1',
      serialNumber: 'SN123',
    } as ConnectedDevice;
    mockGetBleManager.mockReturnValue({ isConnected: () => true });
    mockUploadFirmware.mockImplementation(async () => undefined);
    (otaManager as unknown as { waitForReconnect: () => Promise<void> }).waitForReconnect =
      jest.fn().mockResolvedValue(undefined);
    otaManager.on('progress', (_deviceId, progress) => events.push(progress));

    const update = otaManager.performUpdate(device, firmware);
    const request = MockXMLHttpRequest.instances[0];
    request.emitProgress(50, 200);
    request.complete(200, new ArrayBuffer(200));
    await update;

    expect(events).toContainEqual({
      stage: 'downloading',
      progress: 0.25,
      bytesTransferred: 50,
      totalBytes: 200,
    });
    expect(events).toContainEqual({
      stage: 'downloading',
      progress: 1,
      bytesTransferred: 200,
      totalBytes: 200,
    });
    otaManager.destroy();
  });
});
