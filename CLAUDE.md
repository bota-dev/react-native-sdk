# CLAUDE.md - Bota React Native SDK

> **Updated 2026-07:** DEVICE_SETTINGS byte 9 carries the explicit direct-heartbeat mask; legacy payloads parse as WiFi and cellular enabled. Each missing/null radio idle timeout independently defaults to 180 seconds during serialization, and legacy 1-9 second values round up to the 10-second wire minimum.

See [AGENTS.md](AGENTS.md) for build commands and conventions. See [ARCHITECTURE.md](ARCHITECTURE.md) for module map and protocol details.

**Documentation rule:** Every public API change must include documentation updates — `CLAUDE.md`, `ARCHITECTURE.md`, `AGENTS.md`, `README.md`, public docs (`../docs/`) as needed, and `../internal-docs/` if the change implements or invalidates a design doc. See [`../internal-docs/CLAUDE.md`](../internal-docs/CLAUDE.md) for the downstream impact matrix.

This file provides context for Claude Code when working in this repository.

## Repository Overview

This is the **Bota React Native SDK** (`@bota.dev/react-native-sdk`) - a React Native library for communicating with Bota wearable devices via Bluetooth Low Energy (BLE).

Published on npm: https://www.npmjs.com/package/@bota.dev/react-native-sdk

Native platform implementations are maintained independently in sibling repositories:

- iOS: [`../bota-mobile-sdk-ios`](../bota-mobile-sdk-ios) (`BotaSDK`)
- Android: [`../bota-mobile-sdk-android`](../bota-mobile-sdk-android) (`com.bota.sdk`)

Future backend API SDKs use the separate `bota-api-sdk-*` naming family.

## Project Structure

