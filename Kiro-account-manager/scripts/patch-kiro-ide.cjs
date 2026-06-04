#!/usr/bin/env node
/* eslint-disable */
/**
 * patch-kiro-ide.cjs
 *
 * 修补 Kiro IDE 桌面端的 BuilderId 占位符 profileArn bug。
 *
 * 背景：Kiro IDE 在 `FixedProfileArns` 里给 BuilderId 硬编码了占位符 ARN
 *      `arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX`，
 *      调用 codewhisperer.us-east-1.amazonaws.com 的 REST 端点
 *      （ListAvailableModels 等）会触发：
 *        403 "User is not authorized to make this call."
 *      根因：AWS Builder ID 本身不支持 profile 概念，请求不应带 profileArn。
 *
 * 修补点（在 extensions/kiro.kiro-agent 内的 bundled JS 中正则替换）：
 *   1. getFixedProfileArn   —— BuilderId 短路返回 undefined
 *   2. supportsProfiles     —— 把 BuilderId 从 IdC 列表移除
 *   3. resolveProfileArn    —— BuilderId token 直接返回 undefined（不会再写脏数据）
 *
 * 同时清理已被持久化到磁盘的占位符（globalStorage/kiro.kiro-agent/profile.json）。
 *
 * 特性：
 *   - 幂等：通过文件首行 MARKER 检测，已修补则跳过
 *   - 备份：每个目标文件首次修补会写 `<file>.kpatch-backup`
 *   - 跨平台：Windows / macOS / Linux 自动探测路径
 *   - 可回滚：`--restore` 从备份恢复
 *   - 可预检：`--dry-run` 输出会做什么，不真改文件
 *
 * 使用：
 *   node scripts/patch-kiro-ide.cjs
 *   node scripts/patch-kiro-ide.cjs --dry-run
 *   node scripts/patch-kiro-ide.cjs --restore
 *   node scripts/patch-kiro-ide.cjs --kiro-dir "D:\\Program\\Kiro"
 *   node scripts/patch-kiro-ide.cjs --verbose
 *
 * Kiro 升级会覆盖 extension.js，升级后请重新运行本脚本。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PATCH_VERSION = 1;
const MARKER = `/* @patched-kiro-builderid-arn-fix v${PATCH_VERSION} */`;
const PLACEHOLDER_ARN_BUILDERID =
  'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX';

const args = parseArgs(process.argv.slice(2));
const log = createLogger(args.verbose);

function parseArgs(argv) {
  const out = {
    dryRun: false,
    restore: false,
    verbose: false,
    kiroDir: null,
    userDataDir: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--restore':
        out.restore = true;
        break;
      case '--verbose':
      case '-v':
        out.verbose = true;
        break;
      case '--kiro-dir':
        out.kiroDir = argv[++i];
        break;
      case '--userdata-dir':
        out.userDataDir = argv[++i];
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        if (a.startsWith('--')) {
          console.error(`Unknown option: ${a}`);
          printHelp();
          process.exit(64);
        }
    }
  }
  return out;
}

function printHelp() {
  console.log(`
patch-kiro-ide.cjs - 修补 Kiro IDE BuilderId 占位符 profileArn bug

用法:
  node patch-kiro-ide.cjs [选项]

选项:
  --dry-run             只检查不写入，输出会做什么
  --restore             从 .kpatch-backup 还原到打补丁前
  --verbose, -v         详细日志
  --kiro-dir <dir>      指定 Kiro 安装根目录（默认自动探测）
                        Win  例: D:\\Program\\Kiro
                        mac  例: /Applications/Kiro.app/Contents/Resources/app
                        linux例: /opt/Kiro
  --userdata-dir <dir>  指定 Kiro userData 目录（默认自动探测）
                        Win  例: %APPDATA%\\Kiro
                        mac  例: ~/Library/Application Support/Kiro
                        linux例: ~/.config/Kiro
  -h, --help            显示帮助

环境变量:
  KIRO_DIR              同 --kiro-dir
  KIRO_USERDATA_DIR     同 --userdata-dir

退出码:
  0  成功（含 "无需操作" / "已修补"）
  1  运行时异常
  2  找不到 Kiro 安装目录
  3  找不到任何目标文件（路径或版本不匹配）
 64  参数错误
