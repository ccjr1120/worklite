import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ArtifactStorageService } from './artifact-storage.service';
import { LocalFileArtifactsService } from './local-file-artifacts.service';
import { LocalImageArtifactsService } from './local-image-artifacts.service';

@Module({ imports: [ConfigModule], providers: [ArtifactStorageService, LocalImageArtifactsService, LocalFileArtifactsService], exports: [ArtifactStorageService, LocalImageArtifactsService, LocalFileArtifactsService] })
export class ArtifactsModule {}
