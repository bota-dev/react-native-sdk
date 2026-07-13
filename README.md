# @bota.dev/react-native-sdk

Official React Native SDK for Bota wearable devices.

## Installation

```bash
npm install @bota.dev/react-native-sdk react-native-ble-plx
# or
yarn add @bota.dev/react-native-sdk react-native-ble-plx
```

### iOS Setup

1. Add Bluetooth permissions to `ios/YourApp/Info.plist`:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>This app uses Bluetooth to connect to Bota recording devices</string>
<key>UIBackgroundModes</key>
<array>
  <string>bluetooth-central</string>
</array>
```

2. Install pods:

```bash
cd ios && pod install
```

### Android Setup

1. Add permissions to `android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.BLUETOOTH" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />

```

## Quick Start

```typescript
import { BotaClient } from '@bota.dev/react-native-sdk';

// Initialize SDK
await BotaClient.configure({
  environment: 'production',
  logLevel: 'info',
});

// Wait for Bluetooth
await BotaClient.waitForBluetooth();

// Scan for devices
BotaClient.devices.on('deviceDiscovered', (device) => {
  console.log('Found device:', device.name);
});

BotaClient.devices.startScan();

// Connect to a device
const connectedDevice = await BotaClient.devices.connect(discoveredDevice);

// Provision with token from your backend
await BotaClient.devices.provision(connectedDevice, deviceToken, 'production');

// Check device capabilities
if (connectedDevice.capabilities?.wifiUpload) {
  // Scan for nearby WiFi networks via the device's radio (works on both iOS and Android)
  const { networks, currentSsid } = await BotaClient.devices.scanWiFiNetworks(connectedDevice);

  // Configure WiFi on device
  // grant is a stateless JWT from your backend (POST /devices/{id}/wifi-config/grant)
  await BotaClient.devices.configureWiFi(connectedDevice, ssid, password, grant);
}

// List recordings (Bluetooth Sync)
const recordings = await BotaClient.recordings.listRecordings(connectedDevice);

// Sync a recording via Bluetooth
for await (const progress of BotaClient.recordings.syncRecording(
  connectedDevice,
  recording,
  uploadInfo // from your backend
)) {
  console.log(`${progress.stage}: ${progress.progress * 100}%`);
}

// Note: WiFi/Cellular devices can upload directly without app involvement
```

## Protocol Reference

- [Firmware Protocol Reference](./FIRMWARE_PROTOCOL.md) documents the SDK-facing
  BLE services, packet formats, and recording transfer ACK/NACK behavior.

## Related Mobile SDKs

- React Native: this repository (`@bota.dev/react-native-sdk`)
- Native iOS: [bota-mobile-sdk-ios](https://github.com/bota-dev/bota-mobile-sdk-ios)
- Native Android: [bota-mobile-sdk-android](https://github.com/bota-dev/bota-mobile-sdk-android)

The native SDKs are independent platform implementations of the same device
protocol. They are not bundled with the React Native package.

## API Reference

### BotaClient

Main entry point for the SDK.

```typescript
// Configure SDK
await BotaClient.configure({
  environment: 'production' | 'sandbox',
  backgroundSyncEnabled: boolean,
  wifiOnlyUpload: boolean,
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'none',
});

// Access managers
BotaClient.devices    // DeviceManager
BotaClient.recordings // RecordingManager
BotaClient.ota        // OTAManager

// State
BotaClient.state           // 'uninitialized' | 'initializing' | 'ready' | 'error'
BotaClient.bluetoothState  // 'unknown' | 'poweredOn' | 'poweredOff' | ...
BotaClient.isBluetoothReady
```

### DeviceManager

Handles device discovery, connection, and provisioning.

```typescript
// Scanning
BotaClient.devices.startScan({ timeout: 30000, deviceTypes: ['bota_pin'] });
BotaClient.devices.stopScan();
BotaClient.devices.getDiscoveredDevices();

// Connection
const device = await BotaClient.devices.connect(discoveredDevice);
await BotaClient.devices.disconnect(device);
BotaClient.devices.isConnected(deviceId);

// Provisioning
await BotaClient.devices.provision(device, token, 'production');
await BotaClient.devices.isProvisioned(device);

// Status
const status = await BotaClient.devices.getStatus(device);
const unsubscribe = BotaClient.devices.subscribeToStatus(device, (status) => {});

// Events
BotaClient.devices.on('deviceDiscovered', (device) => {});
BotaClient.devices.on('deviceConnected', (device) => {});
BotaClient.devices.on('deviceDisconnected', (deviceId, error) => {});
BotaClient.devices.on('deviceStatusUpdated', (deviceId, status) => {});
```

### RecordingManager

Handles recording transfer and upload.

```typescript
// List recordings on device
const recordings = await BotaClient.recordings.listRecordings(device);

// Sync a recording (transfer + upload)
for await (const progress of BotaClient.recordings.syncRecording(
  device,
  recording,
  uploadInfo
)) {
  // progress.stage: 'preparing' | 'transferring' | 'uploading' | 'completing' | 'completed' | 'failed'
  // progress.progress: 0.0 - 1.0
}

