#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/272396bd2b34531ae157d714f1aaace2c0d9d6a7ff4620d24bd76e9e7bbf3b07/contract';
import endContract from '../../snapshots/272396bd2b34531ae157d714f1aaace2c0d9d6a7ff4620d24bd76e9e7bbf3b07/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/e9255c24e4677ed9e40bcf742ecf38ef151ee20f0fc7c6b371d0beef8be541a8/contract';
import startContract from '../../snapshots/e9255c24e4677ed9e40bcf742ecf38ef151ee20f0fc7c6b371d0beef8be541a8/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'task_priority',
        members: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
      }),
      this.addColumn({
        schema: 'public',
        table: 'tasks',
        column: col('department', '"department"', {
          notNull: true,
          default: lit('PRODUCT'),
          codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'department' } },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'tasks',
        column: col('priority', '"task_priority"', {
          notNull: true,
          default: lit('MEDIUM'),
          codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'task_priority' } },
        }),
      }),
      this.createIndex({
        schema: 'public',
        table: 'tasks',
        index: 'tasks_department_idx',
        columns: ['department'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'tasks',
        index: 'tasks_priority_idx',
        columns: ['priority'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
