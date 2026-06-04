// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

import packageJson from '../package.json' with { type: 'json' };

const require = createRequire(import.meta.url);

const rootDir = join(import.meta.dirname, '..');
const distDir = join(rootDir, 'dist');
const platform = process.platform;
const arch = process.arch;
const packageName = `signalctl-${packageJson.version}-${platform}-${arch}`;
const packageDir = join(distDir, packageName);
const archivePath = join(distDir, `${packageName}.tar.gz`);

const externalRuntimePackages = [
  '@signalapp/libsignal-client',
  '@signalapp/ringrtc',
  '@signalapp/sqlcipher',
  'google-libphonenumber',
];

const requiredBundlePaths = ['bundles/cli.js', 'bundles/chunks'];

function toPosixPath(path) {
  return path.split(sep).join('/');
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function assertExists(path, message) {
  if (!(await pathExists(path))) {
    throw new Error(message);
  }
}

function findPackageRoot(packageNameToResolve, fromPath = rootDir) {
  let current;
  try {
    current = dirname(
      require.resolve(packageNameToResolve, { paths: [fromPath] })
    );
  } catch (error) {
    const fromRequire = createRequire(join(fromPath, 'package.json'));
    const resolutionPaths =
      fromRequire.resolve.paths(packageNameToResolve) ?? [];
    const packageRoot = resolutionPaths
      .map(path => join(path, packageNameToResolve))
      .find(path => pathExistsSyncPackageJson(path));
    if (packageRoot) {
      return packageRoot;
    }
    throw error;
  }

  while (dirname(current) !== current) {
    if (pathExistsSyncPackageJson(current)) {
      return current;
    }
    current = dirname(current);
  }

  throw new Error(`Unable to find package root for ${packageNameToResolve}`);
}

function pathExistsSyncPackageJson(path) {
  try {
    require('node:fs').accessSync(join(path, 'package.json'));
    return true;
  } catch {
    return false;
  }
}

async function copyRequiredBundles() {
  for (const path of requiredBundlePaths) {
    const source = join(rootDir, path);
    const target = join(packageDir, path);
    await assertExists(
      source,
      `Missing ${path}; run "pnpm run build:rolldown:prod" first`
    );
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, dereference: true });
  }
  await chmod(join(packageDir, 'bundles', 'cli.js'), 0o755);
}

async function copyExternalRuntimePackage(
  packageNameToCopy,
  copied = new Set(),
  fromPath = rootDir
) {
  if (copied.has(packageNameToCopy)) {
    return;
  }
  copied.add(packageNameToCopy);

  const source = findPackageRoot(packageNameToCopy, fromPath);
  const parts = packageNameToCopy.split('/');
  const target = packageNameToCopy.startsWith('@')
    ? join(packageDir, 'node_modules', parts[0], parts[1])
    : join(packageDir, 'node_modules', packageNameToCopy);

  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    dereference: true,
    filter: sourcePath => !sourcePath.includes(`${sep}.git${sep}`),
  });

  const packageJsonPath = join(source, 'package.json');
  const packageJsonContents = JSON.parse(
    await readFile(packageJsonPath, 'utf8')
  );
  const dependencies = {
    ...packageJsonContents.dependencies,
    ...packageJsonContents.optionalDependencies,
  };

  for (const dependencyName of Object.keys(dependencies)) {
    await copyExternalRuntimePackage(dependencyName, copied, source);
  }
}

async function writeLaunchers() {
  const posixLauncher = `#!/usr/bin/env sh
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec node "$DIR/bundles/cli.js" "$@"
`;

  const cmdLauncher = `@echo off
setlocal
set "DIR=%~dp0.."
node "%DIR%\\bundles\\cli.js" %*
`;

  const powershellLauncher = `#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $PSScriptRoot
& node (Join-Path $Dir "bundles/cli.js") @args
exit $LASTEXITCODE
`;

  await mkdir(join(packageDir, 'bin'), { recursive: true });
  await writeFile(join(packageDir, 'bin', 'signalctl'), posixLauncher);
  await writeFile(join(packageDir, 'bin', 'signalctl.cmd'), cmdLauncher);
  await writeFile(join(packageDir, 'bin', 'signalctl.ps1'), powershellLauncher);
  await chmod(join(packageDir, 'bin', 'signalctl'), 0o755);
  await chmod(join(packageDir, 'bin', 'signalctl.ps1'), 0o755);
}

