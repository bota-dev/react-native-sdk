/**
 * WiFi network scanning utility.
 *
 * Provides cross-platform WiFi network discovery:
 * - Android: Full network scan via OS APIs
 * - iOS: Current connected SSID only (no scan API available)
 *
 * Requires `react-native-wifi-reborn` as an optional peer dependency.
 */

import { Platform, PermissionsAndroid } from 'react-native';

/** A WiFi network discovered by scanning. */
export interface WiFiNetwork {
  ssid: string;
  /** Signal strength in dBm (Android only) */
  level?: number;
  /** Signal quality 0-100 (derived from level) */
  quality?: number;
}

/** Result of a WiFi scan operation. */
export interface WiFiScanResult {
  /** Scanned networks sorted by signal strength (Android only, empty on iOS) */
  networks: WiFiNetwork[];
  /** Currently connected SSID, if any */
  currentSsid: string | null;
}

let WifiManager: any;
try {
  WifiManager = require('react-native-wifi-reborn').default;
} catch {
  // react-native-wifi-reborn not installed — WiFiScanner methods will throw
}

function ensureAvailable(): void {
  if (!WifiManager) {
    throw new Error(
      'react-native-wifi-reborn is required for WiFi scanning. ' +
        'Install it with: npm install react-native-wifi-reborn'
    );
  }
}

/** Convert dBm signal level to 0-100 quality percentage. */
export function signalToQuality(level: number): number {
  const clamped = Math.max(-100, Math.min(-30, level));
  return Math.round(((clamped + 100) / 70) * 100);
}

/**
 * Request location permission required for WiFi scanning.
 *
 * Android requires ACCESS_FINE_LOCATION; iOS handles permission via system prompts.
 */
export async function requestWiFiPermission(): Promise<boolean> {
  if (Platform.OS === 'android') {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      {
        title: 'Location Permission',
        message: 'Location permission is needed to scan for WiFi networks.',
        buttonPositive: 'OK',
      }
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  }
  return true;
}

/**
 * Get the SSID of the currently connected WiFi network.
 *
 * Works on both Android and iOS. Returns null if not connected or permission denied.
 */
export async function getCurrentSSID(): Promise<string | null> {
  ensureAvailable();
  try {
    return await WifiManager.getCurrentWifiSSID();
  } catch {
    return null;
  }
}

/**
 * Scan for nearby WiFi networks.
 *
 * - Android: Returns all visible networks, deduplicated by SSID (strongest signal kept),
 *   sorted by signal strength.
 * - iOS: Returns empty array (no scan API available). Use `getCurrentSSID()` instead.
 *
 * Requires location permission (call `requestWiFiPermission()` first).
 */
export async function scanNetworks(): Promise<WiFiNetwork[]> {
  ensureAvailable();

  if (Platform.OS !== 'android') {
    return [];
  }

  const wifiList = await WifiManager.loadWifiList();

  // Deduplicate by SSID, keep strongest signal
  const ssidMap = new Map<string, WiFiNetwork>();
  for (const ap of wifiList) {
    if (!ap.SSID || ap.SSID.length === 0) continue;
    const existing = ssidMap.get(ap.SSID);
    if (!existing || (ap.level && existing.level && ap.level > existing.level)) {
      ssidMap.set(ap.SSID, {
        ssid: ap.SSID,
        level: ap.level,
        quality: ap.level != null ? signalToQuality(ap.level) : undefined,
      });
    }
  }

  return Array.from(ssidMap.values()).sort(
    (a, b) => (b.quality ?? 0) - (a.quality ?? 0)
  );
}

/**
 * Perform a full WiFi scan: request permission, get current SSID, and scan networks.
 *
 * Convenience method that combines `requestWiFiPermission()`, `getCurrentSSID()`,
 * and `scanNetworks()` into a single call.
 *
 * Returns null if permission is denied.
 */
export async function scan(): Promise<WiFiScanResult | null> {
  const hasPermission = await requestWiFiPermission();
  if (!hasPermission) return null;

  const [currentSsid, networks] = await Promise.all([
    getCurrentSSID(),
    scanNetworks(),
  ]);

  return { networks, currentSsid };
}
