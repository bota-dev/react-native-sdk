/**
 * Retry utility with exponential backoff
 */

import { logger } from './logger';

const log = logger.tag('Retry');

/**
 * Retry configuration options
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 6) */
  maxAttempts?: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (default: 14400000 = 4 hours) */
  maxDelayMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** Add jitter to delays (default: true) */
  jitter?: boolean;
  /** Callback for each retry attempt */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  /** Predicate to determine if error is retryable (default: all errors) */
  isRetryable?: (error: Error) => boolean;
}

/**
 * Default retry delays based on Bota spec:
 * Attempt 1: Immediate
 * Attempt 2: 30 seconds
 * Attempt 3: 2 minutes
 * Attempt 4: 10 minutes
 * Attempt 5: 1 hour
 * Attempt 6: 4 hours
 */
export const DEFAULT_RETRY_DELAYS = [
  0, // Immediate
  30 * 1000, // 30 seconds
  2 * 60 * 1000, // 2 minutes
  10 * 60 * 1000, // 10 minutes
  60 * 60 * 1000, // 1 hour
  4 * 60 * 60 * 1000, // 4 hours
];

/**
 * Calculate delay for a retry attempt using exponential backoff
 */
export function calculateDelay(
  attempt: number,
  options: RetryOptions = {}
): number {
  const {
    baseDelayMs = 1000,
    maxDelayMs = 14400000,
    backoffMultiplier = 2,
    jitter = true,
  } = options;

  // Use predefined delays for upload retries
  if (attempt < DEFAULT_RETRY_DELAYS.length) {
    const delay = DEFAULT_RETRY_DELAYS[attempt];
    if (jitter && delay > 0) {
      // Add up to 10% jitter
      return delay + Math.random() * delay * 0.1;
    }
    return delay;
  }

  // Fall back to exponential backoff for additional retries
  let delay = baseDelayMs * Math.pow(backoffMultiplier, attempt);
  delay = Math.min(delay, maxDelayMs);

  if (jitter) {
    // Add up to 10% jitter
    delay = delay + Math.random() * delay * 0.1;
  }

  return Math.floor(delay);
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 6,
    onRetry,
    isRetryable = () => true,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if error is retryable
      if (!isRetryable(lastError)) {
        log.debug('Error is not retryable, throwing immediately', {
          attempt,
          error: lastError.message,
        });
        throw lastError;
      }

      // Check if we have more attempts
      if (attempt >= maxAttempts - 1) {
        log.warn('Max retry attempts reached', {
          attempt: attempt + 1,
          maxAttempts,
          error: lastError.message,
        });
        throw lastError;
      }

      // Calculate delay
      const delayMs = calculateDelay(attempt, options);

      log.debug('Retrying after error', {
        attempt: attempt + 1,
        maxAttempts,
        delayMs,
        error: lastError.message,
      });

      // Notify callback
      if (onRetry) {
        onRetry(attempt + 1, lastError, delayMs);
      }

      // Wait before retrying
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError ?? new Error('Retry failed');
}

/**
 * Create a retryable wrapper for a function
 */
export function makeRetryable<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  options: RetryOptions = {}
): T {
  return (async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    return withRetry(() => fn(...args) as Promise<ReturnType<T>>, options);
  }) as T;
}

/**
 * Check if we should continue retrying based on total time elapsed
 */
export function shouldContinueRetrying(
  startTime: Date,
  maxDurationMs: number = 24 * 60 * 60 * 1000 // 24 hours
): boolean {
  const elapsed = Date.now() - startTime.getTime();
  return elapsed < maxDurationMs;
}