```
react-native-sdk/
├── src/
│   ├── index.ts              # Public API exports
│   ├── BotaClient.ts         # Main client class
│   ├── ble/
│   │   ├── BleManager.ts     # Bluetooth connection management
│   │   ├── constants.ts      # Bluetooth UUIDs, commands, timeouts
│   │   ├── deviceLogs.ts     # B07A0007 diagnostic log packet decoder
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
- Safe direct-upload handoff: trigger-busy, BLE loss, or unreadable status keeps WiFi/cellular ownership; BLE fallback requires a fresh `syncActive=false` status

### P2 Grant Auth (Recording Commands)

BLE recording commands (start/stop) are gated by an HPKE-encrypted, ECDSA-signed short-lived grant:

- `DeviceManager.writeGrant(device, grantBlob)` — writes 171-byte base64 grant blob to `CHAR_DEVICE_COMMAND`. Device decrypts via DHKEM-P256 + HKDF-SHA256 + ChaCha20-Poly1305 and verifies ECDSA-P256 signature.
- `DeviceManager.requestStartRecording(device, grantBlob)` / `requestStopRecording(device, grantBlob)` — write grant to device, then send opcode to `CHAR_RECORDING_CONTROL`. Grant blob comes from `POST /v1/devices/{id}/grant` (TTL = 300s).
- Grant blob is opaque at SDK layer — 171 bytes = enc[65] ‖ ct[106].
- **P6 nonce handling:** `DeviceManager.readAuthNonce()` always issues a fresh BLE read against `CHAR_AUTH_NONCE` (not a cache lookup). The firmware rotates its session nonce on **every** well-formed grant attempt — success AND most rejection paths per the P6 design — so any cached value is stale immediately after the previous grant. An earlier version of this method returned cached values and produced "nonce mismatch / process result: -1" failures on every recording after the first. The NOTIFY-populated cache is kept only as a fallback for hypothetical NOTIFY-only firmware variants where READ isn't supported.

### P5.B Grant-Gated Deprovision / Factory Reset

Since P5, the firmware rejects unauthenticated factory-reset opcodes and **rejects token writes while paired** (security measure to prevent stolen-device hijacking). Cleanup requires a backend-signed deprovision grant (`GRANT_SCOPE_DEPROVISION = 0x08`):

- `DeviceManager.deprovision(device, grantBlob)` — opcode `0x05` to `CHAR_DEVICE_COMMAND`. Clears token + pairing state. **No reboot** — connection stays up. Use for rebind flows.
- `DeviceManager.bleFactoryReset(device, grantBlob, persistResult)` — sends opcode `0x06`, requires the exact three-byte wipe-success result, awaits the caller's durable `persistResult` callback, then writes DEVICE_COMMAND `0x0A`. A malformed result or rejected persistence callback prevents `0x0A`, so firmware remains WIPED and replayable. A failed opcode write cancels the pending result subscription.
- `DeviceManager.resumeBleFactoryReset(device, persistResult)` — subscribes for a replayed WIPED result after reconnect and completes the same persist-before-`0x0A` sequence without resending the grant or opcode `0x06`. Backend command finalization remains app orchestration and is intentionally outside the SDK.
- Grant blob comes from `POST /dashboard/projects/:projectId/devices/:deviceId/deprovision-grant` — same wire format as recording grant, scope = `0x08`. The endpoint enforces project-membership authorization; the grant is HPKE-encrypted to the device's `pk_d` and ECDSA-signed.

**Auto-recovery on rebind:** `DeviceManager.provision(device, token, env, options)` accepts `options.fetchDeprovisionGrant: (nonce_d) => Promise<grant_blob>`. When supplied and the device returns `ALREADY_PAIRED`, the SDK reads the P6 session nonce, invokes the fetcher, performs an opcode-0x05 deprovision, and retries the token write — all on the same BLE connection, transparent to the caller. Without the fetcher, `provision()` throws `ProvisioningError [ALREADY_PAIRED]` so callers can drive recovery manually. See [internal-docs Device-Provisioning §3](../internal-docs/device/Device-Provisioning.md#3-device-rebinding-change-user) for the full sequence diagram.

Factory reset is intentionally distinct from this rebind recovery. See
[Device-Provisioning §3.1](../internal-docs/device/Device-Provisioning.md#31-authenticated-factory-reset)
for the approved remote/BLE close-loop and current implementation status.

### BLE Radio Arbitration (`BleManager`)

Every completed physical connect writes UTC Unix time through `TIME_SYNC`
before emitting `deviceConnected`. The supplied timezone offset is display
metadata and does not change the firmware RTC timezone. This write is
best-effort so legacy firmware remains connectable.

The BLE adapter is a single shared resource. `BleManager` owns a FIFO `radioChain` that serialises every `connect`/`disconnect` so the pairing path and the auto-reconnect loop can't issue concurrent `connectToDevice` calls (which would tear down each other on iOS, observed as a 2A26-read disconnect during pair). Every `connect` calls `stopScan()` first — a running scan can cancel an in-flight connect on iOS. Ops carry `priority: 'user' | 'background'`; `user` (the default for `DeviceManager.connect`) marks `BleManager.isUserOpInFlight()`, and the auto-reconnect loop in `DeviceManager.startAutoReconnectLoop` skips its tick while that's true — so a user-initiated pair autonomously preempts background reconnection instead of racing it. **The user-op state is a refcount, not a per-op boolean, and a user `DeviceManager.connect` holds it across the WHOLE transaction (connect + the device-info GATT reads) via `BleManager.beginUserTransaction()` → release-in-`finally`.** User-priority connects always read serial/device info fresh from GATT, even if `connectedDevices` already has the BLE id; only background reconnect may return an existing connected entry or use the `reconnectRegistry` fast path. When a fresh user connect learns that a BLE id belongs to a different serial than the cache said, stale same-bleId registry entries are removed before saving the new mapping. Auto-reconnect first matches stored peripheral ID or advertised MAC. If neither exact identity appears after the scan window, it may connect to same-model Bota candidates and read SN `0x2A25`, including when a flash changed a previously stored advertised MAC; the probe runs only while no user radio work is in flight and accepts only the requested serial. Handled background connect failures log at debug with the BLE reason, while user-priority connect failures stay error-level. The pre-existing `DeviceManager.reconnectChain` is kept: it serialises reconnect *scan windows* across SNs, which is a different granularity. See [internal-docs/device/Connection-Management.md §2.1.1](../internal-docs/device/Connection-Management.md#211-ble-radio-arbitration).

### Device Debug Logs

`DeviceLogDecoder` emits complete firmware UTF-8 lines only. It still tracks the packet sequence and dropped-byte flag so it can discard a partial line after transport loss, but sequence gaps are recovery metadata and do not appear as synthetic warning events in an application's log list.

### Live BLE Streaming — Trailer Handling

Firmware emits the OGG/Opus post-fclose tail (final-page flush + EOS page) as additional DATA packets at the end of a live streaming transfer, before the EOF packet. The SDK's existing DATA-packet handler appends them transparently — no SDK change required for byte-equivalence with the device's SD file. The EOF packet's CRC32 covers the trailer bytes too. See firmware `le_trans_data.c` "Post-stream trailer drain" block.

Recording-transfer error `0x14` means the requested encrypted file exists but
the device storage root key is unavailable. `TransferError.deviceError()` maps
it to `STORAGE_KEY_UNAVAILABLE`; do not present it as file-not-found or retry it
indefinitely.

### BLE SHA-256 — End-to-End Integrity Verification

Both transfer paths (`transferRecording` and `streamTransfer`) recognize a new `BOTA_PKT_TYPE_SHA256 = 0x04` packet emitted by firmware right after EOF on `CHAR_RECORDING_TRANSFER` (33 bytes: `[0x04, sha256[32]]`). Wire-up:

- **EOF holds the resolve.** When EOF arrives in `ProtocolHandler`, the transfer is **not** finalized immediately — `state.eofReceived = true` and a 200ms `SHA256_GRACE_WINDOW_MS` timer starts. Either the SHA packet arrives within the window (timer cancelled, finalize immediately with the hash) OR the timer fires (finalize without a hash, pre-P9.F2 firmware path).
- **`transferRecording`** returns `{ data, e2eEncrypted, sha256? }` (hex string, 64 chars).
- **`streamTransfer`** returns `{ totalBytes, checksum, sha256? }`.
- **`RecordingManager.syncRecording`** emits `contentSha256` on the `transferring` and `completed` stages of its `SyncProgress` generator AND forwards it on the upload-task so the SDK's `notifyCompletion` includes `content_sha256` in the `/upload-complete` POST body.
- **Backward-compat both directions**: old SDKs ignore the unknown 0x04 packet type; new SDK on old firmware sees the 200ms grace window time out and resolves without a hash (no integrity verify, same as before). E2E relay path (P10) suppresses SHA forwarding — backend decrypts and hashes plaintext on receipt, no client SHA in scope.

End-to-end: device computes SHA over SD bytes at `recording_stop` → emits over BLE after EOF → SDK forwards in upload-complete body → backend integrity-verify worker (P9.B) compares against a server-side SHA of the assembled S3 object → mismatch sets `status=integrity_failure`. This closes the BLE gap and gives parity with the WiFi/4G direct-upload path.

### Firmware Updates (OTA)

The SDK supports app-driven firmware updates via Bluetooth:

- `OTAManager.performUpdate(device, firmware)` — orchestrates the full flow: download `.ufw` from URL → transfer to device via Bluetooth → device writes to SD card → device reboots
- Firmware downloads use `XMLHttpRequest` so `downloading` progress events include optional `bytesTransferred` and `totalBytes` alongside normalized `progress`
- `ProtocolHandler.uploadFirmware(deviceId, firmwareData, onProgress)` — low-level Bluetooth transfer: sends start command (0x08), data chunks (0x20) with flow control, verify command (0x09) with CRC32
- Uses a persistent Bluetooth subscription to TRANSFER_STATUS for the entire upload to avoid missed notifications
- Retains ACK sequence state even when no waiter is active; every 8-packet window requires its final ACK, and timeout is terminal (`FW_UPLOAD_ACK_TIMEOUT`)
- Treats any nonzero READY result received after upload acceptance as a terminal SD/FAT write failure (`FW_STORAGE_WRITE_FAILED`) instead of continuing to report transfer progress
- Progress events via `OtaStage`: `downloading` → `preparing` → `updating` → `verifying` → `completed`

### Bluetooth Services (defined in `src/ble/constants.ts`)

- `SERVICE_BOTA_AUDIO` (B07A0001) - Audio streaming
- `SERVICE_BOTA_CONTROL` (B07A0002) - Device control, recording status
- `SERVICE_BOTA_PROVISIONING` (B07A0003) - Device pairing/provisioning
- `SERVICE_BOTA_STORAGE` (B07A0004) - Recording list and transfer
- `SERVICE_BOTA_AUTH` (B07A0005) - Device cryptographic identity (Ed25519 PK_D) — v1+ firmware only
- `SERVICE_BOTA_WIFI_CONFIG` (B07A0006) - WiFi configuration (WiFi Upload)

### Device Identity (Auth Service)

`DeviceManager.readPublicKey(device)` reads the device's secp256r1 public key (PK_D) from `SERVICE_BOTA_AUTH` char `CHAR_PK_D` (B07A0005-0001). Returns a 128-char lowercase hex string (64 bytes, raw x‖y), or `null` if the Auth service is absent (legacy firmware) or if the read returns the wrong length. Used during bind to register PK_D on the backend. Pairing must use a `ConnectedDevice` whose serial was freshly read from the same BLE peripheral; never combine cached serial identity with a fresh PK_D read.

### Device State Cache (in-memory, SN-keyed)

`DeviceManager` holds a `DeviceStateCache` — the single in-memory snapshot of last-known-good BLE-sourced state per paired device, keyed by serial number. Fed automatically by `getWiFiStatus()` and `subscribeToWiFiStatus()`; consumers query it synchronously to render UI without waiting on a fresh BLE round-trip:

```typescript
const wifi = BotaClient.devices.getCachedWiFiStatus(serialNumber); // sync, may be null
const all = BotaClient.devices.getCachedDeviceState(serialNumber); // sync, may be null

