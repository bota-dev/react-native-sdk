# Heartbeat Diagnostics Reporting — SDK Implementation

**Status:** Implemented on `feature/heartbeat-ext`.

Authoritative contract:
[`internal-docs/device/Heartbeat-Diagnostics-Reporting.md`](../../internal-docs/device/Heartbeat-Diagnostics-Reporting.md)

## Boundary

The SDK owns only BLE transport between the App and physical device. It does
not call either Bota Heartbeat endpoint and does not decide when backend
acceptance permits local deletion. The consuming App owns that orchestration.

## Public API

```ts
interface DeviceDiagnosticEvent {
  event_id: string;
  event_type: DeviceDiagnosticEventType;
  reason_code: string;
  uptime_ms: number;
  signature: string;
  firmware_build_id: string;
  subsystem?: string;
  state_before_event?: string;
  report?: DeviceDiagnosticReport;
}

devices.readDiagnosticEvents(device)
devices.acknowledgeDiagnosticEvents(device, acceptedEventIds)
```

The read method returns `DeviceDiagnosticsBatch`, ready to place under the
Heartbeat `diagnostics` property. The App passes only backend-accepted IDs to
the acknowledgement method.

## Existing and planned B07A0007 operations

Existing DEBUG-only commands remain unchanged:

```text
0x00 STOP_DEBUG_LOG
0x01 START_DEBUG_LOG
```

Production operations:

```text
0x10 LIST_FAULT_EVENTS
0x11 ACK_FAULT_EVENTS
0x12 GET_DIAGNOSTICS_CAPABILITIES
```

Responses are small ATT notifications: `0x90` metadata, `0x91` signature,
`0x92` list end, `0x93` ACK result, `0x94` capabilities, and one or more `0x95`
V1 detail chunks. The SDK requires contiguous chunks for the exact 176-byte
detail before exposing an event. That detail carries build identity, context,
allowlisted WL83 fault masks, normalized image-relative PCs, cached runtime
counters and bounded structured breadcrumbs. Integers and 64-bit identifiers
are little-endian on BLE; the public API exposes identifiers as 16-character
lowercase hex. The returned batch uses `schema_version: 1`; that version owns
the entire JSON/report/signature contract. One list request is in flight at a
time and the SDK applies the standard operation timeout. An old firmware target
fails the operation without preventing the App from sending its core Heartbeat.

## Tests

- split metadata/signature/detail assembly;
- missing, duplicate and out-of-order detail chunk rejection;
- endian-safe event ID parsing and ACK encoding;
- malformed event ID rejection;
- incomplete list rejection and operation timeout are enforced by the decoder
  and manager respectively.
