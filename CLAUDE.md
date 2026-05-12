# CLAUDE.md - Bota React Native SDK

See [AGENTS.md](AGENTS.md) for build commands and conventions. See [ARCHITECTURE.md](ARCHITECTURE.md) for module map and protocol details.

**Documentation rule:** Every public API change must include documentation updates — `CLAUDE.md`, `ARCHITECTURE.md`, `AGENTS.md`, `README.md`, public docs (`../docs/`) as needed, and `../internal-docs/` if the change implements or invalidates a design doc. See [`../internal-docs/CLAUDE.md`](../internal-docs/CLAUDE.md) for the downstream impact matrix.

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
│   │   ├── BleManager.ts     # Bluetooth connection management
│   │   ├── constants.ts      # Bluetooth UUIDs, commands, timeouts
│   │   └── parsers.ts        # Binary protocol parsers
│   ├── managers/
│   │   ├── DeviceManager.ts  # Device discovery, pairing, provisioning
│   │   ├── RecordingManager.ts # Recording sync and upload
│   │   └── OTAManager.ts     # Firmware updates
│   ├── protocol/
│   │   └── ProtocolHandler.ts # Bluetooth transfer protocol implementation
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

- **Bluetooth Sync**: Device transfers audio to app via Bluetooth, app uploads to backend
- **WiFi Upload**: Device uploads directly to backend via WiFi (Bota Note)
- **Cellular Upload**: Device uploads directly to backend via cellular (Bota Pin 4G - future)

For WiFi/Cellular devices, the SDK supports:

- Device-side WiFi network scanning via Bluetooth (`DeviceManager.scanWiFiNetworks`) — no platform dependencies, works on iOS and Android
- WiFi network configuration and provisioning (`configureWiFi`, `getWiFiStatus`, `subscribeToWiFiStatus`)
- Grant-based credential encryption (ChaCha20-Poly1305 via K_session)
- Device capability detection (`CAP_WIFI_UPLOAD`, `CAP_LTE_UPLOAD`, `CAP_BLE_SYNC`)

### P2 Grant Auth (Recording Commands)

BLE recording commands (start/stop) are gated by an HPKE-encrypted, ECDSA-signed short-lived grant:

- `DeviceManager.writeGrant(device, grantBlob)` — writes 171-byte base64 grant blob to `CHAR_DEVICE_COMMAND`. Device decrypts via DHKEM-P256 + HKDF-SHA256 + ChaCha20-Poly1305 and verifies ECDSA-P256 signature.
- `DeviceManager.requestStartRecording(device, grantBlob)` / `requestStopRecording(device, grantBlob)` — write grant to device, then send opcode to `CHAR_RECORDING_CONTROL`. Grant blob comes from `POST /v1/devices/{id}/grant` (TTL = 300s).
- Grant blob is opaque at SDK layer — 171 bytes = enc[65] ‖ ct[106].
- **P6 nonce handling:** `DeviceManager.readAuthNonce()` always issues a fresh BLE read against `CHAR_AUTH_NONCE` (not a cache lookup). The firmware rotates its session nonce on **every** well-formed grant attempt — success AND most rejection paths per the P6 design — so any cached value is stale immediately after the previous grant. An earlier version of this method returned cached values and produced "nonce mismatch / process result: -1" failures on every recording after the first. The NOTIFY-populated cache is kept only as a fallback for hypothetical NOTIFY-only firmware variants where READ isn't supported.

### P5.B Grant-Gated Deprovision / Factory Reset

Since P5, the firmware rejects unauthenticated factory-reset opcodes and **rejects token writes while paired** (security measure to prevent stolen-device hijacking). Cleanup requires a backend-signed deprovision grant (`GRANT_SCOPE_DEPROVISION = 0x08`):

