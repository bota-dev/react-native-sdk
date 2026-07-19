# Architecture — @bota.dev/react-native-sdk

> Connection settings preserve the 12-byte v0x02 layout and use byte 9 for legacy-safe heartbeat channel control.

Public React Native SDK for Bluetooth communication with Bota wearable devices.

---

## SDK Family Scope

| Repository | Platform | Package/module |
| --- | --- | --- |
| `react-native-sdk` | React Native | `@bota.dev/react-native-sdk` |
| [`bota-mobile-sdk-ios`](https://github.com/bota-dev/bota-mobile-sdk-ios) | Native iOS | `BotaSDK` |
| [`bota-mobile-sdk-android`](https://github.com/bota-dev/bota-mobile-sdk-android) | Native Android | `com.bota.sdk` |

Each mobile SDK implements the same device-facing behavior in its platform's
native APIs. This repository owns only the React Native implementation; it does
not contain or publish the native SDK sources.

---

## Overview

```
Customer App
  └── BotaClient (SDK entry point)
        ├── DeviceManager   — discovery, connection, provisioning
        ├── RecordingManager — list, transfer, upload orchestration
        └── (no server calls — customer backend provides tokens + upload URLs)

BotaClient ←─── Bluetooth ───→ Bota Device (firmware)
BotaClient ←─── HTTPS ──→ S3 (presigned URLs provided by customer backend)
```

The SDK never calls the Bota API directly. Auth tokens and upload URLs are provided by the customer's backend.

---

## Module Map

```
src/
├── index.ts                # Public API exports (semver boundary)
├── BotaClient.ts           # Singleton entry point
│
├── ble/
│   ├── BluetoothManager.ts       # react-native-ble-plx wrapper; scan, connect, read, write, notify
│   ├── constants.ts        # UUIDs: B07A base service + all characteristics
│   ├── parsers.ts          # Binary struct parsers (DeviceStatus 14B, RecordingEntry 24B, etc.)
│   └── protocol.ts         # Packet assembly, sequence numbers, ACK handling
│
├── managers/
│   ├── DeviceManager.ts    # Scan → connect → bond → provision → connected state
│   ├── RecordingManager.ts # List → transfer → upload → confirm
│   └── OTAManager.ts       # Firmware download → BLE transfer → reboot recovery
│
├── upload/
│   └── UploadQueue.ts      # Persistent SQLite queue, retry (exponential backoff, 24h max)
│
├── storage/
│   └── StorageManager.ts   # Device registry, bonding data, transfer state (SQLite)
│
└── models/                 # TypeScript types
    ├── Device.ts
    ├── Recording.ts
    ├── DeviceStatus.ts
    └── ...
```

---

## Bluetooth Protocol

Custom GATT service, UUID prefix `B07A`. See [`FIRMWARE_PROTOCOL.md`](./FIRMWARE_PROTOCOL.md) for the SDK-local firmware protocol reference.

| Service | UUID | SDK Component |
| --- | --- | --- |
| CONTROL | B07A0002 | DeviceManager (status, time sync, recording control) |
| PROVISIONING | B07A0003 | DeviceManager (pairing, token write) |
| STORAGE | B07A0004 | RecordingManager (list, transfer) |
| WIFI_CONFIG | B07A0006 | DeviceManager (WiFi credential write) |

### Device Status (15-byte binary, CONTROL B07A0201; 14-byte compatible)

```
[0] battery_level (0-100)
[1] LTE status
[2] device_state  (0=idle, 1=recording, 2=syncing, 3=uploading, 4=charging, 5=low_bat, 6=full, 7=error)
[3] pending_recordings
[4-7] last_time_sync_ts (uint32LE)
[8] flags (bit0=charging, bit1=low_bat, bit2=storage_full, bit3=wifi, bit4=lte, bit5=sync_active)
[9-10] storage_total_mb (uint16LE)
[11-12] storage_used_mb (uint16LE)
[13] LTE signal quality (CSQ 0-31, 99=unknown)
[14] WiFi radio status (optional on older firmware)
```

### Recording List (24-byte entries, STORAGE B07A0402)

```
[0-3]   file_id (4 random bytes)
[4]     flags (bit0=encrypted_at_rest)
[5-15]  reserved (currently zero)
[16-19] started_at (uint32LE unix timestamp)
[20-21] duration_sec (uint16LE)
[22-23] size_kb (uint16LE)
```

The SDK canonicalizes the 4-byte `file_id` to a UUID-shaped string by
zero-padding the remaining 12 bytes; byte 4 is never part of the identifier.

### Recording Transfer (streamed notifications, final ACK)

```
SDK → Device: TRANSFER_CONTROL write 0x01           → list recordings
Device → SDK: RECORDING_LIST notification            ← 24-byte entries
SDK → Device: TRANSFER_CONTROL write 0x02 + file_id → start transfer
Device → SDK: RECORDING_TRANSFER notify (DATA seq)  ← data packet
Device → SDK: RECORDING_TRANSFER notify (DATA seq)  ← next data packet
  ...device continues while BLE transmit capacity is available...
Device → SDK: RECORDING_TRANSFER notify (EOF + CRC32) ← transfer complete
Device → SDK: RECORDING_TRANSFER notify (SHA256)      ← optional integrity hash
SDK → Device: TRANSFER_CONTROL write (ACK/NACK)     → final CRC result
SDK → Device: TRANSFER_CONTROL write 0x07 + file_id → confirm (device deletes file)
```

The SDK does not ACK each DATA packet. It ACKs only after EOF, once the assembled
payload passes CRC32 verification; it sends NACK on final CRC mismatch and Abort
on cancellation. Firmware streams DATA packets back-to-back and keeps the
transfer active until this final app result.

---

## Upload Flow

```
RecordingManager.syncRecording(device, fileId)
  1. customer app calls getUploadUrl(fileId) from their backend
     → backend: POST /recordings → { id: rec_xxx, upload_url, upload_token }
  2. Bluetooth transfer: file_id → Buffer (via TRANSFER_CONTROL + RECORDING_TRANSFER)
  3. S3 upload: PUT upload_url with audio Buffer
  4. customer app notifies backend: POST /recordings/rec_xxx/upload-complete
  5. Bluetooth confirm: TRANSFER_CONTROL 0x07 + file_id (device deletes local file)

UploadQueue handles retries:
  - Persists to SQLite before upload attempt
  - Retries on failure: exponential backoff (5s → 30s → 5min → 30min → 2h → 24h max)
  - Resumes on app restart (reads queue from SQLite)
```

---

## Firmware Update Flow

`OTAManager.performUpdate` downloads the `.ufw` image over HTTPS, transfers it to the device over
Bluetooth, and waits for the device to reconnect after applying the update. The HTTPS download uses
React Native's `XMLHttpRequest` progress events; `OtaProgress` exposes normalized progress plus
optional transferred and total byte counts during the `downloading` stage.

`ProtocolHandler.uploadFirmware` keeps one TRANSFER_STATUS subscription and records ACK sequences
as notifications arrive, including before an 8-packet window begins waiting. A device storage-write
result or a missing window ACK terminates the transfer immediately; continuing would only send data
after firmware has stopped writing `update.ufw`.

---

## Device Lifecycle

```
UNDISCOVERED
  ↓ scanForDevices() — filters "Bota-" prefix in Bluetooth name
DISCOVERED
  ↓ connect(deviceId)
  ↓ service discovery
  ↓ read PAIRING_STATE (B07A0301)
CONNECTED (unpaired)
  ↓ provisionDevice(device, token, endpoint)
     → write DEVICE_TOKEN (B07A0302, chunked protocol)
     → write API_ENDPOINT (B07A0303)
     → wait PROVISIONING_RESULT notification (B07A0305)
CONNECTED (paired)
  ↓ disconnected / app background
DISCONNECTED
  ↓ reconnect (stored peripheral ID / advertised MAC / guarded SN probe after identity rotation)
```

**Reconnect matching (`DeviceManager.reconnect`).** All Bota Pins advertise the
same generic name ("Bota Pin") and iOS/macOS rotate the BLE peripheral ID, so
name is not a safe reconnect key when several are nearby. Match order: (1)
exact stored peripheral ID — fast path while still valid; (2) advertised MAC
from manufacturer data — stable and scan-visible when firmware provides it; (3)
a guarded serial-number probe after those exact identities fail, including when
the local registry was lost or firmware flashing changed the advertised identity.
The probe runs only while no user radio work is in flight, connects to likely
Bota candidates, and reads GATT `0x2A25`; only an exact serial match is accepted.
This preserves reconnect without reintroducing pairing races. When none of those
match, reconnect fails and the caller should let the user pair/select the device
again. Reconnect attempts are **serialized**
and **deduped per SN** so concurrent attempts for different SNs do not race over
the single BLE adapter or each other's discovery results.

**Radio arbitration (`BleManager`).** The reconnect-vs-reconnect serialisation
above lives in `DeviceManager`, but the BLE adapter is also contended by the
**pairing path** (`DeviceManager.connect`), which doesn't go through that chain.
To prevent stale auto-reconnect from racing a user-initiated pair on the single
adapter (observed as a 2A26-read disconnect mid-handshake),
`BleManager` owns a second arbiter:

- All `connect`/`disconnect` calls run through a FIFO `radioChain` — no two
  `connectToDevice` calls overlap regardless of caller.
- Every `connect` calls `stopScan()` first, claiming the radio from any
  background scan window (iOS cancels in-flight connects under an active scan).
- Each op carries `priority: 'user' | 'background'`. `user` (the default, used
  by pairing and manual reconnect) sets `BleManager.isUserOpInFlight()`; the
  auto-reconnect loop checks it and skips its tick so background reconnection
  yields autonomously to user pairing instead of racing it.
- User-priority connects re-read serial/device info from GATT even when the BLE
  id is already present in `connectedDevices`; only background reconnect can
  return the existing connected entry. This keeps pairing from combining a
  stale connected serial with a fresh PK_D read from another physical device.
- Background connection failures are expected during reconnect candidate probes,
  so `BleManager` logs those at debug with the BLE reason. User-priority connect
  failures remain error-level.

See [internal-docs/device/Connection-Management.md §2.1.1](../internal-docs/device/Connection-Management.md#211-ble-radio-arbitration) for the cross-system specification.

---

## Device Settings (12-byte v0x02 binary, PROVISIONING B07A0306)

```c
struct bota_device_settings {
  u8 version;           // 0x02; legacy 0x01 uses the first 8 bytes
  u8 enabled_mask;      // bit0=WiFi, bit1=4G (Bluetooth always on)
  u8 upload_net_pref[3]; // 1=WiFi, 2=BLE, 3=4G, 0=end
  u8 power_cfg_4g;      // idle timeout: 0=immediate, 1-254=×10s, 255=always-on
  u8 power_cfg_wifi;    // same encoding as power_cfg_4g
  u8 streaming_enabled;
  u8 chunk_flush_interval_s;
  u8 heartbeat_enabled_mask; // bit7=explicit, bit1=4G, bit0=WiFi
  u8 reserved[2];
};
```

Customer backend configures via `PATCH /devices/{id}` → app reads via API → SDK serializes + writes to device.
Each missing or `null` individual API idle-timeout value defaults to byte `18` (180 seconds); a partial `power_management` object must not pass `undefined` into the binary encoder. Legacy SDK inputs from 1-9 seconds normalize to byte `1` (10 seconds), since the wire format cannot represent an exact positive timeout below 10 seconds.

---

## Platform Notes

| | iOS | Android |
| --- | --- | --- |
| Bluetooth API | CoreBluetooth (via react-native-ble-plx) | Android Bluetooth API (via react-native-ble-plx) |
| Auth storage | Keychain | Android Keystore |
| Background sync | BGTaskScheduler | WorkManager |
| SQLite | expo-sqlite | expo-sqlite |

Both platforms use the same TypeScript protocol layer. Platform differences are isolated to react-native-ble-plx and native module boundaries.
