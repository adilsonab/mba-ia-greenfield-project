import { randomBytes, randomUUID } from 'crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import {
  adminS3Client,
  destroyBucket,
  testStorageConfig,
} from '../test/storage-test-bucket';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService presigned reads (integration — real MinIO)', () => {
  let module: TestingModule;
  let storage: StorageService;
  let admin: S3Client;
  const config = testStorageConfig();
  const key = `test/${randomUUID()}/original`;
  const bytes = randomBytes(2048);

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
    await module.init();
    storage = module.get(StorageService);
    await storage.putObject(key, bytes, 'video/mp4');
  });

  afterAll(async () => {
    await destroyBucket(admin, config.bucket);
    await module.close();
  });

  it('should serve a Range request on the stream URL with 206 Partial Content', async () => {
    const { url, expiresAt } = await storage.presignGetObject(key);

    const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-1023/2048');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(1024);
    expect(body.equals(bytes.subarray(0, 1024))).toBe(true);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('should sign the stream URL against the public endpoint host', async () => {
    const { url } = await storage.presignGetObject(key);

    expect(new URL(url).host).toBe(new URL(config.publicEndpoint).host);
  });

  it('should return the original file as an attachment on the download URL', async () => {
    const { url } = await storage.presignGetObject(key, {
      downloadFileName: 'aula.mp4',
    });

    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="aula.mp4"',
    );
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('should honor a custom expiry', async () => {
    const before = Date.now();
    const { url, expiresAt } = await storage.presignGetObject(key, {
      expiresIn: 120,
    });

    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('120');
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(119_000);
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(121_000);
  });
});
