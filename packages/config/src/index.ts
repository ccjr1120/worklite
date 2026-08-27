export const APP_NAME = 'WorkLite';

export const envKeys = {
  sqlitePath: 'SQLITE_PATH',
  apiPort: 'API_PORT',
  s3Endpoint: 'S3_ENDPOINT',
  s3Region: 'S3_REGION',
  s3AccessKey: 'S3_ACCESS_KEY',
  s3SecretKey: 'S3_SECRET_KEY',
  s3Bucket: 'S3_BUCKET',
  sessionSecret: 'SESSION_SECRET',
  secretEncryptionKey: 'SECRET_ENCRYPTION_KEY',
} as const;
