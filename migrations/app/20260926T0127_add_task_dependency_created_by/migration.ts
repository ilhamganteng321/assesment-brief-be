#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/272396bd2b34531ae157d714f1aaace2c0d9d6a7ff4620d24bd76e9e7bbf3b07/contract';
import startContract from '../../snapshots/272396bd2b34531ae157d714f1aaace2c0d9d6a7ff4620d24bd76e9e7bbf3b07/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/75a23ec625ae12a6ed87f599bf50b51cbc59e1b6622b3ae87ffe440cef05ef48/contract';
import endContract from '../../snapshots/75a23ec625ae12a6ed87f599bf50b51cbc59e1b6622b3ae87ffe440cef05ef48/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'task_dependencies',
        column: col('created_by', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_dependencies',
        index: 'task_dependencies_created_by_idx',
        columns: ['created_by'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'task_dependencies',
        foreignKey: {
          name: 'task_dependencies_created_by_fkey',
          columns: ['created_by'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
