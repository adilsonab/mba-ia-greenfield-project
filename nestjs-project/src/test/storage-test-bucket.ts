import { randomBytes } from 'crypto';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';

/**
 * Storage config pointing at a fresh, uniquely named bucket so storage
 * integration tests never touch the development bucket.
 */
export function testStorageConfig(): ReturnType<typeof storageConfig> {
  return {
    ...storageConfig(),
    bucket: `test-${randomBytes(6).toString('hex')}`,
  };
}

/** Raw admin client for assertions and cleanup outside the service under test. */
export function adminS3Client(): S3Client {
  const config = storageConfig();
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export async function bucketExists(
  client: S3Client,
  bucket: string,
): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
}

/** Aborts pending uploads, deletes every object and removes the bucket. */
export async function destroyBucket(
  client: S3Client,
  bucket: string,
): Promise<void> {
  if (!(await bucketExists(client, bucket))) return;

  const uploads = await client.send(
    new ListMultipartUploadsCommand({ Bucket: bucket }),
  );
  for (const upload of uploads.Uploads ?? []) {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: upload.Key,
        UploadId: upload.UploadId,
      }),
    );
  }

  const objects = await client.send(
    new ListObjectsV2Command({ Bucket: bucket }),
  );
  const keys = (objects.Contents ?? []).map((o) => ({ Key: o.Key }));
  if (keys.length > 0) {
    await client.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }),
    );
  }

  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}
