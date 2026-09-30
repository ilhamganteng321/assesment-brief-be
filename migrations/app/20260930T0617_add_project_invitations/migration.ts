#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/12344505d11c7c5fb15a0040feb9e63338460f7106b7a66030686a4c87a07ef7/contract';
import endContract from '../../snapshots/12344505d11c7c5fb15a0040feb9e63338460f7106b7a66030686a4c87a07ef7/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/75a23ec625ae12a6ed87f599bf50b51cbc59e1b6622b3ae87ffe440cef05ef48/contract';
import startContract from '../../snapshots/75a23ec625ae12a6ed87f599bf50b51cbc59e1b6622b3ae87ffe440cef05ef48/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'invitation_status',
        members: ['PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELED'],
      }),
      this.createTable({
        schema: 'public',
        table: 'project_invitations',
        columns: [
          col('accepted_at', 'timestamp', { codecRef: { codecId: 'pg/timestamp-temporal@1' } }),
          col('created_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('email', 'character varying(255)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 255 } },
          }),
          col('expires_at', 'timestamp', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('invited_by_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('project_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', '"invitation_status"', {
            notNull: true,
            default: lit('PENDING'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'invitation_status' } },
          }),
          col('token_hash', 'character varying(64)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 64 } },
          }),
          col('updated_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['id'], { name: 'project_invitations_pkey' })],
      }),
      this.createIndex({
        schema: 'public',
        table: 'project_invitations',
        index: 'project_invitations_expires_at_idx',
        columns: ['expires_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'project_invitations',
        index: 'project_invitations_invited_by_id_idx',
        columns: ['invited_by_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'project_invitations',
        index: 'project_invitations_project_id_email_idx',
        columns: ['project_id', 'email'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'project_invitations',
        index: 'project_invitations_project_id_idx',
        columns: ['project_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'project_invitations',
        index: 'project_invitations_project_id_status_idx',
        columns: ['project_id', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'project_invitations',
        index: 'project_invitations_token_hash_idx',
        columns: ['token_hash'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'project_invitations',
        foreignKey: {
          name: 'project_invitations_project_id_fkey',
          columns: ['project_id'],
          references: { schema: 'public', table: 'projects', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'project_invitations',
        foreignKey: {
          name: 'project_invitations_invited_by_id_fkey',
          columns: ['invited_by_id'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'restrict',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
