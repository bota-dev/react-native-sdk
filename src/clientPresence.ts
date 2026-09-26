import { Platform } from 'react-native';
import { SDK_PACKAGE, SDK_VERSION } from './sdkIdentity';

/** Optional diagnostics, not device attestation or command authority. */
export interface SdkClientContext {
  schema_version: 1;
  session_id: string;
  sequence: number;
  platform: 'ios' | 'android';
  sdk_package: string;
  sdk_version: string;
}

export interface ClientPresence {
  nextReport(deviceId: string): Promise<SdkClientContext | null>;
}

function secureSessionId(): string | null {
  try {
    // Same optional native provider as encrypted upload; never use Math.random.
    const crypto = require('react-native-quick-crypto') as typeof import('crypto');
    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch { return null; }
}

/** @internal In-memory owner. Neither persists nor performs Bluetooth/network I/O. */
export class ConnectionClientPresence implements ClientPresence {
  private readonly sessions = new Map<string, { identity: object; id: string; sequence: number }>();
  private readonly attempts = new Map<string, object>();
  private destroyed = false;

  constructor(private readonly connectionIdentity: (deviceId: string) => object | null) {}

  connecting(deviceId: string): (identity: object) => void {
    const attempt = {};
    this.attempts.set(deviceId, attempt);
    return (identity) => {
      if (this.attempts.get(deviceId) !== attempt) return;
      this.attempts.delete(deviceId);
      this.connected(deviceId, identity);
    };
  }

  private connected(deviceId: string, identity: object): void {
    if (this.destroyed || this.sessions.get(deviceId)?.identity === identity) return;
    this.sessions.delete(deviceId);
    const id = secureSessionId();
    if (id) this.sessions.set(deviceId, { identity, id, sequence: 0 });
  }

  disconnected(deviceId: string): void { this.attempts.delete(deviceId); this.sessions.delete(deviceId); }

  invalidateAll(): void { this.attempts.clear(); this.sessions.clear(); }

  destroy(): void { this.destroyed = true; this.invalidateAll(); }

  async nextReport(deviceId: string): Promise<SdkClientContext | null> {
    const session = this.sessions.get(deviceId);
    if (this.destroyed || !session) return null;
    if (this.connectionIdentity(deviceId) !== session.identity) {
      this.sessions.delete(deviceId);
      return null;
    }
    if (session.sequence >= Number.MAX_SAFE_INTEGER || (Platform.OS !== 'ios' && Platform.OS !== 'android')) return null;
    return {
      schema_version: 1, session_id: session.id, sequence: ++session.sequence,
      platform: Platform.OS, sdk_package: SDK_PACKAGE, sdk_version: SDK_VERSION,
    };
  }
}
