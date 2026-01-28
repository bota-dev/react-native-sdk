/**
 * Cryptographic utilities for WiFi Upload configuration
 *
 * NOTE: This module requires react-native-quick-crypto to be installed.
 * Add to your app: npm install react-native-quick-crypto
 */

import { Buffer } from 'buffer';

// Type-only import to avoid runtime errors if crypto is not installed
type CryptoModule = typeof import('crypto');

/**
 * Get crypto module (lazy loaded to avoid errors if not installed)
 */
function getCrypto(): CryptoModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('react-native-quick-crypto') as CryptoModule;
  } catch {
    throw new Error(
      'WiFi Upload requires react-native-quick-crypto. ' +
      'Install it with: npm install react-native-quick-crypto'
    );
  }
}

/**
 * Derive K_session from WiFi config grant.
 * K_session is used by device and app to encrypt/decrypt WiFi credentials in transit.
 *
 * Derivation: K_session = HMAC-SHA256(grant_blob, "BOTA_WIFI_SESSION_V1")
 *
 * @param grantBlob - Base64-encoded JWT grant from backend
 * @returns 32-byte K_session as hex string
 */
export function deriveSessionKey(grantBlob: string): string {
  const crypto = getCrypto();

  return crypto
    .createHmac('sha256', grantBlob)
    .update('BOTA_WIFI_SESSION_V1')
    .digest('hex');
}

/**
 * Encrypt WiFi credentials for BLE transmission using ChaCha20-Poly1305.
 *
 * Format sent to device:
 * - 12 bytes: nonce (random)
 * - N bytes: encrypted SSID
 * - 16 bytes: auth tag for SSID
 * - M bytes: encrypted password
 * - 16 bytes: auth tag for password
 *
 * @param ssid - WiFi network SSID
 * @param password - WiFi password
 * @param sessionKey - K_session derived from grant (hex string)
 * @returns Encrypted payload ready for BLE transmission
 */
export function encryptWiFiCredentials(
  ssid: string,
  password: string,
  sessionKey: string
): {
  nonce: Buffer;
  ssidEncrypted: Buffer;
  ssidAuthTag: Buffer;
  passwordEncrypted: Buffer;
  passwordAuthTag: Buffer;
} {
  const crypto = getCrypto();

  // Convert session key from hex to Buffer
  const keyBuffer = Buffer.from(sessionKey, 'hex');

  // Generate random nonce (12 bytes for ChaCha20-Poly1305)
  const nonce = crypto.randomBytes(12);

  // Encrypt SSID
  const ssidCipher = crypto.createCipheriv('chacha20-poly1305', keyBuffer, nonce, {
    authTagLength: 16,
  });
  const ssidEncrypted = Buffer.concat([
    ssidCipher.update(ssid, 'utf-8'),
    ssidCipher.final(),
  ]);
  const ssidAuthTag = ssidCipher.getAuthTag();

  // Encrypt password (reuse same nonce with different additional data)
  const passwordCipher = crypto.createCipheriv('chacha20-poly1305', keyBuffer, nonce, {
    authTagLength: 16,
  });
  // Use different AAD to prevent nonce reuse issues
  passwordCipher.setAAD(Buffer.from('password'));
  const passwordEncrypted = Buffer.concat([
    passwordCipher.update(password, 'utf-8'),
    passwordCipher.final(),
  ]);
  const passwordAuthTag = passwordCipher.getAuthTag();

  return {
    nonce,
    ssidEncrypted,
    ssidAuthTag,
    passwordEncrypted,
    passwordAuthTag,
  };
}

/**
 * Decrypt WiFi credentials received from device (if needed for verification).
 *
 * @param encrypted - Encrypted SSID or password
 * @param nonce - 12-byte nonce
 * @param authTag - 16-byte authentication tag
 * @param sessionKey - K_session derived from grant (hex string)
 * @param aad - Additional authenticated data (optional, use 'password' for password field)
 * @returns Decrypted plaintext
 */
export function decryptWiFiCredential(
  encrypted: Buffer,
  nonce: Buffer,
  authTag: Buffer,
  sessionKey: string,
  aad?: string
): string {
  const crypto = getCrypto();

  // Convert session key from hex to Buffer
  const keyBuffer = Buffer.from(sessionKey, 'hex');

  // Decrypt with ChaCha20-Poly1305
  const decipher = crypto.createDecipheriv('chacha20-poly1305', keyBuffer, nonce, {
    authTagLength: 16,
  });

  decipher.setAuthTag(authTag);

  if (aad) {
    decipher.setAAD(Buffer.from(aad));
  }

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf-8');
}

/**
 * Format encrypted WiFi credentials for BLE transmission.
 *
 * Packet format:
 * [nonce (12 bytes)][ssid_encrypted (N bytes)][ssid_tag (16 bytes)]
 * [password_encrypted (M bytes)][password_tag (16 bytes)]
 *
 * @param encrypted - Result from encryptWiFiCredentials
 * @returns Single buffer ready for BLE write
 */
export function formatWiFiCredentialPacket(encrypted: {
  nonce: Buffer;
  ssidEncrypted: Buffer;
  ssidAuthTag: Buffer;
  passwordEncrypted: Buffer;
  passwordAuthTag: Buffer;
}): Buffer {
  return Buffer.concat([
    encrypted.nonce,
    encrypted.ssidEncrypted,
    encrypted.ssidAuthTag,
    encrypted.passwordEncrypted,
    encrypted.passwordAuthTag,
  ]);
}

/**
 * Parse encrypted WiFi credential packet received from device.
 *
 * @param packet - Buffer received from BLE
 * @param ssidLength - Expected SSID encrypted length
 * @param passwordLength - Expected password encrypted length
 * @returns Parsed components
 */
export function parseWiFiCredentialPacket(
  packet: Buffer,
  ssidLength: number,
  passwordLength: number
): {
  nonce: Buffer;
  ssidEncrypted: Buffer;
  ssidAuthTag: Buffer;
  passwordEncrypted: Buffer;
  passwordAuthTag: Buffer;
} {
  let offset = 0;

  const nonce = packet.subarray(offset, offset + 12);
  offset += 12;

  const ssidEncrypted = packet.subarray(offset, offset + ssidLength);
  offset += ssidLength;

  const ssidAuthTag = packet.subarray(offset, offset + 16);
  offset += 16;

  const passwordEncrypted = packet.subarray(offset, offset + passwordLength);
  offset += passwordLength;

  const passwordAuthTag = packet.subarray(offset, offset + 16);
  offset += 16;

  return {
    nonce,
    ssidEncrypted,
    ssidAuthTag,
    passwordEncrypted,
    passwordAuthTag,
  };
}
