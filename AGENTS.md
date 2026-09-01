# AGENTS.md — @bota.dev/react-native-sdk

Public React Native SDK for communicating with Bota wearable devices via Bluetooth. Full context in [CLAUDE.md](CLAUDE.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

## SDK Family

- React Native: this repository (`@bota.dev/react-native-sdk`, with the
  `BotaClient` compatibility entry point)
- Target source monorepo: [`../app-sdk`](../app-sdk), including the public Apple
  module `BotaAppleSDK`
- Legacy Apple migration input: [`../bota-mobile-sdk-ios`](../bota-mobile-sdk-ios)
  (`BotaSDK` remains its module name)
- Legacy Android migration input:
  [`../bota-mobile-sdk-android`](../bota-mobile-sdk-android) (`com.bota.sdk`
  remains its namespace)
- Target application-embedded family name: **Bota App SDK**
- Future backend-facing family name: **Bota API SDK**

The `app-sdk` repository is the target Rust-core source monorepo. This React
Native package remains supported throughout migration, while the legacy native
repositories remain migration inputs until their parity and release gates pass.
Do not describe incomplete target packages as shipped. See
[App SDK Architecture](../internal-docs/App%20SDK%20Architecture.md).

## Documentation Rule

**Every code change must be accompanied by documentation updates.** After any change, check and update as needed:

1. **`CLAUDE.md`** — key files, Bluetooth protocol, API surface, pitfalls
2. **`ARCHITECTURE.md`** — module map, data flows, protocol details
3. **`AGENTS.md`** — key files, verify steps, conventions (this file)
4. **`README.md`** — if the public API changed (this is a public SDK)
5. **`../internal-docs/`** — if the change implements, partially implements, or diverges from a design doc: update the doc status/content, and update the Status column in the Design Docs table at the bottom of this file. See [`../internal-docs/AGENTS.md`](../internal-docs/AGENTS.md) for the four sync cases.
6. **`../docs/`** — update public API reference if any public method, Bluetooth protocol behavior, characteristic, or data format changed (protocol changes are breaking for customer integrations — docs must stay in sync)

See the downstream impact matrix in [`../internal-docs/CLAUDE.md`](../internal-docs/CLAUDE.md).

## Compound Engineering

Follow the **Plan → Work → Review → Compound** loop ([source](https://every.to/guides/compound-engineering)):

1. **Plan first** — for any non-trivial task, state your approach and verify assumptions before writing code. 80% of value is in the plan.
2. **Use skills** — invoke the relevant skill (see Superpowers) before starting work in a new area.
3. **Compound** — after every change, update `CLAUDE.md`, `ARCHITECTURE.md`, and `AGENTS.md` so the next agent starts with full context.
4. **Trust systems** — write tests and guardrails, then execute. Don't ask for permission on each line.

## Superpowers

| Task | Skill |
| --- | --- |
| React Native patterns, performance, native modules | `/bota-skills:react-native-skills` |
| Expo + NativeWind + Bluetooth integration | `/bota-skills:bota-mobile` |

## Build

Use Node.js 22.13 or newer. The development compatibility baseline is React
Native 0.87, React 19, TypeScript 6, Builder Bob 0.43, and AsyncStorage 3.

```bash
npm install
npm run build       # tsup → lib/ (CJS + ESM + .d.ts)
```

The development toolchain uses Jest 30 and ESLint 10 with flat configuration.

## Test

```bash
npm test            # Jest unit tests
```

## Verify Changes

1. Run `npm test` — all tests must pass
2. Run `npm run build` — must produce clean lib/ output (no type errors)
3. **Test against physical device**: link into demo app (see Local Testing below) and run the affected flow:
   - **Bluetooth discovery changes** — scan for devices, verify Bota-* prefix filtering
   - **Reconnect changes** — verify exact ID/MAC fast paths and guarded serial recovery after a flash changes the peripheral identity
   - **Time sync changes** — run `npm test -- --runInBand __tests__/DeviceManager.test.ts`; connect and reconnect to a physical device and verify the SDK writes `TIME_SYNC` before emitting `deviceConnected`, while unsupported legacy firmware still connects
   - **Recording transfer changes** — sync a recording end-to-end (list → transfer → confirm); while WiFi upload is active, force trigger-busy and BLE loss and confirm no competing BLE transfer starts
   - **Provisioning changes** — pair a fresh device, verify token write and pairing state
   - **Deprovision/rebind changes** — interrupt immediately after `0x05`; verify retained data is never treated as factory-fresh and only the exact authorized rebind/reset can resume. This target is currently incomplete and tracked in System Design v5.
   - **Factory-reset changes** — verify grant-gated opcode `0x06`, persist the three-byte result before writing explicit receipt opcode `0x0A`, replay after disconnect-before-receipt, authenticated backend finalization retry, and complete local-recording removal per [`Device-Provisioning §3.1`](../internal-docs/device/Device-Provisioning.md#31-authenticated-factory-reset)
   - **Status changes** — verify DEVICE_STATUS notifications update correctly
   - **Firmware update changes** — download an assigned release, verify byte progress advances before Bluetooth transfer; force a device-side write rejection and confirm the SDK fails immediately instead of advancing transfer progress
4. Check no regressions in unrelated Bluetooth flows

### Local Testing in Demo App

Run the link commands from their repository roots. This updates the local Yarn link without changing demo manifests or lockfiles.

```bash
# 1. In this repo
yarn link

# 2. In the demo repo root
yarn workspace @bota-demo/app link @bota.dev/react-native-sdk

# 3. Start the demo app
cd app && npx expo start --clear
```

## Code Conventions

**Protocol fidelity** — the SDK-local Bluetooth protocol reference is [`FIRMWARE_PROTOCOL.md`](./FIRMWARE_PROTOCOL.md). Broader firmware design docs live in [`../internal-docs/device/`](../internal-docs/device/), but those docs may lag firmware or SDK implementation. When behavior differs, confirm against `src/protocol/ProtocolHandler.ts` and firmware `le_trans_data.c`, then update the SDK-local reference and any affected design docs.

**Binary parsing** — device data is binary (packed C structs). Use the typed parsers in `src/ble/parsers.ts`. Never parse binary inline in handlers. DEVICE_SETTINGS serialization must default each missing/null idle-timeout field independently to 180 seconds because backend configuration objects may be partial. Accept legacy 1-9 second values without failing sync, but encode them as the minimum representable timeout of 10 seconds.

**React Native byte views** — Hermes may expose a `Buffer.subarray()` result as a plain `Uint8Array`. Normalize byte views with `Buffer.from(view)` before text decoding; calling `Uint8Array.toString('utf8')` produces comma-separated decimal bytes rather than UTF-8 text.

**Event-driven async** — public APIs use async/await. Internal Bluetooth event handling uses EventEmitter. Never block the Bluetooth callback thread.

**Bluetooth OTA flow control** — keep one TRANSFER_STATUS subscription for the full upload and retain ACK sequence state outside individual waits, because firmware notifications may arrive before the SDK reaches `waitForAck()`. A nonzero READY result after upload acceptance and a missing 8-packet window ACK are terminal; never continue sending after either condition.

**Upload queue** — recordings are queued in `UploadQueue` (persistent SQLite). Never upload synchronously in the Bluetooth transfer callback.

**Direct-upload ownership** — `syncAllRecordings` may fall back from WiFi/cellular to BLE only after a fresh device status reports `syncActive=false`. Trigger-busy, BLE loss, and unreadable status preserve device ownership; a genuine monitor failure may use BLE only after that fresh inactive confirmation.

**No server calls** — the SDK communicates only with the Bota device (BLE) and S3 (presigned URLs provided by the customer backend). It never calls the Bota API directly. Auth tokens are passed in by the customer app.

**Minimal permissions** — only request Bluetooth + background processing. Never request location or camera.

**Device diagnostics ownership** — allow one device-log subscription per device, including while the Start write is pending. Reject overlaps without replacing the original monitor or cleanup.

**Device diagnostics recovery** — sequence gaps and firmware dropped-byte flags must clear the decoder's partial UTF-8 line, but they are transport metadata and must not be emitted as synthetic `DeviceLogEvent` rows. Subscribers receive complete firmware lines only.

**Public API surface** — everything exported from `src/index.ts` is public and semver-versioned. Be conservative about adding to it. Internal modules are not exported.

## Key Files

| File | Purpose |
| --- | --- |
| `src/index.ts` | Public API exports |
| `src/BotaClient.ts` | Main entry point (singleton) |
| `src/ble/BleManager.ts` | Low-level Bluetooth ops (CoreBluetooth/Android Bluetooth via react-native-ble-plx) |
| `src/ble/constants.ts` | Bluetooth service + characteristic UUIDs (B07A prefix) |
| `src/ble/deviceLogs.ts` | B07A0007 diagnostic log packet decoder |
| `src/ble/parsers.ts` | Binary struct parsers (DeviceStatus, RecordingEntry, etc.) |
| `src/protocol/ProtocolHandler.ts` | Protocol handler (Bluetooth packet assembly, ACK logic) |
| `src/managers/DeviceManager.ts` | Device discovery, connection, bonding, provisioning, authenticated factory-reset receipt/replay, diagnostics subscriptions |
| `src/managers/RecordingManager.ts` | Recording list, Bluetooth transfer, upload orchestration |
| `src/sync/deviceUploadHandoff.ts` | Direct-upload ownership and safe BLE-fallback policy |
| `src/managers/OTAManager.ts` | Firmware download progress, Bluetooth OTA transfer, reboot recovery |
| `src/upload/UploadQueue.ts` | Persistent SQLite upload queue with retry |
| `src/storage/StorageManager.ts` | Local SQLite persistence (device registry, transfer state) |
| `src/models/` | TypeScript types (Device, Recording, DeviceStatus, etc.) |
| `jest.config.js` | Jest/Babel transform config for TypeScript unit tests |

## Design Docs

All design docs live in [`../internal-docs/`](../internal-docs/).

| Doc | Covers | Status |
| --- | --- | --- |
| [App SDK Architecture](../internal-docs/App%20SDK%20Architecture.md) | Current target for the Rust core, platform bindings, public package naming, monorepo, and synchronized releases | Target; implementation conformance is tracked in System Design v5 |
| [Mobile SDK System Design](../internal-docs/Mobile%20SDK%20System%20Design.md) | Historical SDK proposal retained for context | Superseded; do not use as the current contract |
| [FIRMWARE_PROTOCOL](./FIRMWARE_PROTOCOL.md) | SDK-local Bluetooth GATT service defs, recording transfer protocol, ACK/NACK behavior | SDK package reference |
| [FIRMWARE_INTEGRATION_GUIDE](../internal-docs/device/FIRMWARE_INTEGRATION_GUIDE.md) | Broader firmware workflows, GATT service defs, heartbeat | Internal design reference |
| [Device-App Protocol](../internal-docs/device/Device-App%20Protocol.md) | Compatibility index for current owning protocol documents | Index only |
| [Bluetooth Reliable Transfer Design](../internal-docs/device/BLE%20Reliable%20Transfer%20Design.md) | v2 windowed repair and durable resume over the released continuous-stream/final-ACK profile | Implementation conformance: [System Design v5](../internal-docs/System%20Design%20v5.md#33-security-configuration-and-remote-control-conformance) |
| [Upload-Management](../internal-docs/device/Upload-Management.md) | Bluetooth sync, WiFi/cellular direct upload, recovery, failover | Target; implementation conformance is tracked in System Design v5 |
| [Device-Provisioning](../internal-docs/device/Device-Provisioning.md) ([中文](../internal-docs/device/Device-Provisioning_ZH.md)) | Registration, bind, reconnect, rebind, reset, transfer, app-less activation | Authoritative target; implementation conformance is tracked in System Design v5 |
| [WiFi-Configuration](../internal-docs/device/WiFi-Configuration.md) | WiFi credential provisioning and protection | Target; implementation conformance is tracked in System Design v5 |
| [Connection-Management](../internal-docs/device/Connection-Management.md) | Connection lifecycles, reconnect, failover, and policy | Target; implementation conformance is tracked in System Design v5 |
| [Heartbeat-Channel-Control](../internal-docs/device/Heartbeat-Channel-Control.md) | Heartbeat channels and dynamic policy | Target; implementation conformance is tracked in System Design v5 |
| [Device–App–Backend Security](../internal-docs/device/Device%E2%80%93App%E2%80%93Backend%20Security%20%26%20Communication%20Design.md) | Authentication, authorization, credentials, encryption, and channel security | Authoritative target; implementation conformance is tracked in System Design v5 |
