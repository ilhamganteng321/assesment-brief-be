#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/0c0734babd6eeb868fee1f281ca96963022475611560e9f170f465daa35f8599/contract';
import endContract from '../../snapshots/0c0734babd6eeb868fee1f281ca96963022475611560e9f170f465daa35f8599/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/fbd2995f4d9662d65e2c4f1a5657aff1786aeb0a3ed76cd28e83e19039e0bb7a/contract';
import startContract from '../../snapshots/fbd2995f4d9662d65e2c4f1a5657aff1786aeb0a3ed76cd28e83e19039e0bb7a/contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [];
  }
}

MigrationCLI.run(import.meta.url, M);
