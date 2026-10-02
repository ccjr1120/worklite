import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

export function createSqliteCheckpointer(filePath: string): SqliteSaver {
  mkdirSync(dirname(filePath), { recursive: true });
  return SqliteSaver.fromConnString(filePath);
}