// Push values the SDK can't observe BLE-side (e.g. SSID typed by the user
// before the firmware echoes it back), or rehydrate persisted state on app launch:
BotaClient.devices.updateCachedDeviceState(serialNumber, {
  wifiStatus: { status: 'connected', ssid: 'Guest' },
});

// React to cache changes (push-based UI updates):
const sub = BotaClient.devices.onCachedDeviceStateChanged((sn, patch, state) => { ... });

// Clear on unpair / factory reset / logout:
BotaClient.devices.clearCachedDeviceState(serialNumber);
BotaClient.devices.clearAllCachedDeviceStates();
```

Merge semantics on `updateCachedDeviceState` (and internal cache writes):

- `undefined` on a field = "no info" → preserve the prior cached value.
- `null` on a top-level sub-record (e.g. `{ wifiStatus: null }`) = explicit clear.
- A present value = overwrite.

This contract is the one that bit every consumer who naively did `{ ...prev, ...patch }`: a partial BLE read with `ssid: undefined` would otherwise wipe a known-good SSID. The cache enforces the right merge once.

**Not in scope:** persistence (the SDK is in-memory only — consumers serialize to SecureStore/AsyncStorage themselves and rehydrate via `updateCachedDeviceState` on launch), TTL (staleness is implicit — consumers who want strict freshness call `clearCachedDeviceState(sn)` on `deviceDisconnected`).

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
npm run test         # Jest unit tests
```