// Sync all recordings
for await (const progress of BotaClient.recordings.syncAllRecordings(
  device,
  async (recording) => {
    // Get upload info from your backend
    return await yourBackend.getUploadInfo(device.serialNumber, recording);
  }
)) {
  console.log(`Recording ${progress.recordingIndex}/${progress.totalRecordings}`);
}

// Upload queue management
BotaClient.recordings.getPendingUploads();
BotaClient.recordings.cancelUpload(taskId);
BotaClient.recordings.retryFailedUploads();
BotaClient.recordings.pauseUploads();
BotaClient.recordings.resumeUploads();

// Events
BotaClient.recordings.on('syncStarted', (uuid) => {});
BotaClient.recordings.on('syncCompleted', (uuid, recordingId) => {});
BotaClient.recordings.on('syncFailed', (uuid, error) => {});
BotaClient.recordings.on('uploadProgress', (taskId, progress) => {});
```

### WiFi Scanning

WiFi scanning is performed on the device itself via Bluetooth — no platform-specific WiFi libraries needed. Works identically on iOS and Android.

```typescript
// Scan for nearby WiFi networks via the device's radio
const result = await BotaClient.devices.scanWiFiNetworks(connectedDevice);

result.networks;    // WiFiScanNetwork[] — { ssid, quality (0-100), isCurrent, isOpen? }
result.currentSsid; // string | null — currently connected SSID
```

### Types

```typescript
interface DiscoveredDevice {
  id: string;
  name: string;
  deviceType: 'bota_pin' | 'bota_pin_4g' | 'bota_note';
  firmwareVersion: string;
  pairingState: 'unpaired' | 'pairing' | 'paired' | 'error';
  rssi: number;
}

interface ConnectedDevice {
  id: string;
  serialNumber: string;
  deviceType: DeviceType;
  firmwareVersion: string;
  isProvisioned: boolean;
  connectionState: ConnectionState;
  mtu: number;
}

interface DeviceStatus {
  batteryLevel: number;
  storageUsedPercent: number;
  storageTotalMb: number;
  state: DeviceState;
  pendingRecordings: number;
  lastTimeSyncAt: Date | null; // Device's clock-sync timestamp (RTC last set from time source)
  flags: DeviceFlags;
}

// DeviceState: 'idle' | 'recording' | 'syncing' | 'uploading' | 'charging' | 'lowBattery' | 'storageFull' | 'error'

interface DeviceFlags {
  charging: boolean;
  lowBattery: boolean;
  storageFull: boolean;
  wifiConnected: boolean;
  lteConnected: boolean;
  syncActive: boolean;
}

interface DeviceRecording {
  uuid: string;
  startedAt: Date;
  durationMs: number;
  fileSizeBytes: number;
  codec: AudioCodec;
}

interface UploadInfo {
  uploadUrl: string;      // Pre-signed S3 URL
  uploadToken: string;    // Upload token (up_*)
  recordingId: string;    // Recording ID (rec_*)
  completeUrl: string;    // URL to call when complete
  expiresAt: Date;
}

interface SyncProgress {
  stage: SyncStage;
  progress: number;
  bytesTransferred?: number;
  bytesUploaded?: number;
  totalBytes?: number;
  recordingId?: string;
  error?: string;
}
```

## Error Handling

```typescript
import {
  BotaError,
  BluetoothError,
  DeviceError,
  ProvisioningError,
  TransferError,
  UploadError,
} from '@bota.dev/react-native-sdk';

try {
  await BotaClient.devices.connect(device);
} catch (error) {
  if (error instanceof BluetoothError) {
    // Handle Bluetooth errors
  } else if (error instanceof DeviceError) {
    // Handle device errors (connection, not found, etc.)
  } else if (error instanceof ProvisioningError) {
    // Handle provisioning errors
  }
}
```

## Integration with Your Backend

The SDK does not communicate directly with the Bota API. Your mobile app should:

1. Authenticate users through your own backend
2. Call your backend to register devices and get device tokens
3. Call your backend to create recordings and get upload URLs
4. The SDK uploads directly to S3 using the pre-signed URLs

### Upload Methods

**Bluetooth Sync** (current implementation):

- App transfers audio from device via Bluetooth
- App uploads to S3 using pre-signed URLs from your backend
- App notifies backend when upload completes

**WiFi Upload / Cellular Upload** (available now):

- Device uploads directly to Bota backend using device token (dtok_*)
- No app involvement in audio transfer
- App can optionally configure WiFi credentials for WiFi-capable devices:
  - Request a stateless WiFi config grant from your backend (POST /devices/{id}/wifi-config/grant)
  - SDK encrypts credentials with grant session key and transmits via Bluetooth
  - Device stores credentials encrypted in Flash (backend never stores WiFi passwords)
- Backend sends webhooks to notify your app when processing completes

See the [Bota API documentation](https://docs.bota.dev) for backend integration details.

## License

MIT
