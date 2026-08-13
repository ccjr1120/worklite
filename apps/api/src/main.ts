import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  Logger.log(`WorkLite API listening on port ${port}`, 'Bootstrap');
}

void bootstrap();
