#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/0c0734babd6eeb868fee1f281ca96963022475611560e9f170f465daa35f8599/contract';
import startContract from '../../snapshots/0c0734babd6eeb868fee1f281ca96963022475611560e9f170f465daa35f8599/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/3e59e30f6c4a1f0af569482c391acf861c88c70a0f5cf1940d06c526b0a18938/contract';
import endContract from '../../snapshots/3e59e30f6c4a1f0af569482c391acf861c88c70a0f5cf1940d06c526b0a18938/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'department',
        members: ['PRODUCT', 'UI_UX', 'FRONTEND', 'BACKEND', 'CLIENT'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'project_status',
        members: ['ACTIVE', 'COMPLETED', 'ARCHIVED'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'role',
        members: ['PM', 'INTERNAL', 'CLIENT'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'task_status',
        members: ['TODO', 'BLOCKED', 'IN_PROGRESS', 'DONE'],
      }),
      this.createTable({
        schema: 'public',
        table: 'audit_logs',
        columns: [
          col('changed_column', 'character varying(100)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('created_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('new_value', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('old_value', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('task_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('user_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'], { name: 'audit_logs_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'project_members',
        columns: [
          col('created_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('project_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('user_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'], { name: 'project_members_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'projects',
        columns: [
          col('client_name', 'character varying(150)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 150 } },
          }),
          col('created_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('deleted_at', 'timestamp', { codecRef: { codecId: 'pg/timestamp-temporal@1' } }),
          col('description', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('name', 'character varying(150)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 150 } },
          }),
          col('status', '"project_status"', {
            notNull: true,
            default: lit('ACTIVE'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'project_status' } },
          }),
          col('updated_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['id'], { name: 'projects_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'task_dependencies',
        columns: [
          col('created_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('dependency_task_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('dependent_task_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
        ],
        constraints: [primaryKey(['id'], { name: 'task_dependencies_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'tasks',
        columns: [
          col('assigned_to_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('client_visible', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('created_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('deleted_at', 'timestamp', { codecRef: { codecId: 'pg/timestamp-temporal@1' } }),
          col('description', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('project_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', '"task_status"', {
            notNull: true,
            default: lit('TODO'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'task_status' } },
          }),
          col('title', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('updated_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('version', 'int4', {
            notNull: true,
            default: lit(1),
            codecRef: { codecId: 'pg/int4@1' },
          }),
        ],
        constraints: [primaryKey(['id'], { name: 'tasks_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'users',
        columns: [
          col('created_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('department', '"department"', {
            notNull: true,
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'department' } },
          }),
          col('email', 'character varying(255)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 255 } },
          }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('name', 'character varying(100)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('password_hash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('role', '"role"', {
            notNull: true,
            default: lit('INTERNAL'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'role' } },
          }),
          col('updated_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['id'], { name: 'users_pkey' })],
      }),
      this.addUnique({
        schema: 'public',
        table: 'project_members',
        constraint: 'project_members_project_id_user_id_unique',
        columns: ['project_id', 'user_id'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'task_dependencies',
        constraint: 'task_dependencies_unique',
        columns: ['dependent_task_id', 'dependency_task_id'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'users',
        constraint: 'users_email_unique',
        columns: ['email'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'audit_logs',
        index: 'audit_logs_created_at_idx',
        columns: ['created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'audit_logs',
        index: 'audit_logs_task_id_idx',
        columns: ['task_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'audit_logs',
        index: 'audit_logs_user_id_idx',
        columns: ['user_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'project_members',
        index: 'project_members_user_id_idx',
        columns: ['user_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'projects',
        index: 'projects_deleted_at_idx',
        columns: ['deleted_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'projects',
        index: 'projects_status_idx',
        columns: ['status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_dependencies',
        index: 'task_dependencies_dependency_task_id_idx',
        columns: ['dependency_task_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_dependencies',
        index: 'task_dependencies_dependent_task_id_idx',
        columns: ['dependent_task_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'tasks',
        index: 'tasks_assigned_to_id_idx',
        columns: ['assigned_to_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'tasks',
        index: 'tasks_client_visible_idx',
        columns: ['client_visible'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'tasks',
        index: 'tasks_deleted_at_idx',
        columns: ['deleted_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'tasks',
        index: 'tasks_project_id_idx',
        columns: ['project_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'tasks',
        index: 'tasks_status_idx',
        columns: ['status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'users',
        index: 'users_department_idx',
        columns: ['department'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'users',
        index: 'users_role_idx',
        columns: ['role'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'audit_logs',
        foreignKey: {
          name: 'audit_logs_task_id_fkey',
          columns: ['task_id'],
          references: { schema: 'public', table: 'tasks', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'audit_logs',
        foreignKey: {
          name: 'audit_logs_user_id_fkey',
          columns: ['user_id'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'project_members',
        foreignKey: {
          name: 'project_members_project_id_fkey',
          columns: ['project_id'],
          references: { schema: 'public', table: 'projects', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'project_members',
        foreignKey: {
          name: 'project_members_user_id_fkey',
          columns: ['user_id'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'task_dependencies',
        foreignKey: {
          name: 'task_dependencies_dependent_task_id_fkey',
          columns: ['dependent_task_id'],
          references: { schema: 'public', table: 'tasks', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'task_dependencies',
        foreignKey: {
          name: 'task_dependencies_dependency_task_id_fkey',
          columns: ['dependency_task_id'],
          references: { schema: 'public', table: 'tasks', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'tasks',
        foreignKey: {
          name: 'tasks_project_id_fkey',
          columns: ['project_id'],
          references: { schema: 'public', table: 'projects', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'tasks',
        foreignKey: {
          name: 'tasks_assigned_to_id_fkey',
          columns: ['assigned_to_id'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
