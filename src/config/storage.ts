import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Response } from 'express';
import { logger } from '../utils/logger.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface StorageConfig {
  endpoint?: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket: string;
  forcePathStyle: boolean;
}

export class StorageService {
  private s3Client: S3Client;
  private bucket: string;

  constructor(config: StorageConfig) {
    this.bucket = config.bucket;
    
    // Only use explicit credentials if provided (for local dev with MinIO)
    // In production ECS, omit credentials to use IAM task role
    const s3Config: any = {
      region: config.region,
      forcePathStyle: config.forcePathStyle,
    };
    if (config.endpoint) {
      s3Config.endpoint = config.endpoint;
    }
    
    const accessKeyId = config.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = config.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = process.env.AWS_SESSION_TOKEN;
    if (accessKeyId && secretAccessKey) {
      s3Config.credentials = {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
      };
    }
    
    this.s3Client = new S3Client(s3Config);

    logger.info(`📦 Storage service initialized: ${config.endpoint || 'AWS S3'}`);
    
    // Ensure bucket exists
    this.ensureBucketExists().catch(error => {
      logger.error('Failed to ensure bucket exists:', error);
    });
  }

  /**
   * Ensure the bucket exists, create it if it doesn't
   */
  private async ensureBucketExists(): Promise<void> {
    try {
      // Check if bucket exists
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      logger.info(`✅ Bucket '${this.bucket}' exists`);
    } catch (error) {
      if ((error as any)?.name === 'NotFound' || (error as any)?.$metadata?.httpStatusCode === 404) {
        try {
          // Create bucket if it doesn't exist
          await this.s3Client.send(new CreateBucketCommand({ Bucket: this.bucket }));
          logger.info(`✅ Created bucket '${this.bucket}'`);
        } catch (createError) {
          logger.error(`❌ Failed to create bucket '${this.bucket}':`, {
            message: createError instanceof Error ? createError.message : 'Unknown error',
            code: (createError as any)?.code
          });
          throw createError;
        }
      } else {
        logger.error(`❌ Failed to check bucket '${this.bucket}':`, {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: (error as any)?.code
        });
        throw error;
      }
    }
  }

