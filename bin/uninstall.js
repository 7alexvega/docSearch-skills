#!/usr/bin/env node

'use strict';

const fs   = require('fs');
const path = require('path');
const rl   = require('readline');
const os   = require('os');

// ---------------------------------------------------------------------------
// ANSI helpers (disabled when not a TTY)
// ---------------------------------------------------------------------------
const isTTY = process.stdout.isTTY;
const c = {
  reset:  isTTY ? '\x1b[0m'  : '',
  bold:   isTTY ? '\x1b[1m'  : '',
  dim:    isTTY ? '\x1b[2m'  : '',
  green:  isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  red:    isTTY ? '\x1b[31m' : '',
};
const bold   = s => `${c.bold}${s}${c.reset}`;
const dim    = s => `${c.dim}${s}${c.reset}`;
const green  = s => `${c.green}${s}${c.reset}`;
const yellow = s => `${c.yellow}${s}${c.reset}`;
const red    = s => `${c.red}${s}${c.reset}`;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
function expandTilde(p) {
  if (!p) return p;
  return (p === '~' || p.startsWith('~/') || p.startsWith('~\\'))
    ? path.join(os.homedir(), p.slice(1))
    : p;
}

function toTildePath(absPath) {
  const home = os.homedir().replace(/\\/g, '/');
  const norm = absPath.replace(/\\/g, '/');
  return norm.startsWith(home) ? '~' + norm.slice(home.length) : norm;
}

function getClaudeGlobalDir() {
  if (process.env.CLAUDE_CONFIG_DIR) return expandTilde(process.env.CLAUDE_CONFIG_DIR);
  if (process.env.XDG_CONFIG_HOME)   return path.join(expandTilde(process.env.XDG_CONFIG_HOME), 'claude');
  return path.join(os.homedir(), '.claude');
}

function getCodexGlobalDir() {
  if (process.env.CODEX_HOME)        return expandTilde(process.env.CODEX_HOME);
  if (process.env.OPENAI_CODEX_HOME) return expandTilde(process.env.OPENAI_CODEX_HOME);
  if (process.env.XDG_CONFIG_HOME)   return path.join(expandTilde(process.env.XDG_CONFIG_HOME), 'codex');
  return path.join(os.homedir(), '.codex');
}

// ---------------------------------------------------------------------------
// All possible manifest locations (mirrors RUNTIMES in install.js)
// ---------------------------------------------------------------------------
const MANIFEST_FILENAME = 'docsearch-manifest.json';

function getManifestLocations() {
  return [
    { label: 'Claude Code - local',  file: path.join(process.cwd(), '.claude', MANIFEST_FILENAME) },
    { label: 'Claude Code - global', file: path.join(getClaudeGlobalDir(), MANIFEST_FILENAME) },
    { label: 'Codex - local',        file: path.join(process.cwd(), '.codex', MANIFEST_FILENAME) },
    { label: 'Codex - global',       file: path.join(getCodexGlobalDir(), MANIFEST_FILENAME) },
  ];
}

// ---------------------------------------------------------------------------
// Walk up from startDir removing empty directories until stopDir is reached.
// Mirrors the helper in install.js so Codex installs (which nest files inside
// per-skill subdirectories) clean up completely.
// ---------------------------------------------------------------------------
function removeEmptyDirsUntil(startDir, stopDir) {
  let current = startDir;
  const stop = path.resolve(stopDir);

  while (true) {
    const resolvedCurrent = path.resolve(current);
    const relativeToStop = path.relative(stop, resolvedCurrent);
    if (
      resolvedCurrent === stop ||
      relativeToStop.startsWith('..') ||
      path.isAbsolute(relativeToStop)
    ) {
      break;
    }

    try {
      if (!fs.existsSync(current) || fs.readdirSync(current).length > 0) break;
      fs.rmdirSync(current);
    } catch (_) {
      break;
    }
    current = path.dirname(current);
  }
}

// ---------------------------------------------------------------------------
// Hook un-merge: removes exactly the hook entries this package recorded in
// its own manifest from settings.json, leaving any unrelated hooks or other
// settings the user configured completely untouched.
// ---------------------------------------------------------------------------
function readJSONSafe(filePath) {
  if (!fs.existsSync(filePath)) return { value: null, existed: false, malformed: false };
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, 'utf8')), existed: true, malformed: false };
  } catch (err) {
    return { value: null, existed: true, malformed: true, error: err };
  }
}

