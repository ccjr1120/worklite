import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDb, initializeDatabase, type Database } from '@worklite/db';

export const DATABASE = Symbol('DATABASE');

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ConfigService],
      useFactory: async (config: ConfigService): Promise<Database> => {
        const db = createDb(config.get<string>('SQLITE_PATH') ?? '../../.data/deployment/worklite.db');
        await initializeDatabase(db);
        return db;
      },
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
