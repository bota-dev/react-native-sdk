/**
 * Bluetooth Service and Characteristic UUIDs for Bota devices
 * Based on Device-App Protocol specification
 */

// Standard Bluetooth SIG Services
export const SERVICE_DEVICE_INFO = '180A';
export const SERVICE_BATTERY = '180F';
export const SERVICE_NORDIC_DFU = 'FE59';

// Bota Custom Services
export const SERVICE_BOTA_AUDIO = 'B07A0001-0000-1000-8000-00805F9B34FB';
export const SERVICE_BOTA_CONTROL = 'B07A0002-0000-1000-8000-00805F9B34FB';
export const SERVICE_BOTA_PROVISIONING = 'B07A0003-0000-1000-8000-00805F9B34FB';
export const SERVICE_BOTA_STORAGE = 'B07A0004-0000-1000-8000-00805F9B34FB';
export const SERVICE_BOTA_AUTH = 'B07A0005-0000-1000-8000-00805F9B34FB';
export const SERVICE_BOTA_WIFI_CONFIG = 'B07A0006-0000-1000-8000-00805F9B34FB';

// Device Information Service Characteristics (0x180A)
export const CHAR_MANUFACTURER_NAME = '2A29';
export const CHAR_MODEL_NUMBER = '2A24';
export const CHAR_SERIAL_NUMBER = '2A25';
export const CHAR_HARDWARE_REVISION = '2A27';
export const CHAR_FIRMWARE_REVISION = '2A26';

// Battery Service Characteristics (0x180F)
export const CHAR_BATTERY_LEVEL = '2A19';

// Bota Audio Service Characteristics (B07A0001)
export const CHAR_AUDIO_DATA = 'B07A0001-0001-1000-8000-00805F9B34FB';
export const CHAR_AUDIO_CODEC = 'B07A0001-0002-1000-8000-00805F9B34FB';
export const CHAR_AUDIO_CONTROL = 'B07A0001-0003-1000-8000-00805F9B34FB';

// Bota Control Service Characteristics (B07A0002)
export const CHAR_DEVICE_STATUS = 'B07A0002-0001-1000-8000-00805F9B34FB';
export const CHAR_RECORDING_CONTROL = 'B07A0002-0002-1000-8000-00805F9B34FB';
export const CHAR_RECORDING_STATUS = 'B07A0002-0003-1000-8000-00805F9B34FB';
export const CHAR_TIME_SYNC = 'B07A0002-0004-1000-8000-00805F9B34FB';
export const CHAR_DEVICE_COMMAND = 'B07A0002-0005-1000-8000-00805F9B34FB';

// Bota Provisioning Service Characteristics (B07A0003)
export const CHAR_PAIRING_STATE = 'B07A0003-0001-1000-8000-00805F9B34FB';
export const CHAR_DEVICE_TOKEN = 'B07A0003-0002-1000-8000-00805F9B34FB';
export const CHAR_API_ENDPOINT = 'B07A0003-0003-1000-8000-00805F9B34FB';
export const CHAR_WIFI_CONFIG = 'B07A0003-0004-1000-8000-00805F9B34FB';
export const CHAR_PROVISIONING_RESULT = 'B07A0003-0005-1000-8000-00805F9B34FB';
export const CHAR_DEVICE_SETTINGS = 'B07A0003-0006-1000-8000-00805F9B34FB';

// Bota Storage Service Characteristics (B07A0004)
export const CHAR_STORAGE_INFO = 'B07A0004-0001-1000-8000-00805F9B34FB';
export const CHAR_RECORDING_LIST = 'B07A0004-0002-1000-8000-00805F9B34FB';
export const CHAR_RECORDING_TRANSFER = 'B07A0004-0003-1000-8000-00805F9B34FB';
export const CHAR_TRANSFER_CONTROL = 'B07A0004-0004-1000-8000-00805F9B34FB';
export const CHAR_TRANSFER_STATUS = 'B07A0004-0005-1000-8000-00805F9B34FB';

// Bota Auth Service Characteristics (B07A0005)
export const CHAR_PK_D = 'B07A0005-0001-1000-8000-00805F9B34FB';
export const CHAR_AUTH_NONCE = 'B07A0005-0002-1000-8000-00805F9B34FB';

// Bota WiFi Config Service Characteristics (B07A0006)
export const CHAR_WIFI_GRANT = 'B07A0006-0001-1000-8000-00805F9B34FB';
export const CHAR_WIFI_CREDENTIAL = 'B07A0006-0002-1000-8000-00805F9B34FB';
export const CHAR_WIFI_STATUS = 'B07A0006-0003-1000-8000-00805F9B34FB';
export const CHAR_WIFI_SCAN = 'B07A0006-0004-1000-8000-00805F9B34FB';

