# Firmware Protocol Reference — @bota.dev/react-native-sdk

DEVICE_SETTINGS v0x02 byte 9 is `heartbeat_enabled_mask`: bit 7 marks an explicit value, bit 1 enables cellular direct heartbeat, and bit 0 enables WiFi direct heartbeat. Values without bit 7 retain the legacy both-enabled default.

DEVICE_SETTINGS bytes 5 and 6 encode cellular and WiFi idle timeouts in 10-second units (`0` = immediate, `1-254` = 10-2540 seconds, `255` = always on). A missing or `null` individual API value serializes as byte `18` (180 seconds). For backward compatibility, an SDK input of 1-9 seconds serializes as byte `1` (10 seconds); exact sub-10-second values are not representable.

This document is the SDK-local reference for the Bluetooth protocol implemented by
`@bota.dev/react-native-sdk`. It intentionally covers only the app-facing surface
needed by React Native apps and SDK maintainers.

The broader firmware integration guide lives in Bota's internal docs. That guide
is not shipped with the standalone SDK package, so SDK behavior should be checked
against this file and the implementation in `src/`.

## Public SDK Availability

- The published mobile SDK in this repository is `@bota.dev/react-native-sdk`.
- Native Swift/iOS and Kotlin/Android SDK sources live in sibling repositories:
  [bota-mobile-sdk-ios](https://github.com/bota-dev/bota-mobile-sdk-ios) and
  [bota-mobile-sdk-android](https://github.com/bota-dev/bota-mobile-sdk-android).
- Firmware integration docs are internal to the Bota workspace unless explicitly
  published in the public docs site.

## GATT Services

All custom UUIDs use the `B07A` prefix with the Bluetooth base UUID
`0000-1000-8000-00805F9B34FB`.

| Service | UUID | SDK Use |
| --- | --- | --- |
| AUDIO | `B07A0001` | Reserved audio control/data surface |
| CONTROL | `B07A0002` | Status, recording control, time sync, device commands |
| PROVISIONING | `B07A0003` | Pairing state, token, API endpoint, device settings |
| STORAGE | `B07A0004` | Recording list, recording transfer, transfer control |
| AUTH | `B07A0005` | Device public key, session nonce, backend public key, device cert |
| WIFI_CONFIG | `B07A0006` | WiFi grants, credentials, status, scan |
| DIAGNOSTICS | `B07A0007` | Opt-in firmware debug log stream |

See `src/ble/constants.ts` for the characteristic UUID constants used by the SDK.

## Device Diagnostics

`SERVICE_BOTA_DIAGNOSTICS` (`B07A0007`) exposes an opt-in firmware debug log
stream. It requires firmware built with `DEBUG=1`; the SDK reports a failed Start
write as `DeviceError` code `FEATURE_UNAVAILABLE`.

| Characteristic | UUID | Direction | Use |
| --- | --- | --- | --- |
| LOG_CONTROL | `B07A0007-0001` | App -> Device | Enable or disable log notifications |
| LOG_DATA | `B07A0007-0002` | Device -> App | UTF-8 log chunks with sequence metadata |

LOG_CONTROL writes:

| Packet | Meaning |
| --- | --- |
| `[0x01]` | Start log notifications |
| `[0x00]` | Stop log notifications |

LOG_DATA notification packet:

| Offset | Field | Encoding |
| --- | --- | --- |
| `0..1` | Sequence | `uint16LE`, increments for each notification |
| `2` | Flags | bit 0: backlog line, bit 1: firmware dropped bytes |
| `3..` | Log bytes | UTF-8 chunk; a line may span packets |

`subscribeToDeviceLogs()` enables the LOG_DATA notification before writing Start,
then decodes complete newline-delimited lines as `DeviceLogEvent` values. Its
returned cleanup is idempotent and attempts Stop before removing the monitor. A
disconnect or SDK destroy removes the native monitor without writing to a dead link.

## Device Status

`CHAR_DEVICE_STATUS` (`B07A0002-0001`) is parsed by the SDK as a binary status
packet. Current firmware may send 15 bytes; older firmware sent 14 bytes.

| Offset | Field | Encoding |
| --- | --- | --- |
| `0` | Battery level | `uint8`, 0-100 |
| `1` | LTE status | `uint8` |
| `2` | Device state | `uint8` |
| `3` | Pending recordings | `uint8` |
| `4..7` | Last time sync | `uint32LE`, Unix seconds |
| `8` | Flags | bitmask: charging, low battery, storage full, WiFi, LTE, sync active |
| `9..10` | Storage total | `uint16LE`, MB |
| `11..12` | Storage used | `uint16LE`, MB |
| `13` | LTE signal quality | `uint8`, CSQ 0-31, 99/0xff unknown |
| `14` | WiFi radio status | `uint8`, optional on older firmware |
| `15..16` | Battery voltage | `uint16LE`, optional millivolts |
| `17..` | Modem info | optional UTF-8 modem info string |

## Recording List

The app writes `TRANSFER_CMD_LIST` (`0x01`) to `CHAR_TRANSFER_CONTROL`
(`B07A0004-0004`). Firmware notifies `CHAR_RECORDING_LIST` (`B07A0004-0002`)
with 24-byte entries.

| Offset | Field | Encoding |
| --- | --- | --- |
| `0..3` | Recording file id | 4 bytes |
| `4` | Flags | bit 0: encrypted at rest |
| `5..15` | Reserved | 11 bytes, currently zero |
| `16..19` | Started at | `uint32LE`, Unix seconds |
| `20..21` | Duration | `uint16LE`, seconds |
| `22..23` | Size | `uint16LE`, KiB |

The SDK exposes the 4-byte file id as a UUID-shaped string by zero-padding the
remaining 12 bytes. The flags byte is not part of that identifier.

## Recording Transfer

Current SDK and firmware use streamed notifications with a final ACK/NACK. The
app does not ACK each DATA packet.

```
SDK -> Device: TRANSFER_CONTROL write 0x02 + recording_uuid
Device -> SDK: RECORDING_TRANSFER notify DATA seq=0
Device -> SDK: RECORDING_TRANSFER notify DATA seq=1
Device -> SDK: RECORDING_TRANSFER notify DATA seq=N
Device -> SDK: RECORDING_TRANSFER notify EOF + CRC32
Device -> SDK: RECORDING_TRANSFER notify SHA256        (optional, P9.F2+)
SDK -> Device: TRANSFER_CONTROL write ACK or NACK      (final result)
SDK -> Device: TRANSFER_CONTROL write 0x07 + recording_uuid
```

Packet types from device to app:

| Type | Meaning | Payload |
| --- | --- | --- |
| `0x01` | DATA | `[type, seq uint16LE, len uint16LE, payload...]` |
| `0x02` | EOF | `[type, seq uint16LE, crc32 uint32LE]` |
| `0x03` | PAUSED | Streaming mode caught up to the live recording |
| `0x04` | SHA256 | `[type, sha256[32]]`, optional after EOF |
| `0x05` | E2E_START | BLE end-to-end encryption session header |
| `0x81` | ENCRYPTED_DATA | Encrypted audio chunk with auth tag |
| `0x82` | ENCRYPTED_EOF | Encrypted EOF; CRC field is unused |
| `0xff` | ERROR | Firmware-side transfer error |

Final result writes from app to device:

| Type | Meaning |
| --- | --- |
| `0x10` | ACK, transfer complete and verified |
| `0x11` | NACK, CRC mismatch/full retry required |
| `0x12` | Abort/cancel |

Implementation notes:

- `ProtocolHandler` stores DATA packets, waits for EOF, allows a short grace
  window for optional SHA-256, then writes the final ACK/NACK.
- Plain transfer integrity is checked with EOF CRC32. P9.F2+ firmware may also
  emit SHA-256 after EOF so the host app can pass `content_sha256` to the backend.
- Encrypted transfer integrity is covered per chunk by auth tags; encrypted EOF
  keeps the same framing but does not use the CRC field.
- Firmware streams DATA notifications back-to-back while BLE transmit capacity is
  available, then keeps the transfer active until the final ACK.

## Confirm Delete

After the app has uploaded the recording and notified its backend, it writes
`TRANSFER_CMD_CONFIRM_SYNC` (`0x07`) plus the recording UUID to
`CHAR_TRANSFER_CONTROL`. Firmware may then delete the local recording file.

Do not send confirm immediately after Bluetooth transfer; confirm means the cloud
upload path has completed.

## Firmware Upload

Bluetooth OTA uses the STORAGE service with one status subscription for the full
transfer:

```text
SDK -> Device: TRANSFER_CONTROL [0x08, file_size uint32LE]
Device -> SDK: TRANSFER_STATUS  [0x08, result]
SDK -> Device: RECORDING_TRANSFER [0x20, seq uint16LE, payload...]
Device -> SDK: TRANSFER_STATUS  [0x10, seq uint16LE]
SDK -> Device: TRANSFER_CONTROL [0x09, crc32 uint32LE]
Device -> SDK: TRANSFER_STATUS  [0x09, result]
```

Start and transfer result values:

| Packet | Meaning |
| --- | --- |
| `[0x08, 0x00]` | Device accepted the upload and opened `update.ufw` |
| `[0x08, 0x01]` | Device rejected the upload, or legacy firmware aborted it |
| `[0x08, 0x02]` | SD/FAT write failed; upload was aborted and the partial file removed |
| `[0x09, 0x00]` | CRC32 matched; device will apply the update |
| `[0x09, 0x01]` | Verification failed |

The SDK sends 500-byte payloads and requires the ACK for each 8-packet window.
ACK notifications are retained even if they arrive before the window wait begins.
A nonzero `0x08` result after upload acceptance fails with
`FW_STORAGE_WRITE_FAILED`; a missing window ACK fails with
`FW_UPLOAD_ACK_TIMEOUT`. Neither condition is safe to ignore because the device
may already have stopped writing data.
