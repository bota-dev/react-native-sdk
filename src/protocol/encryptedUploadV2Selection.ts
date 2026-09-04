import type { EncryptedUploadV2Capabilities } from './encryptedUploadV2';

export type RecordingUploadProfile =
  | 'legacy_plain_v1'
  | 'legacy_p10_relay'
  | 'encrypted_upload_v2';

export type UploadSecurityPolicy =
  | 'legacy_allowed'
  | 'v2_preferred'
  | 'v2_required';

export interface EncryptedUploadProfileSelection {
  policy: UploadSecurityPolicy;
  profile: RecordingUploadProfile;
}

export interface EncryptedUploadProfileSelectionEvidence {
  encryptedUploadV2Capabilities?: EncryptedUploadV2Capabilities;
  recordingGeneration?: number;
  recordingStorageFormat?: number;
  historicalP10HeaderObserved: boolean;
}

export type EncryptedUploadProfileSelectionErrorCode =
  | 'encrypted_upload_v2_unsupported'
  | 'encrypted_upload_v2_required'
  | 'legacy_p10_relay_not_observed'
  | 'legacy_p10_relay_required';

export class EncryptedUploadProfileSelectionError extends Error {
  constructor(readonly code: EncryptedUploadProfileSelectionErrorCode) {
    super(code);
    this.name = 'EncryptedUploadProfileSelectionError';
  }
}

const REQUIRED_BATCH_FLAGS = 0x7f;

export function validateEncryptedUploadProfileSelection(
  selection: EncryptedUploadProfileSelection,
  evidence: EncryptedUploadProfileSelectionEvidence
): EncryptedUploadProfileSelection {
  if (
    selection.policy === 'v2_required' &&
    selection.profile !== 'encrypted_upload_v2'
  ) {
    fail('encrypted_upload_v2_required');
  }

  if (selection.profile === 'legacy_plain_v1') {
    if (evidence.historicalP10HeaderObserved) {
      fail('legacy_p10_relay_required');
    }
    return selection;
  }

  if (selection.profile === 'legacy_p10_relay') {
    if (!evidence.historicalP10HeaderObserved) {
      fail('legacy_p10_relay_not_observed');
    }
    return selection;
  }

  if (
    evidence.historicalP10HeaderObserved ||
    !isUint32(evidence.recordingGeneration) ||
    evidence.recordingStorageFormat !== 3 ||
    !supportsBatch(evidence.encryptedUploadV2Capabilities)
  ) {
    fail('encrypted_upload_v2_unsupported');
  }
  return selection;
}

function supportsBatch(
  capabilities: EncryptedUploadV2Capabilities | undefined
): boolean {
  return !!capabilities &&
    capabilities.highestTransferProfileVersion === 2 &&
    (capabilities.flags & REQUIRED_BATCH_FLAGS) === REQUIRED_BATCH_FLAGS &&
    capabilities.maximumSignedBlobBytes >= 408 &&
    capabilities.maximumManifestBytes >= 580 &&
    isPositiveUint(capabilities.maximumDataPayloadBytes, 0xffff) &&
    isPositiveUint(capabilities.maximumWindowPackets, 0xffff) &&
    isPositiveUint(capabilities.durableCheckpointIntervalBlocks, 0xffffffff) &&
    isPositiveUint(capabilities.maximumMissingSequences, 0xffff);
}

function isUint32(value: number | undefined): value is number {
  return value !== undefined &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffffffff;
}

function isPositiveUint(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= maximum;
}

function fail(code: EncryptedUploadProfileSelectionErrorCode): never {
  throw new EncryptedUploadProfileSelectionError(code);
}
