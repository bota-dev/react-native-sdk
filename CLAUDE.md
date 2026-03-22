# CLAUDE.md - Bota React Native SDK

This file provides context for Claude Code when working in this repository.

## Repository Overview

This is the **Bota React Native SDK** (`@bota-dev/react-native-sdk`) - a React Native library for communicating with Bota wearable devices via Bluetooth Low Energy (BLE).

Published on npm: https://www.npmjs.com/package/@bota-dev/react-native-sdk

## Project Structure

```
react-native-sdk/
├── src/
│   ├── index.ts              # Public API exports
│   ├── BotaClient.ts         # Main client class
│   ├── ble/
│   │   ├── BleManager.ts     # BLE connection management
│   │   ├── constants.ts      # BLE UUIDs, commands, timeouts
│   │   └── parsers.ts        # Binary protocol parsers
│   ├── managers/
│   │   ├── DeviceManager.ts  # Device discovery, pairing, provisioning
│   │   ├── RecordingManager.ts # Recording sync and upload
│   │   └── OTAManager.ts     # Firmware updates
│   ├── protocol/
│   │   └── ProtocolHandler.ts # BLE transfer protocol implementation
│   ├── storage/
│   │   └── StorageManager.ts # AsyncStorage persistence
│   ├── upload/
│   │   ├── S3Uploader.ts     # S3 multipart upload
│   │   └── UploadQueue.ts    # Background upload queue
│   ├── models/               # TypeScript interfaces
│   └── utils/                # Errors, logging, retry logic
├── lib/                      # Build output (commonjs, module, typescript)
├── .github/workflows/
│   ├── ci.yml                # CI on push/PR
│   └── publish.yml           # Publish to npm on release
├── package.json
├── tsconfig.json
└── tsconfig.build.json
```

## Key Concepts

### Upload Methods

The SDK supports three upload methods based on device connectivity:

- **Bluetooth Sync**: Device transfers audio to app via BLE, app uploads to backend
- **WiFi Upload**: Device uploads directly to backend via WiFi (Bota Note)
- **Cellular Upload**: Device uploads directly to backend via cellular (Bota Pin 4G - future)

For WiFi/Cellular devices, the SDK supports:

- Device-side WiFi network scanning via BLE (`DeviceManager.scanWiFiNetworks`) — no platform dependencies, works on iOS and Android
- WiFi network configuration and provisioning (`configureWiFi`, `getWiFiStatus`, `subscribeToWiFiStatus`)
- Grant-based credential encryption (ChaCha20-Poly1305 via K_session)
- Device capability detection (`CAP_WIFI_UPLOAD`, `CAP_LTE_UPLOAD`, `CAP_BLE_SYNC`)

### Firmware Updates (OTA)

The SDK supports app-driven firmware updates via BLE:

- `OTAManager.performUpdate(device, firmware)` — orchestrates the full flow: download `.ufw` from URL → transfer to device via BLE → device writes to SD card → device reboots
- `ProtocolHandler.uploadFirmware(deviceId, firmwareData, onProgress)` — low-level BLE transfer: sends start command (0x08), data chunks (0x20) with flow control, verify command (0x09) with CRC32
- Uses a persistent BLE subscription to TRANSFER_STATUS for the entire upload to avoid missed notifications
- Progress events via `OtaStage`: `downloading` → `preparing` → `updating` → `verifying` → `completed`

### BLE Services (defined in `src/ble/constants.ts`)

- `SERVICE_BOTA_AUDIO` (B07A0001) - Audio streaming
- `SERVICE_BOTA_CONTROL` (B07A0002) - Device control, recording status
- `SERVICE_BOTA_PROVISIONING` (B07A0003) - Device pairing/provisioning
- `SERVICE_BOTA_STORAGE` (B07A0004) - Recording list and transfer
- `SERVICE_BOTA_WIFI_CONFIG` (B07A0006) - WiFi configuration (WiFi Upload)

### Device Types

