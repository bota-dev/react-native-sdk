import { Buffer } from 'buffer';

import {
  decodeEncryptedUploadV2Capabilities,
  type EncryptedUploadV2Capabilities,
} from '../src/protocol/encryptedUploadV2';
import {
  validateEncryptedUploadProfileSelection,
  type EncryptedUploadProfileSelection,
  type EncryptedUploadProfileSelectionEvidence,
} from '../src/protocol/encryptedUploadV2Selection';

const validCapabilities = (): EncryptedUploadV2Capabilities =>
  decodeEncryptedUploadV2Capabilities(
    Buffer.from('010218007f00000000040004f40010000800000010000000', 'hex')
  );

const evidence = (): EncryptedUploadProfileSelectionEvidence => ({
  encryptedUploadV2Capabilities: validCapabilities(),
  recordingGeneration: 9,
  recordingStorageFormat: 3,
  historicalP10HeaderObserved: false,
});

const selected = (
  policy: EncryptedUploadProfileSelection['policy'],
  profile: EncryptedUploadProfileSelection['profile']
): EncryptedUploadProfileSelection => ({ policy, profile });

const errorCode = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('Encrypted Upload v2 profile selection', () => {
  it('requires explicit complete batch capabilities and full generation for v2', () => {
    const decision = selected('v2_preferred', 'encrypted_upload_v2');
    expect(validateEncryptedUploadProfileSelection(decision, evidence())).toBe(decision);

    expect(
      errorCode(() =>
        validateEncryptedUploadProfileSelection(decision, {
          ...evidence(),
          encryptedUploadV2Capabilities: undefined,
        })
      )
    ).toBe('encrypted_upload_v2_unsupported');

    for (const recordingStorageFormat of [undefined, 2]) {
      expect(
        errorCode(() =>
          validateEncryptedUploadProfileSelection(decision, {
            ...evidence(),
            recordingStorageFormat,
          })
        )
      ).toBe('encrypted_upload_v2_unsupported');
    }
    expect(
      errorCode(() =>
        validateEncryptedUploadProfileSelection(decision, {
          ...evidence(),
          recordingGeneration: undefined,
        })
      )
    ).toBe('encrypted_upload_v2_unsupported');
  });

  it.each([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40])(
    'rejects v2 when required capability bit %# is absent',
    (missingBit) => {
      const current = evidence();
      current.encryptedUploadV2Capabilities = {
        ...validCapabilities(),
        flags: 0x7f & ~missingBit,
      };
      expect(
        errorCode(() =>
          validateEncryptedUploadProfileSelection(
            selected('legacy_allowed', 'encrypted_upload_v2'),
            current
          )
        )
      ).toBe('encrypted_upload_v2_unsupported');
    }
  );

  it('does not require the undefined streaming-v2 capability', () => {
    const current = evidence();
    current.encryptedUploadV2Capabilities = {
      ...validCapabilities(),
      flags: 0xff,
    };
    expect(() =>
      validateEncryptedUploadProfileSelection(
        selected('v2_preferred', 'encrypted_upload_v2'),
        current
      )
    ).not.toThrow();
  });

  it.each([
    ['maximumSignedBlobBytes', 407],
    ['maximumManifestBytes', 579],
    ['maximumDataPayloadBytes', 0],
    ['maximumWindowPackets', 0],
    ['durableCheckpointIntervalBlocks', 0],
    ['maximumMissingSequences', 0],
  ] as const)('rejects unusable %s', (field, value) => {
    const current = evidence();
    current.encryptedUploadV2Capabilities = {
      ...validCapabilities(),
      [field]: value,
    };
    expect(
      errorCode(() =>
        validateEncryptedUploadProfileSelection(
          selected('v2_preferred', 'encrypted_upload_v2'),
          current
        )
      )
    ).toBe('encrypted_upload_v2_unsupported');
  });

  it.each(['legacy_plain_v1', 'legacy_p10_relay'] as const)(
    'rejects %s when v2 is required',
    (profile) => {
      expect(
        errorCode(() =>
          validateEncryptedUploadProfileSelection(
            selected('v2_required', profile),
            { ...evidence(), historicalP10HeaderObserved: true }
          )
        )
      ).toBe('encrypted_upload_v2_required');
    }
  );

  it('requires an observed historical P10 header and never treats it as plain v1', () => {
    expect(
      errorCode(() =>
        validateEncryptedUploadProfileSelection(
          selected('legacy_allowed', 'legacy_p10_relay'),
          evidence()
        )
      )
    ).toBe('legacy_p10_relay_not_observed');

    const observed = { ...evidence(), historicalP10HeaderObserved: true };
    expect(
      validateEncryptedUploadProfileSelection(
        selected('legacy_allowed', 'legacy_p10_relay'),
        observed
      ).profile
    ).toBe('legacy_p10_relay');
    expect(
      errorCode(() =>
        validateEncryptedUploadProfileSelection(
          selected('legacy_allowed', 'legacy_plain_v1'),
          observed
        )
      )
    ).toBe('legacy_p10_relay_required');
  });

  it('permits backend-selected v1 under v2_preferred when capability is absent', () => {
    const decision = selected('v2_preferred', 'legacy_plain_v1');
    expect(
      validateEncryptedUploadProfileSelection(decision, {
        encryptedUploadV2Capabilities: undefined,
        recordingGeneration: undefined,
        recordingStorageFormat: undefined,
        historicalP10HeaderObserved: false,
      })
    ).toBe(decision);
  });
});
