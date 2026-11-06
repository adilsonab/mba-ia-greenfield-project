import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret-key',
};

const validate = (env: Record<string, string | undefined>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    // Joi types `value` as `any` on the error branch of ValidationResult.
    const value = result.value as Record<string, string>;
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and video policies', () => {
  it('should reject a missing S3_ACCESS_KEY', () => {
    const { error } = validate({ S3_ACCESS_KEY: undefined });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ACCESS_KEY');
  });

  it('should reject a missing S3_SECRET_KEY', () => {
    const { error } = validate({ S3_SECRET_KEY: undefined });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_SECRET_KEY');
  });

  it('should reject VIDEO_UPLOAD_PART_SIZE_BYTES below the 5 MiB S3 minimum', () => {
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_BYTES: '5242879' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });

  it('should accept VIDEO_UPLOAD_PART_SIZE_BYTES at exactly 5 MiB', () => {
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_BYTES: '5242880' });
    expect(error).toBeUndefined();
  });

  it('should apply the documented defaults when the optional keys are not set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    const value = result.value as Record<string, unknown>;
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://storage:9000',
      S3_PUBLIC_ENDPOINT: 'http://storage.localhost:9000',
      S3_BUCKET: 'streamtube',
      S3_PRESIGN_EXPIRES_SECONDS: 3600,
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      VIDEO_MAX_SIZE_BYTES: 10737418240,
      VIDEO_UPLOAD_PART_SIZE_BYTES: 67108864,
      VIDEO_PROCESSING_ATTEMPTS: 3,
      VIDEO_PROCESSING_BACKOFF_MS: 10000,
    });
  });
});
