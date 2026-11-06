import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ArtifactStorageService } from './artifact-storage.service';
import { LocalImageArtifactsService } from './local-image-artifacts.service';

@Module({ imports: [ConfigModule], providers: [ArtifactStorageService, LocalImageArtifactsService], exports: [ArtifactStorageService, LocalImageArtifactsService] })
export class ArtifactsModule {}
