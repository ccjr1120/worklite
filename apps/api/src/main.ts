import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const port = Number(process.env.API_PORT ?? 4546);
  const host = process.env.API_HOST?.trim() || '127.0.0.1';
  process.env.WORKLITE_API_URL = `http://127.0.0.1:${port}/api`;
  process.env.WORKLITE_WORKSPACE_SLUG = 'personal';
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');

  await app.listen(port, host);
  Logger.log(`WorkLite API listening on http://${host}:${port}`, 'Bootstrap');
}

void bootstrap();