// WiFi scan command / status codes
export const WIFI_SCAN_CMD_START = 0x01;
export const WIFI_SCAN_STATUS_SCANNING = 0x01;
export const WIFI_SCAN_STATUS_DONE = 0x02;
export const WIFI_SCAN_STATUS_ERROR = 0x03;

// Device name prefixes for scanning
export const DEVICE_NAME_PREFIX = 'Bota-';
export const DEVICE_NAME_PREFIX_PIN = 'Bota-Pin-';
export const DEVICE_NAME_PREFIX_PIN_4G = 'Bota-Pin4G-';
export const DEVICE_NAME_PREFIX_NOTE = 'Bota-Note-';

// Manufacturer data byte positions
export const MFG_DATA_DEVICE_TYPE = 0;
export const MFG_DATA_FW_MAJOR = 1;
export const MFG_DATA_FW_MINOR = 2;
export const MFG_DATA_PAIRING_STATE = 3;
export const MFG_DATA_BATTERY = 4;

// Device type values in manufacturer data
export const DEVICE_TYPE_PIN = 0x01;
export const DEVICE_TYPE_PIN_4G = 0x02;
export const DEVICE_TYPE_NOTE = 0x03;

// Device capability flags (bitmask)
export const CAP_BLE_SYNC = 0x01;
export const CAP_WIFI_UPLOAD = 0x02;
export const CAP_LTE_UPLOAD = 0x04;
export const CAP_REMOTE_RECORD = 0x08;

// Pairing state values
export const PAIRING_STATE_UNPAIRED = 0x00;
export const PAIRING_STATE_PAIRING = 0x01;
export const PAIRING_STATE_PAIRED = 0x02;
export const PAIRING_STATE_ERROR = 0x03;

// WiFi status values
export const WIFI_STATUS_IDLE = 0x00;
export const WIFI_STATUS_CONNECTING = 0x01;
export const WIFI_STATUS_CONNECTED = 0x02;
export const WIFI_STATUS_FAILED = 0x03;
export const WIFI_STATUS_DISCONNECTED = 0x04;

// Provisioning result codes
export const PROVISIONING_SUCCESS = 0x00;
export const PROVISIONING_INVALID_TOKEN = 0x01;
export const PROVISIONING_STORAGE_ERROR = 0x02;
export const PROVISIONING_CHUNK_ERROR = 0x03;

// WiFi configuration result codes
export const WIFI_CONFIG_SUCCESS = 0x00;
export const WIFI_CONFIG_INVALID_GRANT = 0x01;
export const WIFI_CONFIG_GRANT_EXPIRED = 0x02;
export const WIFI_CONFIG_DECRYPTION_ERROR = 0x03;
export const WIFI_CONFIG_STORAGE_ERROR = 0x04;

// API endpoint values
export const API_ENDPOINT_DEV = 0x00;
export const API_ENDPOINT_PROD = 0x01;

// Transfer control commands
export const TRANSFER_CMD_LIST = 0x01;
export const TRANSFER_CMD_START = 0x02;
export const TRANSFER_CMD_TRIGGER_DEVICE_UPLOAD = 0x03;
export const TRANSFER_CMD_CONFIRM_SYNC = 0x07;

// Trigger device upload response codes (on TRANSFER_STATUS, byte[0]=0x03)
export const TRIGGER_UPLOAD_ACCEPTED = 0x00;
export const TRIGGER_UPLOAD_NO_NETWORK = 0x01;
export const TRIGGER_UPLOAD_BUSY = 0x02;
export const TRIGGER_UPLOAD_NO_TOKEN = 0x03;

// Device upload monitoring
export const DEVICE_UPLOAD_POLL_INTERVAL = 3000; // Poll device status every 3s
export const DEVICE_UPLOAD_TIMEOUT = 600000; // 10 minute max

// Smart-sync network warmup — wait for WiFi/4G to come up before triggering
// device-side upload. Cellular registration + PDP activation can take 10–30s
// after a cold modem boot, so a fixed delay is unreliable.
export const NETWORK_WARMUP_TIMEOUT = 30000;
export const NETWORK_WARMUP_POLL_INTERVAL = 2000;

// Transfer packet types (Device → App)
export const PACKET_TYPE_DATA = 0x01;
export const PACKET_TYPE_EOF = 0x02;
export const PACKET_TYPE_PAUSED = 0x03; // Streaming mode: caught up to recording write position
export const PACKET_TYPE_ERROR = 0xff;

// ACK types (App → Device)
export const ACK_TYPE_ACK = 0x10;
export const ACK_TYPE_NACK = 0x11;
export const ACK_TYPE_ABORT = 0x12;

// Device command values
export const DEVICE_CMD_FACTORY_RESET = 0x01;
export const DEVICE_CMD_ENTER_DFU = 0x03;
export const DEVICE_CMD_BLE_DEPROVISION = 0x05; // P5.B: grant-gated BLE deprovision (clears token + pairing state)

