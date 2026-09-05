# Bota SDK for React Native

`DeviceConnectionSettings` optionally accepts `heartbeat_enabled_connections`; serialization writes the explicit DEVICE_SETTINGS byte-9 mask and parsing resolves legacy payloads to both channels enabled. Missing or `null` individual radio idle timeouts serialize as the 180-second default, while legacy 1-9 second values round up to the wire minimum of 10 seconds.

**Bota SDK for React Native** is the official React Native SDK for Bota wearable
devices. Its npm package remains `@bota.dev/react-native-sdk`, with `BotaClient`
as the compatibility entry point.

## Installation

Building the SDK from source requires Node.js 22.13 or newer.

```bash
npm install @bota.dev/react-native-sdk react-native-ble-plx
# or
yarn add @bota.dev/react-native-sdk react-native-ble-plx
```

The untagged install is the supported production maintenance line and resolves
through npm `latest` to a `0.0.x` version. The synchronized cross-platform Bota
App SDK is available separately as a beta with
`npm install @bota.dev/react-native-sdk@beta`; do not switch production apps to
that line implicitly.

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

// Provision with a provisional token from your backend. The environment
// argument is legacy compatibility metadata; signed firmware chooses its own
// API environment, so the App/backend and firmware profiles must already match.
await BotaClient.devices.provision(connectedDevice, deviceToken, 'production');

