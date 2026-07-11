# Firmware Protocol Reference — @bota.dev/react-native-sdk

This document is the SDK-local reference for the Bluetooth protocol implemented by
`@bota.dev/react-native-sdk`. It intentionally covers only the app-facing surface
needed by React Native apps and SDK maintainers.

The broader firmware integration guide lives in Bota's internal docs. That guide
is not shipped with the standalone SDK package, so SDK behavior should be checked
against this file and the implementation in `src/`.

## Public SDK Availability

- The published mobile SDK in this repository is `@bota.dev/react-native-sdk`.
- There is no native Swift/iOS SDK or native Kotlin/Android SDK source in this
  package today.
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

See `src/ble/constants.ts` for the characteristic UUID constants used by the SDK.

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
| `0..15` | Recording UUID/file id | 16 bytes |
| `16..19` | Started at | `uint32LE`, Unix seconds |
| `20..21` | Duration | `uint16LE`, seconds |
| `22..23` | Size | `uint16LE`, KiB |

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
