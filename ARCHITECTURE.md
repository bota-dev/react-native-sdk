# Architecture — @bota.dev/react-native-sdk

Public React Native SDK for Bluetooth communication with Bota wearable devices.

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
│   └── RecordingManager.ts # List → transfer → upload → confirm
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

Custom GATT service, UUID prefix `B07A`. See [`../internal-docs/device/FIRMWARE_INTEGRATION_GUIDE.md`](../internal-docs/device/FIRMWARE_INTEGRATION_GUIDE.md) for the authoritative spec.

| Service | UUID | SDK Component |
| --- | --- | --- |
| CONTROL | B07A0002 | DeviceManager (status, time sync, recording control) |
| PROVISIONING | B07A0003 | DeviceManager (pairing, token write) |
| STORAGE | B07A0004 | RecordingManager (list, transfer) |
| WIFI_CONFIG | B07A0006 | DeviceManager (WiFi credential write) |

### Device Status (14-byte binary, CONTROL B07A0201)

```
[0] battery_level (0-100)
[1] reserved
[2] device_state  (0=idle, 1=recording, 2=syncing, 3=uploading, 4=charging, 5=low_bat, 6=full, 7=error)
[3] pending_recordings
[4-7] last_time_sync_ts (uint32LE)
[8] flags (bit0=charging, bit1=low_bat, bit2=storage_full, bit3=wifi, bit4=lte, bit5=sync_active)
[9-10] storage_total_mb (uint16LE)
[11-12] storage_used_mb (uint16LE)
[13] reserved
```

### Recording List (24-byte entries, STORAGE B07A0402)

```
[0-15]  file_id (4 random bytes + 12 zero padding)
[16-19] started_at (uint32LE unix timestamp)
[20-21] duration_sec (uint16LE)
[22-23] size_kb (uint16LE)
```

### Recording Transfer (stop-and-wait, current; windowed planned)

```
SDK → Device: TRANSFER_CONTROL write 0x01           → list recordings
Device → SDK: RECORDING_LIST notification            ← 24-byte entries
SDK → Device: TRANSFER_CONTROL write 0x02 + file_id → start transfer
Device → SDK: RECORDING_TRANSFER notify (DATA seq)  ← data packet
SDK → Device: RECORDING_TRANSFER write (ACK seq)    → acknowledge
  ...repeat for each packet...
Device → SDK: RECORDING_TRANSFER notify (EOF + CRC32) ← transfer complete
SDK → Device: TRANSFER_CONTROL write 0x07 + file_id → confirm (device deletes file)
```

**Planned v2:** Sliding window (size 4) with gap detection — see [Bluetooth Reliable Transfer Design](../internal-docs/device/BLE%20Reliable%20Transfer%20Design.md).

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
  ↓ reconnect (stored peripheral ID; advertised MAC; else serial-number probe)
```

**Reconnect matching (`DeviceManager.reconnect`).** All Bota Pins advertise the
same generic name ("Bota Pin") and iOS/macOS rotate the BLE peripheral ID, so
neither name nor stored ID reliably identifies a specific unit when several are
nearby. Match order: (1) exact stored peripheral ID — fast path while still
valid; (2) advertised MAC from manufacturer data — stable and scan-visible when
firmware provides it; (3) **serial-number probe** — connect to each active
same-named candidate (nearest first), read the serial number from GATT `0x2A25`,
keep the one that matches and release the rest. The SN is the stable unique key
when MAC data is unavailable but isn't advertised, so a brief connection to the
wrong unit is the cost of finding the right one. When a stored MAC exists, the
scan keeps duplicate advertisements enabled and waits for that MAC before falling
back to same-name SN probes, because iOS can deliver name and manufacturer-data
packets separately. Reconnect attempts are
**serialized** (one BLE probe at a time) and **deduped per SN** — concurrent
attempts for different SNs would otherwise share and then tear down the single
connection slot; a mismatched probe never disconnects a device that is already
an established connection. The SN probe read is timeout-bounded; if iOS reports
the link up but the GATT read stalls, the probe releases its temporary link and
the reconnect loop retries instead of leaving the app in `connecting`.

**Radio arbitration (`BleManager`).** The reconnect-vs-reconnect serialisation
above lives in `DeviceManager`, but the BLE adapter is also contended by the
**pairing path** (`DeviceManager.connect`), which doesn't go through that chain.
To prevent a stale device's auto-reconnect probe from racing a user-initiated
pair on the single adapter (observed as a 2A26-read disconnect mid-handshake),
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

## Device Settings (8-byte binary, PROVISIONING B07A0306)

```c
struct bota_device_settings {
  u8 version;           // 0x01
  u8 enabled_mask;      // bit0=WiFi, bit1=4G (Bluetooth always on)
  u8 upload_net_pref[3]; // 1=WiFi, 2=BLE, 3=4G, 0=end
  u8 power_cfg_4g;      // idle timeout: 0=default(180s), 1-254=×10s, 255=always-on
  u8 power_cfg_wifi;    // same encoding as power_cfg_4g
  u8 reserved;          // 0x00
};
```

Customer backend configures via `PATCH /devices/{id}` → app reads via API → SDK serializes + writes to device.

---

## Platform Notes

| | iOS | Android |
| --- | --- | --- |
| Bluetooth API | CoreBluetooth (via react-native-ble-plx) | Android Bluetooth API (via react-native-ble-plx) |
| Auth storage | Keychain | Android Keystore |
| Background sync | BGTaskScheduler | WorkManager |
| SQLite | expo-sqlite | expo-sqlite |

Both platforms use the same TypeScript protocol layer. Platform differences are isolated to react-native-ble-plx and native module boundaries.
