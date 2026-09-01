import { Buffer } from 'buffer';

import { parseProvisioningResult } from '../parsers';

describe('parseProvisioningResult', () => {
  it('distinguishes reset pending from token storage failure', () => {
    expect(parseProvisioningResult(Buffer.from([0x06]))).toEqual({
      success: false,
      error: 'reset_pending',
    });
  });

  it('recognizes durable reset finalization', () => {
    expect(parseProvisioningResult(Buffer.from([0x07]))).toEqual({
      success: true,
      resetFinalized: true,
    });
  });
});
