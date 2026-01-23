import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Provider, createS3ProviderFromEnv } from '@/lib/storage/providers/s3';
import { logger } from '@/lib/logging';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  const MockS3Client = vi.fn(function (this: any) {
    this.send = mockSend;
  });

  const MockPutObjectCommand = vi.fn(function (this: any, input: any) {
    Object.assign(this, { ...input, _type: 'PutObjectCommand' });
  });

  const MockDeleteObjectCommand = vi.fn(function (this: any, input: any) {
    Object.assign(this, { ...input, _type: 'DeleteObjectCommand' });
  });

  const MockDeleteObjectsCommand = vi.fn(function (this: any, input: any) {
    Object.assign(this, { ...input, _type: 'DeleteObjectsCommand' });
  });

  const MockGetObjectCommand = vi.fn(function (this: any, input: any) {
    Object.assign(this, { ...input, _type: 'GetObjectCommand' });
  });

  const MockListObjectsV2Command = vi.fn(function (this: any, input: any) {
    Object.assign(this, { ...input, _type: 'ListObjectsV2Command' });
  });

  return {
    S3Client: MockS3Client,
    PutObjectCommand: MockPutObjectCommand,
    DeleteObjectCommand: MockDeleteObjectCommand,
    DeleteObjectsCommand: MockDeleteObjectsCommand,
    GetObjectCommand: MockGetObjectCommand,
    ListObjectsV2Command: MockListObjectsV2Command,
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed-url.example.com/file.jpg?signature=abc'),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('lib/storage/providers/s3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('S3Provider', () => {
    describe('constructor', () => {
      it('should initialize with standard AWS S3 config', () => {
        const provider = new S3Provider({
          bucket: 'test-bucket',
          region: 'us-west-2',
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        });

        expect(provider.name).toBe('s3');
        expect(S3Client).toHaveBeenCalledWith({
          region: 'us-west-2',
          credentials: {
            accessKeyId: 'test-key',
            secretAccessKey: 'test-secret',
          },
        });
        expect(logger.debug).toHaveBeenCalledWith('S3 provider initialized', {
          bucket: 'test-bucket',
          region: 'us-west-2',
          hasEndpoint: false,
        });
      });

      it('should initialize with custom endpoint for S3-compatible services', () => {
        new S3Provider({
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
          endpoint: 'https://minio.example.com',
        });

        expect(S3Client).toHaveBeenCalledWith({
          region: 'us-east-1',
          credentials: {
            accessKeyId: 'test-key',
            secretAccessKey: 'test-secret',
          },
          endpoint: 'https://minio.example.com',
          forcePathStyle: true,
        });
      });
    });

    describe('upload', () => {
      it('should upload file with correct PutObjectCommand params', async () => {
        const provider = new S3Provider({
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        });

        const file = Buffer.from('test file content');
        mockSend.mockResolvedValueOnce({});

        const result = await provider.upload(file, {
          key: 'avatars/user-123/avatar.jpg',
          contentType: 'image/jpeg',
          metadata: { userId: '123' },
        });

        expect(PutObjectCommand).toHaveBeenCalledWith({
          Bucket: 'test-bucket',
          Key: 'avatars/user-123/avatar.jpg',
          Body: file,
          ContentType: 'image/jpeg',
          Metadata: { userId: '123' },
        });
        expect(result).toEqual({
          key: 'avatars/user-123/avatar.jpg',
          url: 'https://test-bucket.s3.us-east-1.amazonaws.com/avatars/user-123/avatar.jpg',
          size: file.length,
        });
      });

      it('should use endpoint-based URL when custom endpoint provided', async () => {
        const provider = new S3Provider({
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
          endpoint: 'https://minio.example.com',
        });

        const file = Buffer.from('test content');
        mockSend.mockResolvedValueOnce({});

        const result = await provider.upload(file, {
          key: 'test/file.jpg',
          contentType: 'image/jpeg',
        });

        expect(result.url).toBe('https://minio.example.com/test-bucket/test/file.jpg');
      });

      it('should use publicUrlBase when provided', async () => {
        const provider = new S3Provider({
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
          publicUrlBase: 'https://cdn.example.com/',
        });

        const file = Buffer.from('test content');
        mockSend.mockResolvedValueOnce({});

        const result = await provider.upload(file, {
          key: 'test/file.jpg',
          contentType: 'image/jpeg',
        });

        expect(result.url).toBe('https://cdn.example.com/test/file.jpg');
      });

      it('should set ACL to public-read when useAcl is true', async () => {
        const provider = new S3Provider({
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
          useAcl: true,
        });

        mockSend.mockResolvedValueOnce({});

        await provider.upload(Buffer.from('test'), {
          key: 'test.jpg',
          contentType: 'image/jpeg',
          public: true,
        });

        expect(PutObjectCommand).toHaveBeenCalledWith(
          expect.objectContaining({ ACL: 'public-read' })
        );
      });

      it('should not set ACL when useAcl is false', async () => {
        const provider = new S3Provider({
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
          useAcl: false,
        });

        mockSend.mockResolvedValueOnce({});

        await provider.upload(Buffer.from('test'), {
          key: 'test.jpg',
          contentType: 'image/jpeg',
        });

        expect(PutObjectCommand).toHaveBeenCalledWith(
          expect.not.objectContaining({ ACL: expect.anything() })
        );
      });
    });

    describe('delete', () => {
      it('should delete file successfully', async () => {
        const provider = new S3Provider({
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        });

        mockSend.mockResolvedValueOnce({});

        const result = await provider.delete('avatars/user-123.jpg');

        expect(DeleteObjectCommand).toHaveBeenCalledWith({
          Bucket: 'test-bucket',
          Key: 'avatars/user-123.jpg',
        });
        expect(result).toEqual({ success: true, key: 'avatars/user-123.jpg' });
      });

      it('should handle errors gracefully', async () => {
        const provider = new S3Provider({
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        });

        mockSend.mockRejectedValueOnce(new Error('Access denied'));

        const result = await provider.delete('avatars/user-123.jpg');

        expect(result).toEqual({ success: false, key: 'avatars/user-123.jpg' });
        expect(logger.error).toHaveBeenCalledWith(
          'Failed to delete file from S3',
          expect.any(Error),
          { key: 'avatars/user-123.jpg' }
        );
      });
    });

    describe('deletePrefix', () => {
      it('should list and batch delete all objects with prefix', async () => {
        const provider = new S3Provider({
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        });

        mockSend
          .mockResolvedValueOnce({
            Contents: [
              { Key: 'avatars/user-123/avatar.jpg' },
              { Key: 'avatars/user-123/thumb.jpg' },
            ],
          })
          .mockResolvedValueOnce({});

        const result = await provider.deletePrefix('avatars/user-123/');

        expect(ListObjectsV2Command).toHaveBeenCalledWith({
          Bucket: 'test-bucket',
          Prefix: 'avatars/user-123/',
        });
        expect(DeleteObjectsCommand).toHaveBeenCalledWith({
          Bucket: 'test-bucket',
          Delete: {
            Objects: [
              { Key: 'avatars/user-123/avatar.jpg' },
              { Key: 'avatars/user-123/thumb.jpg' },
            ],
          },
        });
        expect(result).toEqual({ success: true, key: 'avatars/user-123/' });
      });

      it('should handle empty prefix results', async () => {
        const provider = new S3Provider({
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        });

        mockSend.mockResolvedValueOnce({ Contents: [] });

        const result = await provider.deletePrefix('avatars/user-999/');

        expect(DeleteObjectsCommand).not.toHaveBeenCalled();
        expect(result).toEqual({ success: true, key: 'avatars/user-999/' });
        expect(logger.debug).toHaveBeenCalledWith('No objects found for prefix', {
          prefix: 'avatars/user-999/',
        });
      });

      it('should handle errors gracefully', async () => {
        const provider = new S3Provider({
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        });

        mockSend.mockRejectedValueOnce(new Error('Network error'));

        const result = await provider.deletePrefix('avatars/user-123/');

        expect(result).toEqual({ success: false, key: 'avatars/user-123/' });
        expect(logger.error).toHaveBeenCalledWith(
          'Failed to delete objects from S3 by prefix',
          expect.any(Error),
          { prefix: 'avatars/user-123/' }
        );
      });
    });

    describe('getSignedUrl', () => {
      it('should generate signed URL with default expiration', async () => {
        const provider = new S3Provider({
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        });

        const url = await provider.getSignedUrl('private/doc.pdf');

        expect(getSignedUrl).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ _type: 'GetObjectCommand' }),
          { expiresIn: 3600 }
        );
        expect(url).toBe('https://signed-url.example.com/file.jpg?signature=abc');
      });

      it('should use custom expiration', async () => {
        const provider = new S3Provider({
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        });

        await provider.getSignedUrl('private/doc.pdf', 7200);

        expect(getSignedUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
          expiresIn: 7200,
        });
      });
    });
  });

  describe('createS3ProviderFromEnv', () => {
    it('should create provider with all required env vars', () => {
      vi.stubEnv('S3_BUCKET', 'env-bucket');
      vi.stubEnv('S3_REGION', 'eu-west-1');
      vi.stubEnv('S3_ACCESS_KEY_ID', 'env-key-id');
      vi.stubEnv('S3_SECRET_ACCESS_KEY', 'env-secret');

      const provider = createS3ProviderFromEnv();

      expect(provider).not.toBeNull();
      expect(provider?.name).toBe('s3');
    });

    it('should use default region when S3_REGION not set', () => {
      vi.stubEnv('S3_BUCKET', 'env-bucket');
      vi.stubEnv('S3_ACCESS_KEY_ID', 'env-key-id');
      vi.stubEnv('S3_SECRET_ACCESS_KEY', 'env-secret');

      createS3ProviderFromEnv();

      expect(S3Client).toHaveBeenCalledWith(expect.objectContaining({ region: 'us-east-1' }));
    });

    it('should return null when S3_BUCKET is missing', () => {
      vi.stubEnv('S3_ACCESS_KEY_ID', 'env-key-id');
      vi.stubEnv('S3_SECRET_ACCESS_KEY', 'env-secret');

      const provider = createS3ProviderFromEnv();

      expect(provider).toBeNull();
    });

    it('should return null when S3_ACCESS_KEY_ID is missing', () => {
      vi.stubEnv('S3_BUCKET', 'env-bucket');
      vi.stubEnv('S3_SECRET_ACCESS_KEY', 'env-secret');

      const provider = createS3ProviderFromEnv();

      expect(provider).toBeNull();
    });

    it('should return null when S3_SECRET_ACCESS_KEY is missing', () => {
      vi.stubEnv('S3_BUCKET', 'env-bucket');
      vi.stubEnv('S3_ACCESS_KEY_ID', 'env-key-id');

      const provider = createS3ProviderFromEnv();

      expect(provider).toBeNull();
    });
  });
});
