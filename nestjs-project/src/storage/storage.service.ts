import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  type ListPartsCommandOutput,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  StorageInvalidPartError,
  StorageUploadNotFoundError,
} from './storage.errors';
import type {
  CompletedPartInput,
  PresignedPart,
  SignedUrl,
  StoredObjectInfo,
  UploadedPart,
} from './storage.types';

const INVALID_PART_ERRORS = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
]);
const BUCKET_ALREADY_EXISTS_ERRORS = new Set([
  'BucketAlreadyOwnedByYou',
  'BucketAlreadyExists',
]);

function s3ErrorName(error: unknown): string | undefined {
  return error instanceof S3ServiceException ? error.name : undefined;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.name === 'NotFound' ||
      error.name === 'NoSuchKey' ||
      error.$metadata?.httpStatusCode === 404)
  );
}

/** Keeps the header value parseable: no quotes, backslashes or control chars. */
function sanitizeFileName(fileName: string): string {
  return fileName.replace(/["\\\r\n]/g, '_');
}

@Injectable()
export class StorageService implements OnModuleInit {
  /** Server-side calls (API and worker) — internal Compose endpoint. */
  private readonly client: S3Client;
  /** Used only to presign URLs consumed outside the process (phase-03-videos/TD-03). */
  private readonly presignClient: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    this.client = this.buildClient(config.endpoint);
    this.presignClient = this.buildClient(config.publicEndpoint);
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  /** Default lifetime of presigned URLs (`S3_PRESIGN_EXPIRES_SECONDS`). */
  get presignExpiresSeconds(): number {
    return this.config.presignExpiresSeconds;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      // API and worker boot concurrently — the other process may win the race.
      const name = s3ErrorName(error);
      if (!name || !BUCKET_ALREADY_EXISTS_ERRORS.has(name)) throw error;
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const output = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!output.UploadId) {
      throw new Error(`Storage returned no UploadId for ${key}`);
    }
    return output.UploadId;
  }

  async presignUploadParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
    expiresIn: number = this.config.presignExpiresSeconds,
  ): Promise<PresignedPart[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(
          this.presignClient,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn },
        ),
      })),
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;

    for (;;) {
      let output: ListPartsCommandOutput;
      try {
        output = await this.client.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
      } catch (error) {
        if (s3ErrorName(error) === 'NoSuchUpload') {
          throw new StorageUploadNotFoundError(uploadId);
        }
        throw error;
      }

      for (const part of output.Parts ?? []) {
        if (part.PartNumber && part.ETag) {
          parts.push({
            partNumber: part.PartNumber,
            etag: part.ETag,
            sizeBytes: part.Size ?? 0,
          });
        }
      }

      if (!output.IsTruncated) return parts;
      marker = output.NextPartNumberMarker;
    }
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPartInput[],
  ): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: sorted.map((p) => ({
              PartNumber: p.partNumber,
              ETag: p.etag,
            })),
          },
        }),
      );
    } catch (error) {
      const name = s3ErrorName(error);
      if (name === 'NoSuchUpload') {
        throw new StorageUploadNotFoundError(uploadId);
      }
      if (name && INVALID_PART_ERRORS.has(name)) {
        throw new StorageInvalidPartError(name);
      }
      throw error;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if (s3ErrorName(error) === 'NoSuchUpload') {
        throw new StorageUploadNotFoundError(uploadId);
      }
      throw error;
    }
  }

  /** Returns `null` when the object does not exist (absence is a valid result). */
  async headObject(key: string): Promise<StoredObjectInfo | null> {
    try {
      const output = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        contentLength: output.ContentLength ?? 0,
        contentType: output.ContentType,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    const output = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!(output.Body instanceof Readable)) {
      throw new Error(`Storage returned no readable body for ${key}`);
    }
    await pipeline(output.Body, createWriteStream(filePath));
  }

  async putObject(
    key: string,
    body: Buffer | Readable,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async presignGetObject(
    key: string,
    options: { downloadFileName?: string; expiresIn?: number } = {},
  ): Promise<SignedUrl> {
    const expiresIn = options.expiresIn ?? this.config.presignExpiresSeconds;
    const url = await getSignedUrl(
      this.presignClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options.downloadFileName !== undefined && {
          ResponseContentDisposition: `attachment; filename="${sanitizeFileName(options.downloadFileName)}"`,
        }),
      }),
      { expiresIn },
    );
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  private buildClient(endpoint: string): S3Client {
    return new S3Client({
      endpoint,
      region: this.config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKey,
        secretAccessKey: this.config.secretKey,
      },
      // The SDK default (WHEN_SUPPORTED) adds CRC32 checksums to PutObject /
      // UploadPart — a presigned part URL would then demand a checksum the
      // uploading client cannot know. Only send/validate checksums when the
      // S3 operation requires them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
}