// Check device capabilities
if (connectedDevice.capabilities?.wifiUpload) {
  // Scan for nearby WiFi networks via the device's radio (works on both iOS and Android)
  const { networks, currentSsid } = await BotaClient.devices.scanWiFiNetworks(connectedDevice);

  // Configure WiFi on device. Do not use real production credentials until the
  // firmware's exact-action Grant + encrypted credential profile is released.
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

## Bota App SDK Family

- **Bota SDK for React Native**: this supported package
  (`@bota.dev/react-native-sdk`) retains the `BotaClient` compatibility entry
  point.
- Apple target: `BotaAppleSDK` from the
  [`app-sdk`](https://github.com/bota-dev/app-sdk) source monorepo.
- Android target: the future `dev.bota:bota-android-sdk` artifact from
  [`app-sdk`](https://github.com/bota-dev/app-sdk).
- Legacy Apple migration input:
  [`bota-mobile-sdk-ios`](https://github.com/bota-dev/bota-mobile-sdk-ios), whose
  module remains `BotaSDK`.
- Legacy Android migration input:
  [`bota-mobile-sdk-android`](https://github.com/bota-dev/bota-mobile-sdk-android),
  whose namespace remains `com.bota.sdk`.

The legacy native repositories are migration inputs, not the public target
packages. They remain separate from this React Native package until their
parity and release gates pass. See the public
[Bota App SDK architecture](https://github.com/bota-dev/app-sdk/blob/main/ARCHITECTURE.md).

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

### OTAManager

Downloads and transfers firmware updates over Bluetooth. Download progress includes optional byte
counts so apps can display both a percentage and transferred size.

```typescript
BotaClient.ota.on('progress', (deviceId, update) => {
  console.log(deviceId, update.stage, update.progress);

  if (update.bytesTransferred !== undefined && update.totalBytes !== undefined) {
    console.log(`${update.bytesTransferred} / ${update.totalBytes} bytes`);
  }
});

await BotaClient.ota.performUpdate(device, firmwareInfo, grantBlob);
```

`OtaProgress.progress` is normalized from `0` to `1`. During the `downloading` stage,
`bytesTransferred` and `totalBytes` report the HTTPS firmware download. The fields remain optional
for compatibility with stages that do not expose byte-level progress.

Bluetooth transfer failures are terminal. A device-side SD/FAT write failure rejects with
`FW_STORAGE_WRITE_FAILED`, and a missing flow-control acknowledgement rejects with
`FW_UPLOAD_ACK_TIMEOUT`; the SDK does not continue advancing upload progress after either error.

### DeviceManager

Handles device discovery, connection, and provisioning.

```typescript
// Scanning
BotaClient.devices.startScan({ timeout: 30000, deviceTypes: ['bota_pin'] });
BotaClient.devices.stopScan();
BotaClient.devices.getDiscoveredDevices();

// Connection
const device = await BotaClient.devices.connect(discoveredDevice);
const reconnected = await BotaClient.devices.reconnect(serialNumber);
await BotaClient.devices.disconnect(device);
BotaClient.devices.isConnected(deviceId);

// Device and recording timestamps are UTC; localize only for display.

// Provisioning. `environment` cannot redirect signed firmware; it must match
// the firmware build profile.
await BotaClient.devices.provision(device, token, 'production');
await BotaClient.devices.isProvisioned(device);

// Authenticated factory reset. Persist the device result before the SDK sends
// receipt opcode 0x0A; reset success must be the exact three-byte firmware
// result. Finalize the backend command separately in the app.
const resetResult = await BotaClient.devices.bleFactoryReset(
  device,
  deprovisionGrantBlob,
  result => durableResetStore.save(commandId, result)
);

// After disconnect-before-receipt, firmware replays its WIPED result.
await BotaClient.devices.resumeBleFactoryReset(
  reconnectedDevice,
  result => durableResetStore.save(commandId, result)
);

// Status
const status = await BotaClient.devices.getStatus(device);
const unsubscribe = BotaClient.devices.subscribeToStatus(device, (status) => {});

// Firmware debug logs (requires DEBUG=1 firmware)
const unsubscribeDeviceLogs = await BotaClient.devices.subscribeToDeviceLogs(device, event => {
  console.log(event.level, event.message, event.isBacklog);
});
unsubscribeDeviceLogs();

// Events
BotaClient.devices.on('deviceDiscovered', (device) => {});
BotaClient.devices.on('deviceConnected', (device) => {});
BotaClient.devices.on('deviceDisconnected', (deviceId, error) => {});
BotaClient.devices.on('deviceStatusUpdated', (deviceId, status) => {});
```

`reconnect(serialNumber)` first uses the cached peripheral ID or advertised MAC.
If those identities changed, it performs a guarded GATT serial-number probe and
accepts only the requested physical device.

### Device Debug Logs

Subscribe to the optional firmware diagnostic stream after connecting. Start is
unsupported on firmware without `DEBUG=1` and rejects with `DeviceError` code
`FEATURE_UNAVAILABLE`. The returned cleanup can be called more than once; device
disconnect and SDK destruction remove the monitor automatically.
Only one subscription or pending Start is allowed per device. An overlapping call
rejects with `DeviceError` code `ALREADY_SUBSCRIBED` without replacing the owner.
Decoded `event.message` values are UTF-8 strings on both Hermes and JavaScriptCore;
the SDK normalizes React Native byte views before conversion. Sequence gaps and
firmware dropped-byte flags clear any partial line internally but are not emitted
as synthetic log events.

```typescript
const unsubscribe = await BotaClient.devices.subscribeToDeviceLogs(device, event => {
  console.log(event.level, event.message, event.isBacklog);
});
unsubscribe();
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

// Encrypted Upload v2 source-preview path. This requires firmware that
// explicitly advertises the dedicated v2 capability; released firmware does
// not advertise it yet.
const abortController = new AbortController();
const encryptedRecordings = await BotaClient.recordings.listEncryptedUploadV2Recordings(device);
for await (const progress of BotaClient.recordings.syncEncryptedRecordingV2(
  device,
  encryptedRecordings[0],
  async ({ recording, capability, checkpoint }) => {
    // Your app/backend selects v2 and returns the signed authorization, stable
    // session/owner IDs, an opaque ciphertext sink, staging/finalization
    // callbacks, and the signed completion receipt callback.
    return yourBackend.prepareEncryptedUploadV2(recording, capability, checkpoint);
  },
  { signal: abortController.signal }
)) {
  console.log(progress.stage, progress.progress);
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

`syncAllRecordings` preserves device-side ownership while a WiFi or cellular
upload may still be active. A busy response, Bluetooth disconnect, or
unavailable status will not start a competing Bluetooth transfer. Bluetooth
fallback requires a fresh device status with `syncActive: false`.

The additive batch-v2 API uses only `B07A0406` through `B07A040B`. It reads a
fresh capability before invoking `EncryptedUploadV2Provider`, persists only
resume identifiers/digests/offsets/bounds, and deletes the device recording
only after the exact receipt is accepted and v2 CONFIRM reaches the device's
complete status. `EncryptedUploadV2CiphertextSink` implementations own opaque
byte storage and staging; the SDK never decrypts or interprets ciphertext or
the manifest. Pre-confirm failures and consumer cancellation at a yielded
progress boundary ABORT best-effort, retain the device copy, and never call the
legacy v1/P10 path. The optional `AbortSignal` also reaches provider callbacks,
opaque sink work, signed-document delivery, and an in-flight BLE transfer. A
lost result after CONFIRM is reported as
`encrypted_upload_v2_confirmation_uncertain`; it preserves the checkpoint and
finalized backend state for reconciliation instead of attempting rollback.
After matching device-complete, checkpoint cleanup is best-effort and cannot
reverse completion. Install `react-native-quick-crypto` when using v2. This
source API is not a rollout signal: production firmware capability advertising
and SDK publication remain separately gated.

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
- App-side WiFi configuration APIs exist, but the released firmware path is not
  production-safe for credentials: it accepts a non-empty Grant blob and uses a
  plaintext application payload. Do not provision real WiFi passwords until the
  exact-action Grant, encrypted delivery, protected storage and explicit
  replace/forget contract in the WiFi design are released.
- Backend sends webhooks to notify your app when processing completes

See the [Bota API documentation](https://docs.bota.dev) for backend integration details.

## License

MIT
