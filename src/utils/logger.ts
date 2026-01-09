/**
 * Logger utility for the Bota SDK
 */

import type { LogLevel } from '../models/Status';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

/**
 * Logger class with configurable log levels
 */
class Logger {
  private level: LogLevel = 'warn';
  private prefix = '[BotaSDK]';

  /**
   * Set the log level
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Get the current log level
   */
  getLevel(): LogLevel {
    return this.level;
  }

  /**
   * Check if a log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  /**
   * Format a log message with optional context
   */
  private format(
    level: string,
    message: string,
    context?: Record<string, unknown>
  ): string {
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    return `${timestamp} ${this.prefix} [${level.toUpperCase()}] ${message}${contextStr}`;
  }

  /**
   * Log a debug message
   */
  debug(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      console.debug(this.format('debug', message, context));
    }
  }

  /**
   * Log an info message
   */
  info(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      console.info(this.format('info', message, context));
    }
  }

  /**
   * Log a warning message
   */
  warn(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      console.warn(this.format('warn', message, context));
    }
  }

  /**
   * Log an error message
   */
  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      const fullContext = error
        ? { ...context, error: error.message, stack: error.stack }
        : context;
      console.error(this.format('error', message, fullContext));
    }
  }

  /**
   * Create a child logger with a specific tag
   */
  tag(tag: string): TaggedLogger {
    return new TaggedLogger(this, tag);
  }
}

/**
 * Tagged logger for component-specific logging
 */
class TaggedLogger {
  constructor(
    private parent: Logger,
    private tag: string
  ) {}

  debug(message: string, context?: Record<string, unknown>): void {
    this.parent.debug(`[${this.tag}] ${message}`, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.parent.info(`[${this.tag}] ${message}`, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.parent.warn(`[${this.tag}] ${message}`, context);
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.parent.error(`[${this.tag}] ${message}`, error, context);
  }
}

/**
 * Singleton logger instance
 */
export const logger = new Logger();

/**
 * Export types for external use
 */
export type { TaggedLogger };
