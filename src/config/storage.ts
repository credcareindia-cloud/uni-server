import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '../utils/logger.js';

export interface StorageConfig {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

export class StorageService {
  private s3Client: S3Client;
  private bucket: string;

  constructor(config: StorageConfig) {
    this.bucket = config.bucket;
    
    this.s3Client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
    });

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
   * Generate a pre-signed URL for downloading files
   */
  async getDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, { expiresIn });
      return signedUrl;
    } catch (error) {
      logger.error('Error generating download URL:', error);
      throw new Error('Failed to generate download URL');
    }
  }

  /**
   * Upload a file directly (for small files)
   */
  async uploadFile(key: string, buffer: Buffer, contentType: string): Promise<void> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
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
    } catch (error) {
      logger.error('Error downloading file:', error);
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
   * Generate a unique storage key for a file
   */
  generateStorageKey(projectId: string, modelId: string, filename: string): string {
    const timestamp = Date.now();
    const extension = filename.split('.').pop();
    return `models/${projectId}/${modelId}/${timestamp}.${extension}`;
  }
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
