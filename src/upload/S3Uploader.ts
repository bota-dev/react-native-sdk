/**
 * S3 Uploader - Handles uploading audio files to S3 using pre-signed URLs
 */

import { Buffer } from 'buffer';

import { UploadError } from '../utils/errors';
import { logger } from '../utils/logger';

const log = logger.tag('S3Uploader');

/**
 * Upload progress callback
 */
export type UploadProgressCallback = (progress: number) => void;

/**
 * Upload options
 */
export interface UploadOptions {
  /** Content type (default: audio/opus) */
  contentType?: string;
  /** Progress callback */
  onProgress?: UploadProgressCallback;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/**
 * S3 Uploader class
 */
export class S3Uploader {
  /**
   * Upload a file to S3 using a pre-signed URL
   */
  async upload(
    data: Buffer,
    uploadUrl: string,
    options: UploadOptions = {}
  ): Promise<void> {
    const {
      contentType = 'audio/opus',
      onProgress,
      abortSignal,
    } = options;

    log.info('Starting S3 upload', {
      size: data.length,
      contentType,
    });

    try {
      // For React Native, we use fetch with the PUT method
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Length': data.length.toString(),
        },
        body: data,
        signal: abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        log.error('S3 upload failed', undefined, {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
        });

        if (response.status === 403) {
          throw UploadError.urlExpired('');
        }

        throw new UploadError(
          `S3 upload failed: ${response.status} ${response.statusText}`,
          'S3_UPLOAD_FAILED'
        );
      }

      // Report completion
      onProgress?.(1.0);

      log.info('S3 upload completed', { size: data.length });
    } catch (error) {
      if (error instanceof UploadError) {
        throw error;
      }

      const err = error as Error;

      // Check for abort
      if (err.name === 'AbortError') {
        throw new UploadError('Upload was cancelled', 'UPLOAD_CANCELLED');
      }

      // Check for network errors
      if (err.message?.includes('Network request failed')) {
        throw UploadError.networkUnavailable();
      }

      throw new UploadError(
        `Upload failed: ${err.message}`,
        'UPLOAD_FAILED',
        undefined,
        err
      );
    }
  }

  /**
   * Upload a file in chunks (for larger files)
   * Note: This requires multipart upload support from the pre-signed URL
   */
  async uploadChunked(
    data: Buffer,
    uploadUrl: string,
    options: UploadOptions = {}
  ): Promise<void> {
    // For now, delegate to simple upload
    // In production, you'd implement S3 multipart upload here
    return this.upload(data, uploadUrl, options);
  }

  /**
   * Notify the backend that upload is complete
   */
  async notifyCompletion(
    completeUrl: string,
    recordingId: string,
    uploadToken: string
  ): Promise<void> {
    log.debug('Notifying upload completion', { recordingId });

    try {
      const response = await fetch(completeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${uploadToken}`,
        },
        body: JSON.stringify({ recording_id: recordingId }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new UploadError(
          `Completion notification failed: ${response.status} - ${errorText}`,
          'COMPLETION_FAILED'
        );
      }

      log.info('Upload completion notified', { recordingId });
    } catch (error) {
      if (error instanceof UploadError) {
        throw error;
      }

      const err = error as Error;
      throw UploadError.completionFailed('', err);
    }
  }
}