function removeDeepEqual(arr, items) {
  if (!Array.isArray(items) || items.length === 0) return arr;
  const serialized = items.map(i => JSON.stringify(i));
  return arr.filter(x => !serialized.includes(JSON.stringify(x)));
}

function unmergePermissionsFromSettings(settingsPath, prevPermissions) {
  if (!prevPermissions || !prevPermissions.length || !settingsPath) return { ok: true };
  const { value, existed, malformed } = readJSONSafe(settingsPath);
  if (!existed) return { ok: true };
  if (malformed) {
    return { ok: false, message: `${settingsPath} is not valid JSON — could not remove docSearch's permission entries automatically. Remove them by hand.` };
  }
  const settings = value;
  if (!settings.permissions || !Array.isArray(settings.permissions.allow)) return { ok: true };

  settings.permissions.allow = settings.permissions.allow.filter(p => !prevPermissions.includes(p));
  if (settings.permissions.allow.length === 0) delete settings.permissions.allow;
  if (Object.keys(settings.permissions).length === 0) delete settings.permissions;

  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch (err) {
    return { ok: false, message: `Failed writing ${settingsPath}: ${err.message}` };
  }
  return { ok: true };
}

function unmergeHooksFromSettings(settingsPath, prevHooks) {
  if (!prevHooks || !settingsPath) return { ok: true };
  const { value, existed, malformed } = readJSONSafe(settingsPath);
  if (!existed) return { ok: true };
  if (malformed) {
    return { ok: false, message: `${settingsPath} is not valid JSON — could not remove docSearch's hook entries automatically. Remove them by hand.` };
  }
  const settings = value;
  if (!settings.hooks || typeof settings.hooks !== 'object') return { ok: true };

  for (const event of ['PreToolUse', 'PostToolUse', 'SessionStart']) {
    if (!Array.isArray(settings.hooks[event]) || !Array.isArray(prevHooks[event])) continue;
    settings.hooks[event] = removeDeepEqual(settings.hooks[event], prevHooks[event]);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch (err) {
    return { ok: false, message: `Failed writing ${settingsPath}: ${err.message}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Uninstall one manifest entry
// ---------------------------------------------------------------------------
function uninstall(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let removed = 0;
  let missing = 0;
  const failures = [];

  for (const filePath of (manifest.files || [])) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        if (manifest.commandsDir) {
          removeEmptyDirsUntil(path.dirname(filePath), manifest.commandsDir);
        }
        removed++;
      } else {
        missing++;
      }
    } catch (err) {
      failures.push({ filePath, message: err.message });
    }
  }

  // Remove the commands dir if it is now empty
  const dir = manifest.commandsDir;
  if (dir && fs.existsSync(dir)) {
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch (_) {}
  }

  // Also clean up the hooks dir, which lives outside commandsDir
  // (.claude/hooks/docSearch rather than .claude/commands/docSearch), and has
  // its own lib/ subdirectory that needs removing before its parent will
  // read as empty.
  if (manifest.hooksDir) {
    const libDir = path.join(manifest.hooksDir, 'lib');
    try {
      if (fs.existsSync(libDir) && fs.readdirSync(libDir).length === 0) fs.rmdirSync(libDir);
    } catch (_) {}
    if (fs.existsSync(manifest.hooksDir)) {
      removeEmptyDirsUntil(manifest.hooksDir, path.dirname(path.dirname(manifest.hooksDir)));
    }
  }

  // Clean up the scripts dir, which like hooksDir lives outside commandsDir and
  // has a lib/ subdirectory that must go before its parent reads as empty.
  if (manifest.scriptsDir) {
    const libDir = path.join(manifest.scriptsDir, 'lib');
    try {
      if (fs.existsSync(libDir) && fs.readdirSync(libDir).length === 0) fs.rmdirSync(libDir);
    } catch (_) {}
    if (fs.existsSync(manifest.scriptsDir)) {
      removeEmptyDirsUntil(manifest.scriptsDir, path.dirname(path.dirname(manifest.scriptsDir)));
    }
  }

  // Un-merge this install's hook entries from settings.json
  if (manifest.hooks) {
    const result = unmergeHooksFromSettings(manifest.settingsPath, manifest.hooks);
    if (!result.ok) failures.push({ filePath: manifest.settingsPath, message: result.message });
  }

  // Un-merge this install's permission entries from settings.json
  if (manifest.permissions) {
    const result = unmergePermissionsFromSettings(manifest.settingsPath, manifest.permissions);
    if (!result.ok) failures.push({ filePath: manifest.settingsPath, message: result.message });
  }

  // Remove the manifest itself
  try {
    fs.unlinkSync(manifestPath);
  } catch (err) {
    failures.push({ filePath: manifestPath, message: err.message });
  }

  return { removed, missing, failures, manifest };
}

// ---------------------------------------------------------------------------
// Prompt helper
// ---------------------------------------------------------------------------
function prompt(question) {
  const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => iface.question(question, a => { iface.close(); resolve(a.trim()); }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n' + bold('docSearch Skills Uninstaller') + '\n');

  const found = getManifestLocations().filter(loc => fs.existsSync(loc.file));

  if (found.length === 0) {
    console.log('  ' + yellow('No docSearch installation found.') + '\n');
    console.log('  ' + dim('Looked in:'));
    for (const loc of getManifestLocations()) {
      console.log('    ' + dim('* ' + toTildePath(loc.file)));
    }
    console.log();
    process.exit(0);
  }

  // Show what will be removed
  console.log('  ' + yellow('Found ' + found.length + ' installation' + (found.length > 1 ? 's' : '') + ':') + '\n');
  for (const loc of found) {
    const manifest = JSON.parse(fs.readFileSync(loc.file, 'utf8'));
    console.log('  ' + bold(loc.label) + '  ' + dim('v' + manifest.version + ' installed ' + manifest.timestamp.slice(0, 10)));
    console.log('    ' + dim(toTildePath(manifest.commandsDir)));
    console.log('    ' + dim((manifest.files || []).length + ' files'));
    console.log();
  }

  const confirm = await prompt('  Remove all? ' + dim('[y/N]') + ': ');
  if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
    console.log('\n  Aborted.\n');
    process.exit(0);
  }

  console.log();
  let anyFailed = false;

  for (const loc of found) {
    process.stdout.write('  Removing ' + bold(loc.label) + '...');
    try {
      const { removed, missing, failures } = uninstall(loc.file);
      if (failures.length === 0) {
        process.stdout.write(' ' + green('done') + '\n');
      } else {
        process.stdout.write(' ' + yellow('partial') + '\n');
        anyFailed = true;
      }
      if (missing > 0)  console.log('    ' + dim(missing + ' file(s) already missing - skipped'));
      if (removed > 0)  console.log('    ' + dim(removed + ' file(s) removed'));
      for (const f of failures) {
        console.log('    ' + red('x ' + f.filePath + ': ' + f.message));
      }
    } catch (err) {
      process.stdout.write(' ' + red('FAILED') + '\n');
      console.log('    ' + red(err.message));
      anyFailed = true;
    }
  }

  console.log();
  if (!anyFailed) {
    console.log('  ' + bold(green('Done.')) + ' docSearch skills uninstalled.\n');
  } else {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Non-interactive fallback (CI / piped)
// ---------------------------------------------------------------------------
if (!process.stdin.isTTY) {
  const found = getManifestLocations().filter(loc => fs.existsSync(loc.file));
  if (found.length === 0) {
    console.log(yellow('\n  No docSearch installation found.\n'));
    process.exit(0);
  }
  let anyFailed = false;
  for (const loc of found) {
    try {
      const { removed, failures } = uninstall(loc.file);
      console.log(green('  + Removed ' + removed + ' files (' + loc.label + ')\n'));
      for (const f of failures) {
        console.error(red('  x ' + f.filePath + ': ' + f.message));
        anyFailed = true;
      }
    } catch (err) {
      console.error(red('  x Failed (' + loc.label + '): ' + err.message + '\n'));
      anyFailed = true;
    }
  }
  if (anyFailed) process.exit(1);
} else {
  main().catch(err => {
    console.error(red('\n  Error: ' + err.message + '\n'));
    process.exit(1);
  });
}