The development toolchain uses Node 22.13+, React Native 0.87, React 19,
TypeScript 6, Builder Bob 0.43, AsyncStorage 3, Jest 30, and ESLint 10. ESLint
configuration is defined in `eslint.config.mjs` using the flat-config format.

### Release

1. Update version in `package.json`
2. Commit and push
3. Create a GitHub release with tag `vX.Y.Z`
4. CI automatically publishes to npm

### Local Development (testing SDK changes in a consuming app)

Applies to any consuming app — `demo/app` or `bota-one/app`. The SDK's
`react-native` / `source` package fields point at `src/index.ts`, so **Metro
transforms the SDK source directly — there is no build step for local
testing.** Editing a `.ts` file under `src/` and reloading Metro is enough.

```bash
# 1. From this SDK worktree, register the local package.
yarn link

# 2. From the demo repository root, link it into the app workspace.
#    This does not change package manifests or lockfiles.
yarn workspace @bota-demo/app link @bota.dev/react-native-sdk

# 3. Start the demo app with a clear Metro cache.
cd app && npx expo start --clear
```

After each SDK source change, just **reload Metro** (the symlinked source is
re-read on `--clear`). Repeat the demo-root link command only if the link was
replaced by a dependency install. No native rebuild unless you changed native
modules.

> **Do NOT `npm run build` / `npm install` inside `react-native-sdk` while an
> app is consuming it locally.** Building requires the SDK's node_modules, and
> the moment they exist Metro resolves the app's native deps from there →
> `TurboModule` / `PlatformConstants` crash. Building is only for publishing
> (see Release), done in a separate checkout or after unlinking.