  /**
   * Generate a pre-signed URL for uploading files
   */
  async getUploadUrl(key: string, contentType: string, expiresIn = 3600): Promise<string> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, { expiresIn });
      return signedUrl;
    } catch (error) {
      logger.error('Error generating upload URL:', error);
      throw new Error('Failed to generate upload URL');
    }
  }

  /**
   * Generate a pre-signed URL for downloading files.
   * Pass filename to force Content-Disposition: attachment on the signed response.
   */
  async getDownloadUrl(
    key: string,
    expiresIn = 3600,
    options?: { filename?: string; contentType?: string }
  ): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options?.contentType ? { ResponseContentType: options.contentType } : {}),
        ...(options?.filename
          ? { ResponseContentDisposition: contentDispositionAttachment(options.filename) }
          : {}),
      });

      return await getSignedUrl(this.s3Client, command, { expiresIn });
    } catch (error) {
      logger.error('Error generating download URL:', error);
      throw new Error('Failed to generate download URL');
    }
  }

  /**
   * Upload a file directly (for small files)
   */
  async uploadFile(
    key: string,
    buffer: Buffer,
    contentType: string,
    metadata?: Record<string, string>
  ): Promise<void> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ...(metadata ? { Metadata: metadata } : {}),
      });

      await this.s3Client.send(command);
      logger.info(`File uploaded successfully: ${key}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error uploading file:', {
        message: errorMessage,
        code: (error as any)?.code,
        statusCode: (error as any)?.$metadata?.httpStatusCode,
        key: key
      });
      throw new Error(`Failed to upload file: ${errorMessage}`);
    }
  }

  /** Head metadata for an object, or null when missing. */
  async headObject(key: string): Promise<{ contentLength: number; contentType?: string } | null> {
    try {
      const head = await this.s3Client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        contentLength: head.ContentLength ?? 0,
        contentType: head.ContentType,
      };
    } catch (error: any) {
      const status = error?.$metadata?.httpStatusCode;
      if (status === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') return null;
      throw error;
    }
  }

  /** True when the object exists in the configured bucket. */
  async objectExists(key: string): Promise<boolean> {
    return (await this.headObject(key)) !== null;
  }

  /**
   * Stream an object straight to an Express response (auth stays on our API; no S3 CORS needed).
   */
  async streamToResponse(
    key: string,
    res: Response,
    options: { filename: string; contentType?: string }
  ): Promise<void> {
    const response = await this.s3Client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    );
    if (!response.Body) throw new Error(`Empty body for ${key}`);

    res.status(200);
    res.setHeader('Content-Type', options.contentType || response.ContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDispositionAttachment(options.filename));
    if (typeof response.ContentLength === 'number') {
      res.setHeader('Content-Length', String(response.ContentLength));
    }
    res.setHeader('Cache-Control', 'private, no-store');

    const body = response.Body as Readable;
    await pipeline(body, res);
  }

  /** Server-side copy within the same bucket (e.g. quote drawing → project documents). */
  async copyObject(sourceKey: string, destKey: string, contentType?: string): Promise<void> {
    await this.s3Client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`,
        Key: destKey,
        ...(contentType
          ? { ContentType: contentType, MetadataDirective: 'REPLACE' as const }
          : { MetadataDirective: 'COPY' as const }),
      })
    );
  }

  /** Delete every object under a prefix (paginated). Best-effort; logs and continues on partial failure. */
  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;

    do {
      const listed = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: normalized,
          ContinuationToken: token,
        })
      );
      const keys = (listed.Contents || []).map((obj) => obj.Key).filter((k): k is string => Boolean(k));
      if (keys.length) {
        const result = await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          })
        );
        deleted += keys.length - (result.Errors?.length || 0);
        if (result.Errors?.length) {
          logger.warn(`Partial prefix delete under ${normalized}`, { errors: result.Errors });
        }
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);

    return deleted;
  }

  /**
   * Download a file and return its buffer
   */
  async downloadFile(key: string): Promise<Buffer> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);
      
      // Convert the stream to a buffer
      const chunks: Uint8Array[] = [];
      const stream = response.Body as any;
      
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      
      const buffer = Buffer.concat(chunks);
      logger.info(`✅ File downloaded successfully: ${key} (${buffer.length} bytes)`);
      return buffer;
    } catch (error: any) {
      logger.error(
        `Error downloading file ${key}: ${error?.name || 'Error'} ${error?.$metadata?.httpStatusCode || ''} ${error?.message || error}`
      );
      throw new Error('Failed to download file');
    }
  }

  /**
   * Delete a file
   */
  async deleteFile(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      logger.info(`File deleted successfully: ${key}`);
    } catch (error) {
      logger.error('Error deleting file:', error);
      throw new Error('Failed to delete file');
    }
  }

  /**
   * Generate a unique storage key for a model file
   */
  generateStorageKey(projectId: string, modelId: string, filename: string): string {
    const timestamp = Date.now();
    const extension = filename.split('.').pop();
    return `models/${projectId}/${modelId}/${timestamp}.${extension}`;
  }

  /**
   * Object key for a quote attachment already tied to a request row.
   * Layout: quotes/{organizationId}/{quoteId}/{kind}/{unique}-{safeName}
   */
  quoteFileKey(
    organizationId: string,
    quoteId: string,
    kind: 'drawing' | 'model',
    filename: string
  ): string {
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'file';
    const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `quotes/${organizationId}/${quoteId}/${kind}/${unique}-${safe}`;
  }

  /**
   * Browser uploads land here first (presigned PUT), then the create-quote call claims the key.
   * Layout: quotes/{organizationId}/inbox/{uploadId}/{kind}/{unique}-{safeName}
   */
  quoteInboxKey(organizationId: string, kind: 'drawing' | 'model', filename: string): string {
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'file';
    const uploadId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const unique = Math.random().toString(36).slice(2, 10);
    return `quotes/${organizationId}/inbox/${uploadId}/${kind}/${unique}-${safe}`;
  }
}

/** RFC 5987 Content-Disposition for non-ASCII filenames. */
function contentDispositionAttachment(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// Initialize storage service
const storageConfig: StorageConfig = {
  endpoint: process.env.STORAGE_ENDPOINT,
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY!,
  secretAccessKey: process.env.STORAGE_SECRET_KEY!,
  bucket: process.env.STORAGE_BUCKET || 'models',
  forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === 'true',
};

export const storageService = new StorageService(storageConfig);
