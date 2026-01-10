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

### BLE Services (defined in `src/ble/constants.ts`)

- `SERVICE_BOTA_AUDIO` (B07A0001) - Audio streaming
- `SERVICE_BOTA_CONTROL` (B07A0002) - Device control, recording status
- `SERVICE_BOTA_PROVISIONING` (B07A0003) - Device pairing/provisioning
- `SERVICE_BOTA_STORAGE` (B07A0004) - Recording list and transfer

### Device Types

- `Bota-Pin-*` - Basic BLE-only wearable
- `Bota-Pin4G-*` - Wearable with cellular connectivity
- `Bota-Note-*` - Note-taking device

### Token Types

- `dtok_` - Device token (written to device during provisioning)
- `up_` - Upload token (single-use, for S3 uploads)

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

## Related Repositories

- `bota-dev/examples` - Example apps using this SDK
- `bota-dev/docs` - API documentation (docs.bota.dev)
