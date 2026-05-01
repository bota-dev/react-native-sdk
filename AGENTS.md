# AGENTS.md — @bota-dev/react-native-sdk

Public React Native SDK for communicating with Bota wearable devices via Bluetooth. Full context in [CLAUDE.md](CLAUDE.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

## Documentation Rule

**Every code change must be accompanied by documentation updates.** After any change, check and update as needed:

1. **`CLAUDE.md`** — key files, Bluetooth protocol, API surface, pitfalls
2. **`ARCHITECTURE.md`** — module map, data flows, protocol details
3. **`AGENTS.md`** — key files, verify steps, conventions (this file)
4. **`README.md`** — if the public API changed (this is a public SDK)
5. **`../internal-docs/`** — if the change implements, partially implements, or diverges from a design doc: update the doc status/content, and update the Status column in the Design Docs table at the bottom of this file. See [`../internal-docs/AGENTS.md`](../internal-docs/AGENTS.md) for the four sync cases.
6. **`../docs/`** — update public API reference if any public method changed

See the downstream impact matrix in [`../internal-docs/CLAUDE.md`](../internal-docs/CLAUDE.md).

## Build

```bash
npm install
npm run build       # tsup → lib/ (CJS + ESM + .d.ts)
```

## Test

```bash
npm test            # Vitest unit tests
```

## Verify Changes

1. Run `npm test` — all tests must pass
2. Run `npm run build` — must produce clean lib/ output (no type errors)
3. **Test against physical device**: link into demo app (see Local Testing below) and run the affected flow:
   - **Bluetooth discovery changes** — scan for devices, verify Bota-* prefix filtering
   - **Recording transfer changes** — sync a recording end-to-end (list → transfer → confirm)
   - **Provisioning changes** — pair a fresh device, verify token write and pairing state
   - **Status changes** — verify DEVICE_STATUS notifications update correctly
4. Check no regressions in unrelated Bluetooth flows

### Local Testing in Demo App

```bash
# 1. In this repo
rm -rf node_modules && npm install && npm run build

# 2. In demo/app
npm install ../react-native-sdk
npx expo start --clear
```

## Code Conventions

**Protocol fidelity** — the Bluetooth protocol is defined in [`../internal-docs/device/FIRMWARE_INTEGRATION_GUIDE.md`](../internal-docs/device/FIRMWARE_INTEGRATION_GUIDE.md) and [`../internal-docs/device/Device-App%20Protocol.md`](../internal-docs/device/Device-App%20Protocol.md). The SDK implements exactly what's specified there. Any deviation must be updated in the spec first.

**Binary parsing** — device data is binary (packed C structs). Use the typed parsers in `src/ble/parsers.ts`. Never parse binary inline in handlers.

**Event-driven async** — public APIs use async/await. Internal Bluetooth event handling uses EventEmitter. Never block the Bluetooth callback thread.

**Upload queue** — recordings are queued in `UploadQueue` (persistent SQLite). Never upload synchronously in the Bluetooth transfer callback.

**No server calls** — the SDK communicates only with the Bota device (BLE) and S3 (presigned URLs provided by the customer backend). It never calls the Bota API directly. Auth tokens are passed in by the customer app.

**Minimal permissions** — only request Bluetooth + background processing. Never request location or camera.

**Public API surface** — everything exported from `src/index.ts` is public and semver-versioned. Be conservative about adding to it. Internal modules are not exported.

## Key Files

| File | Purpose |
| --- | --- |
| `src/index.ts` | Public API exports |
| `src/BotaClient.ts` | Main entry point (singleton) |
| `src/ble/BLEManager.ts` | Low-level Bluetooth ops (CoreBluetooth/Android Bluetooth via react-native-ble-plx) |
| `src/ble/constants.ts` | Bluetooth service + characteristic UUIDs (B07A prefix) |
| `src/ble/parsers.ts` | Binary struct parsers (DeviceStatus, RecordingEntry, etc.) |
| `src/ble/protocol.ts` | Protocol handler (Bluetooth packet assembly, ACK logic) |
| `src/managers/DeviceManager.ts` | Device discovery, connection, bonding, provisioning |
| `src/managers/RecordingManager.ts` | Recording list, Bluetooth transfer, upload orchestration |
| `src/upload/UploadQueue.ts` | Persistent SQLite upload queue with retry |
| `src/storage/StorageManager.ts` | Local SQLite persistence (device registry, transfer state) |
| `src/models/` | TypeScript types (Device, Recording, DeviceStatus, etc.) |

## Design Docs

All design docs live in [`../internal-docs/`](../internal-docs/).

| Doc | Covers | Status |
| --- | --- | --- |
| [Mobile SDK System Design](../internal-docs/Mobile%20SDK%20System%20Design.md) | Full SDK architecture, upload queue, windowed transfer | In progress |
| [FIRMWARE_INTEGRATION_GUIDE](../internal-docs/device/FIRMWARE_INTEGRATION_GUIDE.md) | Bluetooth GATT service defs, recording transfer protocol, heartbeat | ✅ Complete (protocol reference) |
| [Device-App Protocol](../internal-docs/device/Device-App%20Protocol.md) | Bluetooth service definitions, OTA protocol | ✅ Complete |
| [Bluetooth Reliable Transfer Design](../internal-docs/device/BLE%20Reliable%20Transfer%20Design.md) | v2 windowed transfer (sliding window, replaces stop-and-wait) | ⬜ Not implemented |
| [Upload-Management](../internal-docs/device/Upload-Management.md) | Bluetooth sync, WiFi/4G direct upload, recovery, failover | ✅ Done |
| [Device-Provisioning](../internal-docs/device/Device-Provisioning.md) | Bluetooth pairing, token write, QR claim flow | ✅ Done |
| [WiFi-Configuration](../internal-docs/device/WiFi-Configuration.md) | WiFi credential provisioning via Bluetooth WIFI_CONFIG service | MVP done |
| [Connection-Management](../internal-docs/device/Connection-Management.md) | Connection lifecycles, Bluetooth reconnect strategy | ✅ Done |
| [Device–App–Backend Security](../internal-docs/device/Device%E2%80%93App%E2%80%93Backend%20Security%20%26%20Communication%20Design.md) | Auth model, Grant tokens (v1), MVP limitations | MVP done |
