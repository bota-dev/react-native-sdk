/**
 * Regression test for the "2A26-read disconnect during pair" race.
 *
 * Root cause: `isUserOpInFlight()` used to be a boolean set only for the
 * duration of a single radio op (the connect). A pairing transaction is
 * connect + several GATT reads; the flag dropped after the connect, so the
 * background auto-reconnect loop slipped in between the connect and the first
 * read, probed the in-range peripheral, and — on an SN mismatch against a
 * stale reconnect target — disconnected the link the pair was mid-handshake on.
 *
 * The fix makes the user-op state a refcount with an explicit
 * `beginUserTransaction()` span that a higher-level flow holds across the
 * whole transaction. This test pins the invariant: the flag stays true for the
 * full span (across awaits), is refcounted, and release is idempotent.
 *
 * Note: this exercises only the arbiter's user-op accounting — it does not need
 * a real BLE adapter. The `manager` field is never touched on these paths.
 */
import { BleManager } from './BleManager';

// react-native-ble-plx is a native module; stub it so the class constructs.
jest.mock('react-native-ble-plx', () => ({
  BleManager: jest.fn().mockImplementation(() => ({
    onStateChange: jest.fn(),
    state: jest.fn().mockResolvedValue('PoweredOn'),
  })),
  State: { PoweredOn: 'PoweredOn' },
}));

describe('BleManager user-transaction arbitration', () => {
  let ble: BleManager;

  beforeEach(() => {
    ble = new BleManager();
  });

  it('is not in flight at rest', () => {
    expect(ble.isUserOpInFlight()).toBe(false);
  });

  it('holds in-flight across the whole transaction span (multiple awaits)', async () => {
    const end = ble.beginUserTransaction();
    expect(ble.isUserOpInFlight()).toBe(true);

    // Simulate the connect + read steps a pair performs — the flag must NOT
    // drop between them (this is the window the reconnect loop used to exploit).
    await Promise.resolve();
    expect(ble.isUserOpInFlight()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(ble.isUserOpInFlight()).toBe(true);

    end();
    expect(ble.isUserOpInFlight()).toBe(false);
  });

  it('is refcounted — nested/concurrent transactions both must end', () => {
    const end1 = ble.beginUserTransaction();
    const end2 = ble.beginUserTransaction();
    expect(ble.isUserOpInFlight()).toBe(true);

    end1();
    expect(ble.isUserOpInFlight()).toBe(true); // end2 still holding

    end2();
    expect(ble.isUserOpInFlight()).toBe(false);
  });

  it('release is idempotent — double-release does not underflow the refcount', () => {
    const end = ble.beginUserTransaction();
    const other = ble.beginUserTransaction();

    end();
    end(); // double-release: must be a no-op, not a second decrement
    expect(ble.isUserOpInFlight()).toBe(true); // `other` still holds

    other();
    expect(ble.isUserOpInFlight()).toBe(false);
  });
});