**Troubleshooting:**
- `TurboModuleRegistry.getEnforcing(...): 'PlatformConstants' could not be found` → SDK's `node_modules` still exists, delete it
- `NativeModule: AsyncStorage is null` → same cause, delete SDK's `node_modules`
- `Unable to resolve "eventemitter3"` → install SDK runtime deps in the app: `npm install eventemitter3 buffer`
- If types don't update, delete `node_modules/.cache` in the app
- If the app still uses the old (published) SDK, run `require.resolve('@bota.dev/react-native-sdk/package.json')` from `demo/app`; it must point to this SDK worktree. If not, re-run the demo-root link command and restart with `--clear`.

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
- `src/ble/deviceLogs.ts` - Firmware diagnostic log packet decoder; normalizes Hermes `Uint8Array` views to `Buffer` before UTF-8 conversion
- `src/ble/parsers.ts` - Binary data parsing/encoding
- `src/protocol/ProtocolHandler.ts` - Recording transfer protocol
- `src/BotaClient.ts` - Main public API

## Public API

```typescript
import { BotaClient } from '@bota.dev/react-native-sdk';

// Configure
BotaClient.configure({ logLevel: 'info' });

// Device discovery
BotaClient.devices.startScan();
BotaClient.devices.on('deviceDiscovered', (device) => { ... });

// Connect and provision
const connected = await BotaClient.devices.connect(device);
await BotaClient.devices.provision(connected, deviceToken, 'production');

// Firmware diagnostics (requires DEBUG=1 firmware)
const unsubscribe = await BotaClient.devices.subscribeToDeviceLogs(connected, event => {
  console.log(event.level, event.message, event.isBacklog);
});
unsubscribe();

// Sync recordings
const recordings = await BotaClient.recordings.listRecordings(connected);
for await (const progress of BotaClient.recordings.syncRecording(...)) { ... }
```

Device logs have one owner per connected device across both pending Start and active
states. Overlapping calls reject with `DeviceError` code `ALREADY_SUBSCRIBED`.

## Sync Status (centralized derivation)

`deriveSyncStatus(inputs)` is a pure function that returns the single canonical "what's happening with the recordings right now" status for any consumer screen — sync banners, pending-recordings rows, recording detail pages, list-item subtitles. Putting it in the SDK means every Bota-platform app (demo, bota-one, and any third-party app) gets identical precedence rules without each one re-deriving from raw flags.

```typescript
import { deriveSyncStatus, type SyncStatus } from '@bota.dev/react-native-sdk';

const status: SyncStatus = deriveSyncStatus({
  appDriving: { active: isSyncing, currentIndex, total },
  device: {
    syncActive: status.flags.syncActive,
    isRecording: status.isRecording,
    wifiConnected: status.flags.wifiConnected,
    lteConnected: status.flags.lteConnected,
    wifiAttempting: WIFI_ATTEMPTING.has(status.wifiStatus ?? ''),
    lteAttempting: LTE_ATTEMPTING.has(status.lteStatus ?? ''),
    streamingEnabled: connSettings.streaming_enabled ?? false,
    // Optional: when provided, the streaming channel is resolved by upload
    // preference + enabled connections (matches firmware channel selection),
    // so a device with LTE up but BLE-preferred is shown as Bluetooth, not 4G.
    uploadPreference: connSettings.upload_network_preference,   // e.g. ['wifi','ble','cellular']
    enabledConnections: connSettings.enabled_connections,       // { wifi, cellular }
  },
  bleConnected: bleStatus === 'connected',
});
// status.label      → "Uploading 1/3 via 4G..."        (banner)
// status.shortLabel → "4G uploading 1/3"               (compact row)
// status.kind       → 'ble_pull' | 'wifi_upload' | 'lte_upload' | 'streaming' | 'waiting_channel' | 'idle'
// status.channel    → 'Bluetooth' | 'WiFi' | '4G' | undefined
```

**Precedence** (top wins): live streaming → device-side actual transport (WiFi/4G with `syncActive`) → app-driven BLE pull → waiting for radio → idle. Source: `src/sync/syncStatus.ts`. Consumer-side wiring (subscribing to the right stores/queries) is a thin app-level hook — see `demo/app/lib/hooks/useSyncStatus.ts` and `bota-one/app/lib/hooks/useSyncStatus.ts`.

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
