import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ArtifactStorageService } from './artifact-storage.service';

@Module({ imports: [ConfigModule], providers: [ArtifactStorageService], exports: [ArtifactStorageService] })
export class ArtifactsModule {}