// Recording control opcodes (for remote start/stop)
export const RECORDING_CMD_LOCAL_START = 0x01;
export const RECORDING_CMD_LOCAL_STOP = 0x02;
export const RECORDING_CMD_GRANT_START = 0x10;
export const RECORDING_CMD_GRANT_STOP = 0x11;

// Recording control response codes
export const RECORDING_RESULT_SUCCESS = 0x00;
export const RECORDING_RESULT_ERROR = 0x01;
export const RECORDING_RESULT_ALREADY_RECORDING = 0x02;
export const RECORDING_RESULT_NOT_RECORDING = 0x03;
export const RECORDING_RESULT_INVALID_GRANT = 0x04;
export const RECORDING_RESULT_GRANT_EXPIRED = 0x05;
export const RECORDING_RESULT_INVALID_STATE = 0x06;

// Device state values (DEVICE_STATUS byte 2)
// See: FIRMWARE_INTEGRATION_GUIDE_ZH.md section 3.1 — DeviceState enum
export const DEVICE_STATE_IDLE = 0x00;
export const DEVICE_STATE_RECORDING = 0x01;
export const DEVICE_STATE_SYNCING = 0x02;
export const DEVICE_STATE_UPLOADING = 0x03;
export const DEVICE_STATE_CHARGING = 0x04;
export const DEVICE_STATE_LOW_BATTERY = 0x05;
export const DEVICE_STATE_STORAGE_FULL = 0x06;
export const DEVICE_STATE_ERROR = 0x07;

// Device status flags (1-byte bitmask, DEVICE_STATUS byte 8)
// See: FIRMWARE_INTEGRATION_GUIDE_ZH.md section 3.1 — DeviceFlags enum
export const FLAG_CHARGING = 0x01;
export const FLAG_LOW_BATTERY = 0x02;
export const FLAG_STORAGE_FULL = 0x04;
export const FLAG_WIFI_CONNECTED = 0x08;
export const FLAG_LTE_CONNECTED = 0x10;
export const FLAG_SYNC_ACTIVE = 0x20;

// LTE status values (DEVICE_STATUS byte 1)
export const LTE_STATUS_OFF = 0x00;
export const LTE_STATUS_SEARCHING = 0x01;
export const LTE_STATUS_REGISTERED = 0x02;
export const LTE_STATUS_CONNECTED = 0x03;
export const LTE_STATUS_DENIED = 0x04;
export const LTE_STATUS_NO_SIM = 0x05;
export const LTE_STATUS_ERROR = 0x06;
export const LTE_STATUS_LOW_VOLTAGE = 0x07;
export const LTE_STATUS_DISABLED = 0x08;

// WiFi radio status values (DEVICE_STATUS byte 14) — prefixed to avoid
// collision with WiFi provisioning status constants above (WIFI_STATUS_*)
export const WIFI_RADIO_OFF = 0x00;
export const WIFI_RADIO_SCANNING = 0x01;
export const WIFI_RADIO_CONNECTING = 0x02;
export const WIFI_RADIO_CONNECTED = 0x03;
export const WIFI_RADIO_CONNECT_FAILED = 0x04;
export const WIFI_RADIO_NO_CREDENTIALS = 0x05;
export const WIFI_RADIO_DISABLED = 0x06;
export const WIFI_RADIO_ERROR = 0x07;

// Audio codec values
export const CODEC_PCM_16K = 0x00;
export const CODEC_PCM_8K = 0x01;
export const CODEC_OPUS_16K = 0x10;
export const CODEC_OPUS_8K = 0x11;

// Bluetooth error codes
export const BLE_ERROR_SUCCESS = 0x00;
export const BLE_ERROR_INVALID_COMMAND = 0x01;
export const BLE_ERROR_INVALID_STATE = 0x02;
export const BLE_ERROR_INVALID_PARAMETER = 0x03;
export const BLE_ERROR_STORAGE_FULL = 0x10;
export const BLE_ERROR_RECORDING_NOT_FOUND = 0x11;
export const BLE_ERROR_TRANSFER_FAILED = 0x12;
export const BLE_ERROR_TOKEN_INVALID = 0x20;
export const BLE_ERROR_TOKEN_EXPIRED = 0x21;
export const BLE_ERROR_NETWORK_ERROR = 0x30;
export const BLE_ERROR_UPLOAD_FAILED = 0x31;
export const BLE_ERROR_UNKNOWN = 0xff;

// Timeouts (ms)
export const SCAN_TIMEOUT = 30000;
export const CONNECTION_TIMEOUT = 30000;
export const OPERATION_TIMEOUT = 10000;
export const TRANSFER_PACKET_TIMEOUT = 2000;
export const STREAMING_PAUSED_TIMEOUT = 60000; // Timeout when device is paused (caught up, waiting for more audio)
export const WIFI_SCAN_TIMEOUT = 15000;

// Transfer settings
export const TRANSFER_WINDOW_SIZE = 4;
export const DEFAULT_MTU = 23;
export const MAX_MTU = 512;