async function writePackageMetadata() {
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: 'signalctl',
        version: packageJson.version,
        description: 'Headless Signal Desktop-compatible CLI',
        license: packageJson.license,
        bin: {
          signalctl: 'bundles/cli.js',
        },
        engines: {
          node: packageJson.engines?.node ?? '>=20',
        },
        signalctl: {
          platform,
          arch,
          builtAt: new Date().toISOString(),
        },
      },
      null,
      2
    ) + '\n'
  );

  for (const fileName of ['LICENSE', 'README.md']) {
    const source = join(rootDir, fileName);
    if (await pathExists(source)) {
      await cp(source, join(packageDir, fileName));
    }
  }

  await writeFile(
    join(packageDir, 'USAGE.md'),
    `# signalctl

This package contains the Signal CLI bundle for ${platform}-${arch}.

## Requirements

- Node.js must be available on PATH.
- Native dependencies are platform-specific. Build this package on each target OS/architecture.

## Examples

\`\`\`sh
./bin/signalctl --data-dir ./profile link
./bin/signalctl --data-dir ./profile conversations list
./bin/signalctl --data-dir ./profile daemon
\`\`\`

On Windows, use \`bin\\\\signalctl.cmd\` or \`bin\\\\signalctl.ps1\`.
`
  );
}

function encodeTarString(value, length) {
  const buffer = Buffer.alloc(length);
  const bytes = Buffer.from(value);
  if (bytes.length > length) {
    throw new Error(`Tar path is too long: ${value}`);
  }
  bytes.copy(buffer);
  return buffer;
}

function encodeTarOctal(value, length) {
  const text = value.toString(8).padStart(length - 1, '0');
  return encodeTarString(text, length);
}

function splitTarPath(path) {
  const bytes = Buffer.from(path);
  if (bytes.length <= 100) {
    return { name: path, prefix: '' };
  }

  const parts = path.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join('/');
    const name = parts.slice(index).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }

  throw new Error(`Tar path is too long: ${path}`);
}

function createTarHeader({ path, size, mode, mtime, type }) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(path);

  encodeTarString(name, 100).copy(header, 0);
  encodeTarOctal(mode, 8).copy(header, 100);
  encodeTarOctal(0, 8).copy(header, 108);
  encodeTarOctal(0, 8).copy(header, 116);
  encodeTarOctal(size, 12).copy(header, 124);
  encodeTarOctal(Math.floor(mtime.getTime() / 1000), 12).copy(header, 136);
  Buffer.from('        ').copy(header, 148);
  encodeTarString(type, 1).copy(header, 156);
  encodeTarString('ustar', 6).copy(header, 257);
  encodeTarString('00', 2).copy(header, 263);
  encodeTarString(prefix, 155).copy(header, 345);

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  encodeTarOctal(checksum, 8).copy(header, 148);

  return header;
}

async function collectFiles(path, basePath, result = []) {
  const info = await lstat(path);
  const relativePath = toPosixPath(relative(basePath, path));

  if (info.isDirectory()) {
    if (relativePath) {
      result.push({ path, relativePath: `${relativePath}/`, info, type: '5' });
    }
    const entries = await readdir(path);
    entries.sort();
    for (const entry of entries) {
      await collectFiles(join(path, entry), basePath, result);
    }
    return result;
  }

  if (info.isFile()) {
    result.push({ path, relativePath, info, type: '0' });
  }

  return result;
}

async function createTarGz() {
  const entries = await collectFiles(packageDir, distDir);
  const chunks = [];

  for (const entry of entries) {
    chunks.push(
      createTarHeader({
        path: entry.relativePath,
        size: entry.type === '0' ? entry.info.size : 0,
        mode: entry.info.mode & 0o777,
        mtime: entry.info.mtime,
        type: entry.type,
      })
    );

    if (entry.type === '0') {
      const contents = await readFile(entry.path);
      chunks.push(contents);
      const padding = (512 - (contents.length % 512)) % 512;
      if (padding) {
        chunks.push(Buffer.alloc(padding));
      }
    }
  }

  chunks.push(Buffer.alloc(1024));
  await writeFile(archivePath, gzipSync(Buffer.concat(chunks), { level: 9 }));
}

async function smokeTestPackagedCli() {
  const executable =
    platform === 'win32'
      ? join(packageDir, 'bin', 'signalctl.cmd')
      : join(packageDir, 'bin', 'signalctl');
  await assertExists(executable, `Missing launcher ${executable}`);
  await assertExists(join(packageDir, 'bundles', 'cli.js'), 'Missing cli.js');
}

await rm(packageDir, { recursive: true, force: true });
await rm(archivePath, { force: true });
await mkdir(packageDir, { recursive: true });

await copyRequiredBundles();
const copiedRuntimePackages = new Set();
for (const packageNameToCopy of externalRuntimePackages) {
  await copyExternalRuntimePackage(packageNameToCopy, copiedRuntimePackages);
}
await writeLaunchers();
await writePackageMetadata();
await smokeTestPackagedCli();
await createTarGz();

const sizeMb = ((await stat(archivePath)).size / 1024 / 1024).toFixed(1);

console.log(`Created ${relative(rootDir, packageDir)}`);
console.log(`Created ${relative(rootDir, archivePath)} (${sizeMb} MiB)`);
