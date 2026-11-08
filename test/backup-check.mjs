#!/usr/bin/env node
// Task-11 备份自检：tarball 内容、SHA256SUMS、ROLLBACK.md 幂等四步。
// 用法：node test/backup-check.mjs --backup <备份目录>
// 退出码：全部通过 0，任一失败 1。

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import process from 'node:process';

const EXPECTED_FILES = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml'];
const TGZ_NAME = 'royalsan-dsh-github-trending-1.0.0.tgz';
const PROFILE_SNAPSHOT_DIR = 'profile-2026-11-08';

const failures = [];
const passes = [];

function parseArgs(argv) {
  let backup = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--backup') {
      backup = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--backup=')) {
      backup = arg.slice('--backup='.length);
    }
  }
  return { backup };
}

function check(name, fn) {
  try {
    const detail = fn();
    passes.push(name);
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`FAIL  ${name} — ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// 极简 tar 读取：npm pack 产物没有 GNU 长文件名，按 512 字节头逐条遍历。
function readTarEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  let longName = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim();
    const size = sizeField ? parseInt(sizeField, 8) : 0;
    const typeflag = String.fromCharCode(header[156]);
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    let name = (prefix ? `${prefix}/${rawName}` : rawName);

    if (Number.isNaN(size)) throw new Error(`无法解析 tar 头 size：${sizeField}`);

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new Error(`tar 条目越界：${name}`);

    if (typeflag === 'L') {
      longName = buffer.subarray(dataStart, dataEnd).toString('utf8').replace(/\0.*$/s, '');
    } else if (typeflag === '0' || typeflag === '\0') {
      const finalName = longName ?? name;
      entries.set(finalName, buffer.subarray(dataStart, dataEnd));
      longName = null;
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function main() {
  const { backup } = parseArgs(process.argv.slice(2));
  if (!backup) {
    console.error('用法：node test/backup-check.mjs --backup <备份目录>');
    process.exit(1);
  }

  const backupDir = path.resolve(backup);
  console.log(`备份目录：${backupDir}`);

  check('备份目录存在', () => {
    assert(existsSync(backupDir) && statSync(backupDir).isDirectory(), `目录不存在：${backupDir}`);
    return backupDir;
  });

  const tgzPath = path.join(backupDir, TGZ_NAME);
  const snapshotDir = path.join(backupDir, PROFILE_SNAPSHOT_DIR);

  check(`tarball 存在（${TGZ_NAME}）`, () => {
    assert(existsSync(tgzPath), `缺少 ${tgzPath}`);
    return `${statSync(tgzPath).size} 字节`;
  });

  let entries = null;
  check('tarball 能解出 package/package.json', () => {
    assert(existsSync(tgzPath), 'tarball 缺失，无法读取');
    entries = readTarEntries(gunzipSync(readFileSync(tgzPath)));
    assert(entries.has('package/package.json'), `tarball 内没有 package/package.json；实际条目：${[...entries.keys()].join(', ')}`);
    return `${entries.size} 个条目`;
  });

  check('tarball 内 package.json 版本为 1.0.0', () => {
    assert(entries && entries.has('package/package.json'), 'package/package.json 不可读');
    const pkg = JSON.parse(entries.get('package/package.json').toString('utf8'));
    assert(pkg.version === '1.0.0', `版本是 ${pkg.version}，期望 1.0.0`);
    assert(pkg.name === '@royalsan/dsh-github-trending', `包名是 ${pkg.name}`);
    return `${pkg.name}@${pkg.version}`;
  });

  check('快照目录含四个文件', () => {
    assert(existsSync(snapshotDir), `缺少快照目录 ${snapshotDir}`);
    for (const name of EXPECTED_FILES) {
      assert(existsSync(path.join(snapshotDir, name)), `缺少快照文件 ${name}`);
    }
    return EXPECTED_FILES.join(', ');
  });

  check('SHA256SUMS 列全四个文件且校验通过', () => {
    const sumsPath = path.join(snapshotDir, 'SHA256SUMS');
    assert(existsSync(sumsPath), `缺少 ${sumsPath}`);
    const lines = readFileSync(sumsPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const listed = new Map();
    for (const line of lines) {
      const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
      assert(match, `SHA256SUMS 行格式不对：${line}`);
      listed.set(match[2].replace(/\\/g, '/'), match[1].toLowerCase());
    }
    assert(listed.size === lines.length, 'SHA256SUMS 有重复文件名');
    assert(listed.size === EXPECTED_FILES.length, `SHA256SUMS 条目数 ${listed.size}，期望 ${EXPECTED_FILES.length}`);
    for (const name of EXPECTED_FILES) {
      assert(listed.has(name), `SHA256SUMS 缺 ${name}`);
      const actual = sha256(path.join(snapshotDir, name));
      assert(actual === listed.get(name), `${name} 哈希不一致：实际 ${actual}，记录 ${listed.get(name)}`);
    }
    return `${EXPECTED_FILES.length}/${EXPECTED_FILES.length} 通过`;
  });

  check('ROLLBACK.md 含幂等四步与关键命令', () => {
    const rollbackPath = path.join(backupDir, 'ROLLBACK.md');
    assert(existsSync(rollbackPath), `缺少 ${rollbackPath}`);
    const text = readFileSync(rollbackPath, 'utf8');
    const requireText = (needle) => assert(text.includes(needle), `ROLLBACK.md 缺少「${needle}」`);

    for (const step of ['第一步', '第二步', '第三步', '第四步']) requireText(step);
    requireText('幂等');
    requireText('pnpm remove dsh-github-trending-plus');
    requireText('pnpm install --frozen-lockfile');
    requireText('pnpm add');
    requireText(tgzPath);
    requireText('重启 DSH');
    requireText('tgz 在恢复文件与 lockfile 之后');

    const at = (needle) => {
      const index = text.indexOf(needle);
      assert(index >= 0, `找不到「${needle}」，无法判断顺序`);
      return index;
    };
    const restore = at('第二步：');
    const lockfileStep = at('第三步：');
    const addTgz = at('pnpm add');
    const restart = at('重启 DSH');
    assert(restore < lockfileStep, '顺序错误：第二步（恢复文件）应在第三步（frozen-lockfile）之前');
    assert(lockfileStep < addTgz, '顺序错误：tgz 必须在恢复文件与 lockfile 之后安装');
    assert(addTgz < restart, '顺序错误：重启 DSH 必须是最后一步');
    return '四步 + frozen-lockfile + tgz + 重启 DSH，顺序正确';
  });

  console.log('');
  console.log(`结果：${passes.length} 项通过，${failures.length} 项失败`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
