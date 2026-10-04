import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { runtimeAdmissionClosed, runtimeWritesFrozen } from './infrastructure/runtime-upgrade-state';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const port = Number(process.env.API_PORT ?? 3391);
  const host = process.env.API_HOST?.trim() || '127.0.0.1';
  process.env.WORKLITE_API_URL = `http://127.0.0.1:${port}/api`;
  process.env.WORKLITE_WORKSPACE_SLUG = 'personal';
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useBodyParser('json', { limit: Infinity });
  app.useBodyParser('urlencoded', { extended: true, limit: Infinity });
  app.enableShutdownHooks();
  app.use((request: Request, response: Response, next: NextFunction) => {
    const runner = /^\/api\/upgrades\/upgrade_[a-f0-9-]+\/(handoff|freeze|resume)$/.test(request.path);
    if (runtimeWritesFrozen() && !runner && request.path !== '/api/health' && request.path !== '/api/upgrades/runtime') {
      response.status(503).json({ message: 'WorkLite is switching runtime versions.' }); return;
    }
    if (runtimeAdmissionClosed() && request.method === 'POST' && /\/(resume|retry|messages)$|^\/api\/commands$/.test(request.path) && !runner) {
      response.status(503).json({ message: 'WorkLite is handing off tasks for an upgrade.' }); return;
    }
    next();
  });
  app.setGlobalPrefix('api');

  await app.listen(port, host);
  Logger.log(`WorkLite API listening on http://${host}:${port}`, 'Bootstrap');
}

void bootstrap();
