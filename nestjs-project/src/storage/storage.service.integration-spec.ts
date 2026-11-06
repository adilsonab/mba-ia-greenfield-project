import { randomBytes, randomUUID } from 'crypto';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import {
  adminS3Client,
  bucketExists,
  destroyBucket,
  testStorageConfig,
} from '../test/storage-test-bucket';
import {
  StorageInvalidPartError,
  StorageUploadNotFoundError,
} from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIB = 1024 * 1024;

/** Uploads one part through its presigned URL — from inside the container. */
async function putPart(url: string, body: Buffer): Promise<Response> {
  return fetch(url, { method: 'PUT', body: new Uint8Array(body) });
}

describe('StorageService (integration — real MinIO)', () => {
  let module: TestingModule;
  let storage: StorageService;
  let admin: S3Client;
  const config = testStorageConfig();

  beforeAll(async () => {
    admin = adminS3Client();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(config)
      .compile();
    await module.init(); // runs onModuleInit → ensureBucket
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await destroyBucket(admin, config.bucket);
    await module.close();
  });

  it('should create the configured bucket when the module initializes', async () => {
    expect(await bucketExists(admin, config.bucket)).toBe(true);
  });

  it('should keep working when the bucket already exists', async () => {
    await expect(storage.ensureBucket()).resolves.toBeUndefined();
  });

  it('should sign part URLs against the public endpoint host', async () => {
    const key = `test/${randomUUID()}/original`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const [part] = await storage.presignUploadParts(key, uploadId, [1]);

    expect(new URL(part.url).host).toBe(new URL(config.publicEndpoint).host);
    expect(part.partNumber).toBe(1);
  });

  it('should complete a 2-part upload sent through presigned URLs from inside the container', async () => {
    const key = `test/${randomUUID()}/original`;
    const part1 = randomBytes(5 * MIB);
    const part2 = randomBytes(1 * MIB);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const [url1, url2] = await storage.presignUploadParts(
      key,
      uploadId,
      [1, 2],
    );

    const res1 = await putPart(url1.url, part1);
    const res2 = await putPart(url2.url, part2);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const etag1 = res1.headers.get('etag');
    const etag2 = res2.headers.get('etag');
    expect(etag1).toBeTruthy();
    expect(etag2).toBeTruthy();

    const listed = await storage.listParts(key, uploadId);
    expect(listed.map((p) => [p.partNumber, p.sizeBytes])).toEqual([
      [1, 5 * MIB],
      [2, 1 * MIB],
    ]);

    // Parts deliberately passed out of order — the service sorts them.
    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 2, etag: etag2! },
      { partNumber: 1, etag: etag1! },
    ]);

    const head = await storage.headObject(key);
    expect(head?.contentLength).toBe(6 * MIB);
    expect(head?.contentType).toBe('video/mp4');
  });

  it('should raise StorageUploadNotFoundError when listing parts of an unknown upload', async () => {
    await expect(
      storage.listParts(`test/${randomUUID()}/original`, 'does-not-exist'),
    ).rejects.toBeInstanceOf(StorageUploadNotFoundError);
  });

  it('should raise StorageUploadNotFoundError after the multipart upload is aborted', async () => {
    const key = `test/${randomUUID()}/original`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    await storage.abortMultipartUpload(key, uploadId);

    await expect(storage.listParts(key, uploadId)).rejects.toBeInstanceOf(
      StorageUploadNotFoundError,
    );
  });

  it('should raise StorageInvalidPartError when completing with a wrong ETag', async () => {
    const key = `test/${randomUUID()}/original`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const [part] = await storage.presignUploadParts(key, uploadId, [1]);
    const res = await putPart(part.url, randomBytes(1 * MIB));
    expect(res.status).toBe(200);

    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"00000000000000000000000000000000"' },
      ]),
    ).rejects.toBeInstanceOf(StorageInvalidPartError);
  });

  it('should return null from headObject for a missing key and after deleteObject', async () => {
    const key = `test/${randomUUID()}/thumbnail.jpg`;
    expect(await storage.headObject(key)).toBeNull();

    await storage.putObject(key, Buffer.from('jpeg-bytes'), 'image/jpeg');
    expect(await storage.headObject(key)).toEqual({
      contentLength: 10,
      contentType: 'image/jpeg',
    });

    await storage.deleteObject(key);
    expect(await storage.headObject(key)).toBeNull();
  });

  it('should download an object to a local file byte-for-byte', async () => {
    const key = `test/${randomUUID()}/original`;
    const bytes = randomBytes(256 * 1024);
    await storage.putObject(key, bytes, 'video/mp4');
    const dir = await mkdtemp(join(tmpdir(), 'storage-it-'));

    try {
      const filePath = join(dir, 'original');
      await storage.downloadToFile(key, filePath);
      expect((await readFile(filePath)).equals(bytes)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
