#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/98e365b2d8881d7a3e556fd665f484e6d6521ce7aff6427a0479d7bbcb065d52/contract';
import startContract from '../../snapshots/98e365b2d8881d7a3e556fd665f484e6d6521ce7aff6427a0479d7bbcb065d52/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/e9255c24e4677ed9e40bcf742ecf38ef151ee20f0fc7c6b371d0beef8be541a8/contract';
import endContract from '../../snapshots/e9255c24e4677ed9e40bcf742ecf38ef151ee20f0fc7c6b371d0beef8be541a8/contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addNativeEnumValue({ schema: 'public', typeName: 'project_status', value: 'PLANNING' }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