`);
}

function createLogger(verbose) {
  return {
    info: (msg) => console.log(`[patch] ${msg}`),
    warn: (msg) => console.warn(`[patch] WARN: ${msg}`),
    error: (msg) => console.error(`[patch] ERROR: ${msg}`),
    debug: (msg) => {
      if (verbose) console.log(`[patch] DEBUG: ${msg}`);
    }
  };
}

function probeKiroDir(dir) {
  if (!dir) return false;
  const win = path.join(
    dir,
    'resources',
    'app',
    'extensions',
    'kiro.kiro-agent',
    'dist',
    'extension.js'
  );
  if (fs.existsSync(win)) return true;
  const mac = path.join(dir, 'extensions', 'kiro.kiro-agent', 'dist', 'extension.js');
  if (fs.existsSync(mac)) return true;
  return false;
}

function detectKiroDir() {
  if (args.kiroDir) return args.kiroDir;
  if (process.env.KIRO_DIR) return process.env.KIRO_DIR;

  const platform = os.platform();
  const candidates = [];
  if (platform === 'win32') {
    candidates.push(
      'D:\\Program\\Kiro',
      'C:\\Program Files\\Kiro',
      'C:\\Program Files (x86)\\Kiro',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Kiro')
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Kiro.app/Contents/Resources/app',
      path.join(os.homedir(), 'Applications/Kiro.app/Contents/Resources/app')
    );
  } else {
    candidates.push('/usr/share/kiro', '/opt/Kiro', path.join(os.homedir(), '.local/share/kiro'));
  }
  for (const dir of candidates) {
    if (probeKiroDir(dir)) return dir;
  }
  return null;
}

function detectUserDataDir() {
  if (args.userDataDir) return args.userDataDir;
  if (process.env.KIRO_USERDATA_DIR) return process.env.KIRO_USERDATA_DIR;
  const platform = os.platform();
  if (platform === 'win32') return path.join(process.env.APPDATA || '', 'Kiro');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Kiro');
  return path.join(os.homedir(), '.config', 'Kiro');
}

function getExtRoot(kiroDir) {
  const winRoot = path.join(kiroDir, 'resources', 'app', 'extensions', 'kiro.kiro-agent');
  if (fs.existsSync(winRoot)) return winRoot;
  const macRoot = path.join(kiroDir, 'extensions', 'kiro.kiro-agent');
  if (fs.existsSync(macRoot)) return macRoot;
  return null;
}

function listTargetFiles(kiroDir) {
  const extRoot = getExtRoot(kiroDir);
  if (!extRoot) return [];

  const targets = [];
  const ext = path.join(extRoot, 'dist', 'extension.js');
  if (fs.existsSync(ext)) targets.push(ext);

  const sharedDist = path.join(extRoot, 'packages', 'kiro-shared', 'dist');
  if (fs.existsSync(sharedDist)) {
    for (const name of ['index.js', 'index.cjs']) {
      const p = path.join(sharedDist, name);
      if (fs.existsSync(p)) targets.push(p);
    }
    for (const name of fs.readdirSync(sharedDist)) {
      if (/^external-idp-auth-provider-[A-Za-z0-9_-]+\.(js|cjs)$/.test(name)) {
        targets.push(path.join(sharedDist, name));
      }
    }
  }

  // autocomplete 包只 import 这些符号、不定义它们，无需修补
  return targets;
}

function applyReplacements(src) {
  let touched = 0;

  // 补丁 1: getFixedProfileArn 顶部插入 BuilderId 短路
  const reFixed = /function getFixedProfileArn\(tokenProvider, currentToken\) \{\s*if \(!FixedProfileArns\.has/g;
  src = src.replace(reFixed, () => {
    touched++;
    return [
      'function getFixedProfileArn(tokenProvider, currentToken) {',
      '  if (tokenProvider === "BuilderId") return void 0;',
      '  if (!FixedProfileArns.has'
    ].join('\n');
  });

  // 补丁 2: supportsProfiles 移除 BuilderId IdC 归类（extension.js 中有多份副本）
  const reSupports = /token\.provider === "Enterprise" \|\| token\.provider === "Internal" \|\| token\.provider === "BuilderId"/g;
  src = src.replace(reSupports, () => {
    touched++;
    return 'token.provider === "Enterprise" || token.provider === "Internal"';
  });

  // 补丁 3: resolveProfileArn 顶部插入 BuilderId 短路（多副本场景同样 g flag）
  const reResolve = /async function resolveProfileArn\(options2?\) \{\s*const profileArn = await authProvider\.getProfileArn\(\);/g;
  src = src.replace(reResolve, () => {
    touched++;
    return [
      'async function resolveProfileArn(options2) {',
      '  const __kiroPatchToken = authProvider.readToken();',
      '  if (__kiroPatchToken && __kiroPatchToken.provider === "BuilderId") return void 0;',
      '  const profileArn = await authProvider.getProfileArn();'
    ].join('\n');
  });

  return { src, touched };
}

function patchFile(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');
  if (original.startsWith(MARKER) || original.includes(MARKER)) {
    log.debug(`already patched: ${filePath}`);
    return { changed: false, reason: 'already-patched' };
  }

  const { src: replaced, touched } = applyReplacements(original);
  if (touched === 0) {
    log.warn(`no anchor matched in ${filePath} (file may be upgraded / format changed)`);
    return { changed: false, reason: 'no-anchor' };
  }

  const patched = `${MARKER}\n${replaced}`;

  if (args.dryRun) {
    log.info(`[dry-run] would patch ${filePath} (${touched} replacement(s))`);
    return { changed: true, touched, dryRun: true };
  }

  const bakPath = `${filePath}.kpatch-backup`;
  if (!fs.existsSync(bakPath)) {
    fs.writeFileSync(bakPath, original);
    log.debug(`backup written: ${bakPath}`);
  } else {
    log.debug(`backup already exists, kept as-is: ${bakPath}`);
  }
  fs.writeFileSync(filePath, patched);
  log.info(`patched ${filePath} (${touched} replacement(s))`);
  return { changed: true, touched };
}

function restoreFile(filePath) {
  const bakPath = `${filePath}.kpatch-backup`;
  if (!fs.existsSync(bakPath)) {
    log.debug(`no backup for ${filePath}, skip`);
    return false;
  }
  if (args.dryRun) {
    log.info(`[dry-run] would restore ${filePath} from ${bakPath}`);
    return true;
  }
  fs.copyFileSync(bakPath, filePath);
  log.info(`restored ${filePath}`);
  return true;
}

function cleanProfileJson(userDataDir) {
  const profilePath = path.join(
    userDataDir,
    'User',
    'globalStorage',
    'kiro.kiro-agent',
    'profile.json'
  );
  if (!fs.existsSync(profilePath)) {
    log.debug(`no profile.json at: ${profilePath}`);
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch (e) {
    log.warn(`profile.json unreadable, skip: ${e.message}`);
    return false;
  }
  if (!parsed || parsed.arn !== PLACEHOLDER_ARN_BUILDERID) {
    log.debug(`profile.json arn=${parsed && parsed.arn}, not placeholder, leave alone`);
    return false;
  }
  if (args.dryRun) {
    log.info(`[dry-run] would remove placeholder profile.json: ${profilePath}`);
    return true;
  }
  const bakPath = `${profilePath}.kpatch-backup`;
  if (!fs.existsSync(bakPath)) fs.copyFileSync(profilePath, bakPath);
  fs.unlinkSync(profilePath);
  log.info(`removed placeholder profile.json: ${profilePath}`);
  return true;
}

function warnIfKiroRunning() {
  if (os.platform() !== 'win32') return;
  try {
    const { execSync } = require('child_process');
    const stdout = execSync('tasklist /FI "IMAGENAME eq Kiro.exe" /FO CSV', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8'
    });
    if (/^"Kiro\.exe"/m.test(stdout)) {
      log.warn('Kiro.exe is running. It is strongly recommended to fully exit Kiro first.');
    }
  } catch {
    // ignore detection errors
  }
}

function main() {
  log.info(
    `patch-kiro-ide v${PATCH_VERSION} - mode=${args.dryRun ? 'dry-run' : args.restore ? 'restore' : 'apply'}`
  );

  const kiroDir = detectKiroDir();
  if (!kiroDir) {
    log.error('Kiro install dir not found. Pass --kiro-dir <path> or set KIRO_DIR.');
    process.exit(2);
  }
  log.info(`Kiro install dir: ${kiroDir}`);

  const userDataDir = detectUserDataDir();
  log.info(`Kiro userData dir: ${userDataDir}`);

  warnIfKiroRunning();

  const targets = listTargetFiles(kiroDir);
  if (targets.length === 0) {
    log.error(
      `No target files found under ${kiroDir}. Is this a valid Kiro install? (looked under resources/app/extensions/kiro.kiro-agent)`
    );
    process.exit(3);
  }
  log.info(`Found ${targets.length} target file(s).`);

  let changes = 0;
  if (args.restore) {
    for (const f of targets) if (restoreFile(f)) changes++;
    const bakProfile = path.join(
      userDataDir,
      'User',
      'globalStorage',
      'kiro.kiro-agent',
      'profile.json.kpatch-backup'
    );
    if (fs.existsSync(bakProfile)) {
      log.info(
        `profile.json backup exists at ${bakProfile} (not restored automatically; restore manually if you really want the placeholder back)`
      );
    }
  } else {
    for (const f of targets) {
      const r = patchFile(f);
      if (r.changed) changes++;
    }
    if (cleanProfileJson(userDataDir)) changes++;
  }

  log.info(
    `done. ${changes} file(s) ${args.restore ? 'restored' : 'changed/cleaned'}.`
  );
  if (!args.restore && changes > 0 && !args.dryRun) {
    log.info('Please fully restart Kiro IDE for the patch to take effect.');
  }
}

try {
  main();
} catch (e) {
  log.error((e && (e.stack || e.message)) || String(e));
  process.exit(1);
}
