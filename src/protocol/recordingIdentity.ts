import { Buffer } from 'buffer';

export function recordingIdsEqual(
  packetRecordingId: Uint8Array,
  requestedRecordingUuid: string
): boolean {
  const requested = Buffer.from(requestedRecordingUuid.replace(/-/g, ''), 'hex');
  return requested.length === 16 && Buffer.from(packetRecordingId).equals(requested);
}

export function isRecordingHashForTransfer(
  packetRecordingId: Uint8Array | undefined,
  requestedRecordingUuid: string
): boolean {
  return (
    packetRecordingId === undefined ||
    recordingIdsEqual(packetRecordingId, requestedRecordingUuid)
  );
}
