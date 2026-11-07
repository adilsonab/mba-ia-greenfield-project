import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  // Internal endpoint — used by the API and the worker for server-side calls
  // (Compose service name, never localhost).
  endpoint: process.env.S3_ENDPOINT || 'http://storage:9000',
  // Public endpoint — used ONLY to presign URLs consumed outside the API
  // process (browser and in-container e2e tests). SigV4 signs the Host header.
  publicEndpoint:
    process.env.S3_PUBLIC_ENDPOINT || 'http://storage.localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY!,
  secretKey: process.env.S3_SECRET_KEY!,
  bucket: process.env.S3_BUCKET || 'streamtube',
  presignExpiresSeconds: parseInt(
    process.env.S3_PRESIGN_EXPIRES_SECONDS || '3600',
    10,
  ),
}));
