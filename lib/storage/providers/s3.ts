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
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  StorageProvider,
  StorageCapabilities,
  StorageObject,
  UploadOptions,
  UploadResult,
  DeleteResult,
} from '@/lib/storage/providers/types';
import { validateStorageKey } from '@/lib/storage/providers/validate-key';
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
  /**
   * The bucket blocks public access, so every object is private regardless
   * of ACL (default: false).
   *
   * This is the AWS-recommended posture — Block Public Access plus a bucket
   * policy — and it is indistinguishable from a wide-open bucket at the SDK
   * level. Set it to declare `privateObjects` without turning ACLs back on.
   */
  privateByDefault?: boolean;
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
  private privateByDefault: boolean;
  /** Warn once per process, not once per upload — see `upload()`. */
  private publicFalseWarned = false;

  /**
   * Private objects need either ACLs (so `public: false` can send
   * `ACL: private`) or a bucket that blocks public access outright. With
   * neither, `public: false` is accepted and cannot be honoured.
   */
  get capabilities(): Partial<StorageCapabilities> {
    return {
      privateObjects: this.useAcl || this.privateByDefault,
      signedUrls: true,
      download: true,
    };
  }

  constructor(config: S3ProviderConfig) {
    this.bucket = config.bucket;
    this.useAcl = config.useAcl ?? false;
    this.privateByDefault = config.privateByDefault ?? false;

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
    validateStorageKey(key);

    // Deliberately a warning, not a throw. The safest S3 posture — Block
    // Public Access with a bucket policy, i.e. S3_USE_ACL=false and every
    // object already private — is also the one this branch cannot verify.
    // Throwing would reject the correct configuration; the operator opts
    // in with S3_OBJECTS_PRIVATE_BY_DEFAULT. Callers that need certainty
    // check `capabilities.privateObjects` before uploading.
    if (options.public === false && !this.useAcl && !this.privateByDefault) {
      if (!this.publicFalseWarned) {
        this.publicFalseWarned = true;
        logger.warn('S3 upload requested public:false but the provider cannot enforce it', {
          bucket: this.bucket,
          reason: 'S3_USE_ACL is false and S3_OBJECTS_PRIVATE_BY_DEFAULT is not set',
          effect:
            'The object inherits the bucket default. If the bucket blocks public access this is already private — set S3_OBJECTS_PRIVATE_BY_DEFAULT=true to declare it.',
        });
      }
    }

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
    validateStorageKey(key);
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

  async deletePrefix(prefix: string): Promise<DeleteResult> {
    validateStorageKey(prefix);
    try {
      // List all objects with the prefix
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
      });

      const listResult = await this.client.send(listCommand);
      const objects = listResult.Contents;

      if (!objects || objects.length === 0) {
        logger.debug('No objects found for prefix', { prefix });
        return { success: true, key: prefix };
      }

      // Filter out objects with undefined keys
      const keysToDelete = objects
        .map((obj) => obj.Key)
        .filter((key): key is string => key !== undefined);

      if (keysToDelete.length === 0) {
        logger.debug('No valid keys found for prefix', { prefix });
        return { success: true, key: prefix };
      }

      // Batch delete all objects
      const deleteCommand = new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: {
          Objects: keysToDelete.map((key) => ({ Key: key })),
        },
      });

      await this.client.send(deleteCommand);

      logger.info('Objects deleted from S3 by prefix', {
        prefix,
        count: objects.length,
      });

      return { success: true, key: prefix };
    } catch (error) {
      logger.error('Failed to delete objects from S3 by prefix', error, { prefix });
      return { success: false, key: prefix };
    }
  }

  async download(key: string): Promise<StorageObject> {
    validateStorageKey(key);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const response = await this.client.send(command);
    if (!response.Body) {
      throw new Error(`Object not found in S3: ${key}`);
    }

    // `transformToByteArray` is on the SDK's stream mixin in every runtime
    // it supports (Node, browser, React Native), so there is no per-runtime
    // branch to write here.
    const bytes = await response.Body.transformToByteArray();
    const body = Buffer.from(bytes);

    logger.debug('Downloaded object from S3', { key, size: body.length });

    return {
      key,
      body,
      size: body.length,
      ...(response.ContentType ? { contentType: response.ContentType } : {}),
    };
  }

  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    validateStorageKey(key);
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
  const privateByDefault = process.env.S3_OBJECTS_PRIVATE_BY_DEFAULT === 'true';

  if (!bucket || !accessKeyId || !secretAccessKey) {
    logger.debug('S3 provider not configured - missing required env vars', {
      missingEnv: [
        !bucket && 'S3_BUCKET',
        !accessKeyId && 'S3_ACCESS_KEY_ID',
        !secretAccessKey && 'S3_SECRET_ACCESS_KEY',
      ].filter(Boolean),
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
    privateByDefault,
  });
}
