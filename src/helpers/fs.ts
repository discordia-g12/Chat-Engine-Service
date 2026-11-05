import type fsType from 'node:fs';

const fs: typeof fsType =
  (process.getBuiltinModule ? process.getBuiltinModule('node:fs') : undefined) ??
  eval('require')('node:fs');

export const fileSystem = fs;