- `DeviceManager.deprovision(device, grantBlob)` — opcode `0x05` to `CHAR_DEVICE_COMMAND`. Clears token + pairing state. **No reboot** — connection stays up. Use for rebind flows.
- `DeviceManager.bleFactoryReset(device, grantBlob)` — opcode `0x06`. Clears token + pairing + WiFi creds + conn_policy, then reboots. Use for full delete-device flows.
- Grant blob comes from `POST /dashboard/projects/:projectId/devices/:deviceId/deprovision-grant` — same wire format as recording grant, scope = `0x08`. The endpoint enforces project-membership authorization; the grant is HPKE-encrypted to the device's `pk_d` and ECDSA-signed.

**Auto-recovery on rebind:** `DeviceManager.provision(device, token, env, options)` accepts `options.fetchDeprovisionGrant: (nonce_d) => Promise<grant_blob>`. When supplied and the device returns `ALREADY_PAIRED`, the SDK reads the P6 session nonce, invokes the fetcher, performs an opcode-0x05 deprovision, and retries the token write — all on the same BLE connection, transparent to the caller. Without the fetcher, `provision()` throws `ProvisioningError [ALREADY_PAIRED]` so callers can drive recovery manually. See [internal-docs Device-Provisioning §3](../internal-docs/device/Device-Provisioning.md#3-device-rebinding-change-user) for the full sequence diagram.

### Live BLE Streaming — Trailer Handling

Firmware now emits the OGG/Opus post-fclose tail (final-page flush + EOS page) as additional DATA packets at the end of a live streaming transfer, before the EOF packet. The SDK's existing DATA-packet handler appends them transparently — no SDK change required for byte-equivalence with the device's SD file. The EOF packet's CRC32 covers the trailer bytes too. See firmware `le_trans_data.c` "Post-stream trailer drain" block.

**Open follow-up (server-side integrity verification on BLE-streamed recordings):** the SDK currently does not read or forward `content_sha256` from the device on the BLE path. The device computes a SHA-256 over the SD file at recording stop (`recording_compute_file_sha256`) and exposes it via `recording_get_last_sha256_hex()` in firmware, but there is no BLE characteristic or packet that surfaces it to the SDK today. To enable end-to-end integrity verification on BLE-streamed uploads (parity with the WiFi/4G direct-upload path), the SDK would need to: (1) read `content_sha256` from the device after the streaming transfer completes (new BLE read or appended EOF payload), and (2) include it in the `/v1/recordings/:id/upload-complete` or `/finalize` call dispatched from the host app. Without this, BLE-streamed recordings now have structurally complete S3 objects (trailer fix above) but are not server-verified.

### Firmware Updates (OTA)

The SDK supports app-driven firmware updates via Bluetooth:

- `OTAManager.performUpdate(device, firmware)` — orchestrates the full flow: download `.ufw` from URL → transfer to device via Bluetooth → device writes to SD card → device reboots
- `ProtocolHandler.uploadFirmware(deviceId, firmwareData, onProgress)` — low-level Bluetooth transfer: sends start command (0x08), data chunks (0x20) with flow control, verify command (0x09) with CRC32
- Uses a persistent Bluetooth subscription to TRANSFER_STATUS for the entire upload to avoid missed notifications
- Progress events via `OtaStage`: `downloading` → `preparing` → `updating` → `verifying` → `completed`

### Bluetooth Services (defined in `src/ble/constants.ts`)

- `SERVICE_BOTA_AUDIO` (B07A0001) - Audio streaming
- `SERVICE_BOTA_CONTROL` (B07A0002) - Device control, recording status
- `SERVICE_BOTA_PROVISIONING` (B07A0003) - Device pairing/provisioning
- `SERVICE_BOTA_STORAGE` (B07A0004) - Recording list and transfer
- `SERVICE_BOTA_AUTH` (B07A0005) - Device cryptographic identity (Ed25519 PK_D) — v1+ firmware only
- `SERVICE_BOTA_WIFI_CONFIG` (B07A0006) - WiFi configuration (WiFi Upload)

### Device Identity (Auth Service)

`DeviceManager.readPublicKey(device)` reads the device's secp256r1 public key (PK_D) from `SERVICE_BOTA_AUTH` char `CHAR_PK_D` (B07A0005-0001). Returns a 128-char lowercase hex string (64 bytes, raw x‖y), or `null` if the Auth service is absent (legacy firmware) or if the read returns the wrong length. Used during bind to register PK_D on the backend.

### Device Types

- `Bota-Pin-*` - Basic Bluetooth-only wearable (Bluetooth Sync)
- `Bota-Pin4G-*` - Wearable with cellular connectivity (Bluetooth Sync + Cellular Upload)
- `Bota-Note-*` - Note-taking device with WiFi (Bluetooth Sync + WiFi Upload)

### Token Types

- `dtok_` - Device token (written to device during provisioning)
- `up_` - Upload token (single-use, for S3 uploads)

### Audio Formats

The SDK supports multiple audio codecs from devices:

| Codec | Bluetooth Value | MIME Type |
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

### Local Development with Demo App

To test SDK changes locally against the demo app:

```bash
# 1. Build the SDK
cd react-native-sdk
npm run build

# 2. Install locally in the demo app
cd ../demo/app
npm install ../../react-native-sdk

# 3. Clear cache and start
npx expo start --clear
```

After making further SDK changes, repeat steps 1-2 and reload the app. No native rebuild needed unless you changed native modules.

**IMPORTANT:** You must delete the SDK's `node_modules` before testing locally. When the app symlinks to the SDK source, Metro follows the symlink and resolves dependencies from the SDK's `node_modules` instead of the app's. This causes native module errors (`TurboModuleRegistry`, `NativeModule: AsyncStorage is null`) because the SDK's copies aren't linked to native code.

```bash
# Delete SDK's node_modules (required for local testing)
rm -rf react-native-sdk/node_modules

# Re-install when you need to build the SDK again
cd react-native-sdk && npm install && npm run build
```

**Troubleshooting:**
- `TurboModuleRegistry.getEnforcing(...): 'PlatformConstants' could not be found` → SDK's `node_modules` still exists, delete it
- `NativeModule: AsyncStorage is null` → same cause, delete SDK's `node_modules`
- `Unable to resolve "eventemitter3"` → install SDK runtime deps in the app: `cd demo/app && npm install eventemitter3 buffer`
- If types don't update, delete `node_modules/.cache` in the app
- If the app still uses the old SDK, stop Metro, run `npm install ../../react-native-sdk` again, and restart with `--clear`

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

- `src/ble/constants.ts` - All Bluetooth UUIDs and protocol constants
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

The SDK provides methods to read/write per-device connection settings via Bluetooth:

- `DeviceManager.readConnectionSettings(device)` — reads 8-byte binary from `DEVICE_SETTINGS` characteristic, returns `DeviceConnectionSettings`
- `DeviceManager.writeConnectionSettings(device, settings)` — serializes `DeviceConnectionSettings` to 8 bytes and writes to device

**Types:**
- `ConnectionType = 'wifi' | 'ble' | 'cellular'`
- `DeviceConnectionSettings` — `{ enabled_connections: { wifi: boolean, cellular: boolean }, upload_network_preference: ConnectionType[] }`

**Bluetooth binary layout (8 bytes):** version(0x01), enabled_mask(bit 0: WiFi, bit 1: 4G), upload_net_pref[3] (1=WiFi, 2=BLE, 3=4G, 0=end), reserved[3].

Serialization helpers live in `src/ble/parsers.ts`: `serializeConnectionSettings()` and `parseConnectionSettings()`.

## Documentation Sync

- When the SDK's public API changes (new exports, renamed methods, changed signatures), update the public documentation (`docs/` at repo root) correspondingly if needed.
- This includes API reference pages, Quick Start guides, and any code examples that reference changed APIs.

## Related Repositories

- `bota-dev/examples` - Example apps using this SDK
- `bota-dev/docs` - API documentation (docs.bota.dev)
