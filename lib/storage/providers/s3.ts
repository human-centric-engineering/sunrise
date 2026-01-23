/**
 * S3 Storage Provider
 *
 * Implements the StorageProvider interface for AWS S3 and S3-compatible services
 * (MinIO, DigitalOcean Spaces, Cloudflare R2, etc.)
 *
 * @see .context/storage/overview.md for configuration documentation
 */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageProvider, UploadOptions, UploadResult, DeleteResult } from './types';
import { logger } from '@/lib/logging';

/**
 * S3 Provider Configuration
 */
export interface S3ProviderConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional endpoint for S3-compatible services (MinIO, DO Spaces, R2) */
  endpoint?: string;
  /** Optional custom public URL base (for CDN or custom domain) */
  publicUrlBase?: string;
  /** Set ACL on uploaded objects (default: false, use bucket policy for public access) */
  useAcl?: boolean;
}

/**
 * S3 Storage Provider
 *
 * Supports AWS S3 and any S3-compatible object storage service.
 */
export class S3Provider implements StorageProvider {
  readonly name = 's3';
  private client: S3Client;
  private bucket: string;
  private publicUrlBase: string;
  private useAcl: boolean;

  constructor(config: S3ProviderConfig) {
    this.bucket = config.bucket;
    this.useAcl = config.useAcl ?? false;

    // Configure S3 client
    this.client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      ...(config.endpoint && {
        endpoint: config.endpoint,
        forcePathStyle: true, // Required for MinIO and some S3-compatible services
      }),
    });

    // Determine public URL base
    if (config.publicUrlBase) {
      this.publicUrlBase = config.publicUrlBase.replace(/\/$/, '');
    } else if (config.endpoint) {
      // S3-compatible service - use endpoint
      this.publicUrlBase = `${config.endpoint}/${config.bucket}`;
    } else {
      // Standard AWS S3
      this.publicUrlBase = `https://${config.bucket}.s3.${config.region}.amazonaws.com`;
    }

    logger.debug('S3 provider initialized', {
      bucket: config.bucket,
      region: config.region,
      hasEndpoint: !!config.endpoint,
    });
  }

  async upload(file: Buffer, options: UploadOptions): Promise<UploadResult> {
    const { key, contentType, metadata } = options;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: file,
      ContentType: contentType,
      Metadata: metadata,
      // Only set ACL if bucket supports it (S3_USE_ACL=true)
      // Modern S3 buckets use bucket policies for public access instead
      ...(this.useAcl && {
        ACL: options.public !== false ? 'public-read' : 'private',
      }),
    });

    await this.client.send(command);

    const url = `${this.publicUrlBase}/${key}`;

    logger.info('File uploaded to S3', {
      key,
      contentType,
      size: file.length,
      url,
    });

    return {
      key,
      url,
      size: file.length,
    };
  }

  async delete(key: string): Promise<DeleteResult> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    try {
      await this.client.send(command);

      logger.info('File deleted from S3', { key });

      return {
        success: true,
        key,
      };
    } catch (error) {
      logger.error('Failed to delete file from S3', error, { key });
      return {
        success: false,
        key,
      };
    }
  }

  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const url = await getSignedUrl(this.client, command, { expiresIn });

    logger.debug('Generated signed URL for S3', { key, expiresIn });

    return url;
  }
}

/**
 * Create S3 provider from environment variables
 *
 * Returns null if required configuration is missing.
 */
export function createS3ProviderFromEnv(): S3Provider | null {
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION || 'us-east-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const endpoint = process.env.S3_ENDPOINT;
  const publicUrlBase = process.env.S3_PUBLIC_URL_BASE;
  const useAcl = process.env.S3_USE_ACL === 'true';

  if (!bucket || !accessKeyId || !secretAccessKey) {
    logger.debug('S3 provider not configured - missing required env vars', {
      hasBucket: !!bucket,
      hasAccessKeyId: !!accessKeyId,
      hasSecretAccessKey: !!secretAccessKey,
    });
    return null;
  }

  return new S3Provider({
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    endpoint,
    publicUrlBase,
    useAcl,
  });
}
