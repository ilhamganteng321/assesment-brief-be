#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/3e59e30f6c4a1f0af569482c391acf861c88c70a0f5cf1940d06c526b0a18938/contract';
import startContract from '../../snapshots/3e59e30f6c4a1f0af569482c391acf861c88c70a0f5cf1940d06c526b0a18938/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/98e365b2d8881d7a3e556fd665f484e6d6521ce7aff6427a0479d7bbcb065d52/contract';
import endContract from '../../snapshots/98e365b2d8881d7a3e556fd665f484e6d6521ce7aff6427a0479d7bbcb065d52/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'attachments',
        columns: [
          col('created_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('deleted_at', 'timestamp', { codecRef: { codecId: 'pg/timestamp-temporal@1' } }),
          col('file_name', 'character varying(255)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 255 } },
          }),
          col('file_size', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('mime_type', 'character varying(100)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('storage_key', 'character varying(255)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 255 } },
          }),
          col('task_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('uploaded_by_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'], { name: 'attachments_pkey' })],
      }),
      this.addUnique({
        schema: 'public',
        table: 'attachments',
        constraint: 'attachments_storage_key_unique',
        columns: ['storage_key'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attachments',
        index: 'attachments_deleted_at_idx',
        columns: ['deleted_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attachments',
        index: 'attachments_task_id_idx',
        columns: ['task_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'attachments',
        index: 'attachments_uploaded_by_id_idx',
        columns: ['uploaded_by_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'attachments',
        foreignKey: {
          name: 'attachments_task_id_fkey',
          columns: ['task_id'],
          references: { schema: 'public', table: 'tasks', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'attachments',
        foreignKey: {
          name: 'attachments_uploaded_by_id_fkey',
          columns: ['uploaded_by_id'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'restrict',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
