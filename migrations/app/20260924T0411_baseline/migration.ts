#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/fbd2995f4d9662d65e2c4f1a5657aff1786aeb0a3ed76cd28e83e19039e0bb7a/contract';
import endContract from '../../snapshots/fbd2995f4d9662d65e2c4f1a5657aff1786aeb0a3ed76cd28e83e19039e0bb7a/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'public' }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'booking_status',
        members: ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'EXPIRED'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'payment_method',
        members: ['QRIS', 'BANK_TRANSFER', 'E_WALLET', 'CREDIT_CARD', 'VA', 'CASH'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'payment_provider',
        members: ['MIDTRANS', 'XENDIT', 'MANUAL'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'payment_status',
        members: ['UNPAID', 'PAID', 'FAILED', 'REFUNDED', 'EXPIRED'],
      }),
      this.createNativeEnumType({ schema: 'public', typeName: 'role', members: ['ADMIN', 'USER'] }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'transaction_status',
        members: ['PENDING', 'SETTLEMENT', 'EXPIRE', 'CANCEL', 'DENY'],
      }),
      this.createTable({
        schema: 'public',
        table: 'booking_time_slots',
        columns: [
          col('booking_date', 'date', {
            notNull: true,
            codecRef: { codecId: 'pg/date-temporal@1' },
          }),
          col('booking_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('end_time', 'time', { notNull: true, codecRef: { codecId: 'pg/time-temporal@1' } }),
          col('field_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('price', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('start_time', 'time', { notNull: true, codecRef: { codecId: 'pg/time-temporal@1' } }),
        ],
        constraints: [primaryKey(['id'], { name: 'booking_time_slots_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'bookings',
        columns: [
          col('booking_date', 'date', {
            notNull: true,
            codecRef: { codecId: 'pg/date-temporal@1' },
          }),
          col('created_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('duration_hours', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('field_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('notes', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('payment_status', '"payment_status"', {
            notNull: true,
            default: lit('UNPAID'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'payment_status' } },
          }),
          col('status', '"booking_status"', {
            notNull: true,
            default: lit('PENDING'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'booking_status' } },
          }),
          col('total_price', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('updated_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('user_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'], { name: 'bookings_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'field_images',
        columns: [
          col('created_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('field_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('image_url', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'], { name: 'field_images_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'field_operating_hours',
        columns: [
          col('close_time', 'time', { notNull: true, codecRef: { codecId: 'pg/time-temporal@1' } }),
          col('day_of_week', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('field_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('open_time', 'time', { notNull: true, codecRef: { codecId: 'pg/time-temporal@1' } }),
        ],
        constraints: [primaryKey(['id'], { name: 'field_operating_hours_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'fields',
        columns: [
          col('capacity', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('created_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('description', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('image_url', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('is_active', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('location', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'character varying(100)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('price_per_hour', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('slug', 'character varying(120)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 120 } },
          }),
          col('type', 'character varying(50)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 50 } },
          }),
          col('updated_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['id'], { name: 'fields_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'transactions',
        columns: [
          col('booking_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
          col('expired_at', 'timestamp', { codecRef: { codecId: 'pg/timestamp-temporal@1' } }),
          col('gross_amount', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('order_id', 'character varying(255)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 255 } },
          }),
          col('paid_at', 'timestamp', { codecRef: { codecId: 'pg/timestamp-temporal@1' } }),
          col('payment_method', '"payment_method"', {
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'payment_method' } },
          }),
          col('payment_url', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('provider', '"payment_provider"', {
            notNull: true,
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'payment_provider' } },
          }),
          col('snap_token', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('transaction_status', '"transaction_status"', {
            notNull: true,
            default: lit('PENDING'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'transaction_status' } },
          }),
          col('updated_at', 'timestamp', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['id'], { name: 'transactions_pkey' })],
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
          col('password', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('phone', 'character varying(20)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 20 } },
          }),
          col('role', '"role"', {
            notNull: true,
            default: lit('USER'),
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
        table: 'booking_time_slots',
        constraint: 'booking_time_slots_field_id_booking_date_start_time_end_time_un',
        columns: ['field_id', 'booking_date', 'start_time', 'end_time'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'fields',
        constraint: 'fields_slug_unique',
        columns: ['slug'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'transactions',
        constraint: 'transactions_order_id_unique',
        columns: ['order_id'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'users',
        constraint: 'users_email_unique',
        columns: ['email'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'booking_time_slots',
        foreignKey: {
          name: 'booking_time_slots_booking_id_bookings_id_fk',
          columns: ['booking_id'],
          references: { schema: 'public', table: 'bookings', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'booking_time_slots',
        foreignKey: {
          name: 'booking_time_slots_field_id_fields_id_fk',
          columns: ['field_id'],
          references: { schema: 'public', table: 'fields', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'bookings',
        foreignKey: {
          name: 'bookings_field_id_fields_id_fk',
          columns: ['field_id'],
          references: { schema: 'public', table: 'fields', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'bookings',
        foreignKey: {
          name: 'bookings_user_id_users_id_fk',
          columns: ['user_id'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'field_images',
        foreignKey: {
          name: 'field_images_field_id_fields_id_fk',
          columns: ['field_id'],
          references: { schema: 'public', table: 'fields', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'field_operating_hours',
        foreignKey: {
          name: 'field_operating_hours_field_id_fields_id_fk',
          columns: ['field_id'],
          references: { schema: 'public', table: 'fields', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'transactions',
        foreignKey: {
          name: 'transactions_booking_id_bookings_id_fk',
          columns: ['booking_id'],
          references: { schema: 'public', table: 'bookings', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