- `Bota-Pin-*` - Basic BLE-only wearable (Bluetooth Sync)
- `Bota-Pin4G-*` - Wearable with cellular connectivity (Bluetooth Sync + Cellular Upload)
- `Bota-Note-*` - Note-taking device with WiFi (Bluetooth Sync + WiFi Upload)

### Token Types

- `dtok_` - Device token (written to device during provisioning)
- `up_` - Upload token (single-use, for S3 uploads)

### Audio Formats

The SDK supports multiple audio codecs from devices:

| Codec | BLE Value | MIME Type |
|-------|-----------|-----------|
| `opus_16k` | 0x02 | `audio/opus` |
| `opus_8k` | 0x03 | `audio/opus` |
| `pcm_16k` | 0x00 | `audio/wav` |
| `pcm_8k` | 0x01 | `audio/wav` |

When uploading, the `UploadInfo.contentType` should match the device's codec. The SDK passes this to S3 via the `Content-Type` header.

## Common Tasks

### Build

```bash
npm run build        # Build all targets (commonjs, module, typescript)
npm run typecheck    # Type check without emitting
npm run lint         # ESLint
npm run test         # Jest (currently passes with no tests)
```

### Release

1. Update version in `package.json`
2. Commit and push
3. Create a GitHub release with tag `vX.Y.Z`
4. CI automatically publishes to npm

### Local Development

To test changes locally in an app:

```bash
# In SDK directory
npm run build

# In app directory
npm install ../path/to/react-native-sdk
```

## Dependencies

### Peer Dependencies (required by consuming apps)

- `react` >= 18.0.0
- `react-native` >= 0.72.0
- `react-native-ble-plx` ^3.0.0
- `@react-native-async-storage/async-storage` ^1.21.0

### Runtime Dependencies

- `buffer` - Binary data handling
- `eventemitter3` - Event emitting

## Important Files

- `src/ble/constants.ts` - All BLE UUIDs and protocol constants
- `src/ble/parsers.ts` - Binary data parsing/encoding
- `src/protocol/ProtocolHandler.ts` - Recording transfer protocol
- `src/BotaClient.ts` - Main public API

## Public API

```typescript
import { BotaClient } from '@bota-dev/react-native-sdk';

// Configure
BotaClient.configure({ logLevel: 'info' });

// Device discovery
BotaClient.devices.startScan();
BotaClient.devices.on('deviceDiscovered', (device) => { ... });

// Connect and provision
const connected = await BotaClient.devices.connect(device);
await BotaClient.devices.provision(connected, deviceToken, 'production');

// Sync recordings
const recordings = await BotaClient.recordings.listRecordings(connected);
for await (const progress of BotaClient.recordings.syncRecording(...)) { ... }
```

## Connection Settings

The SDK provides methods to read/write per-device connection settings via BLE:

- `DeviceManager.readConnectionSettings(device)` — reads 8-byte binary from `DEVICE_SETTINGS` characteristic, returns `DeviceConnectionSettings`
- `DeviceManager.writeConnectionSettings(device, settings)` — serializes `DeviceConnectionSettings` to 8 bytes and writes to device

**Types:**
- `ConnectionType = 'wifi' | 'ble' | 'cellular'`
- `DeviceConnectionSettings` — `{ enabled_connections: { wifi: boolean, cellular: boolean }, upload_network_preference: ConnectionType[] }`

**BLE binary layout (8 bytes):** version(0x01), enabled_mask(bit 0: WiFi, bit 1: 4G), upload_net_pref[3] (1=WiFi, 2=BLE, 3=4G, 0=end), reserved[3].

Serialization helpers live in `src/ble/parsers.ts`: `serializeConnectionSettings()` and `parseConnectionSettings()`.

## Documentation Sync

- When the SDK's public API changes (new exports, renamed methods, changed signatures), update the public documentation (`docs/` at repo root) correspondingly if needed.
- This includes API reference pages, Quick Start guides, and any code examples that reference changed APIs.

## Related Repositories

- `bota-dev/examples` - Example apps using this SDK
- `bota-dev/docs` - API documentation (docs.bota.dev)
