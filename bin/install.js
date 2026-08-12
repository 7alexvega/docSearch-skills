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
  cyan:   isTTY ? '\x1b[36m' : '',
  green:  isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  red:    isTTY ? '\x1b[31m' : '',
};
const bold   = s => `${c.bold}${s}${c.reset}`;
const dim    = s => `${c.dim}${s}${c.reset}`;
const cyan   = s => `${c.cyan}${s}${c.reset}`;
const green  = s => `${c.green}${s}${c.reset}`;
const yellow = s => `${c.yellow}${s}${c.reset}`;
const red    = s => `${c.red}${s}${c.reset}`;

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------
const SKILLS_SRC  = path.join(__dirname, '..', 'skills', 'docSearch');
const SCRIPTS_SRC = path.join(__dirname, '..', 'scripts');

// Tokens in source skill files, replaced at install time with a concrete path
// for the chosen runtime.
//
// These are deliberately opaque placeholders rather than a path that happens to
// be correct for one target, and never a runtime-provided variable: a variable
// that silently fails to expand produces a skill that looks installed and reads
// nothing. A token that fails to patch leaves the literal `{{...}}` visible in
// the installed file, which is immediately diagnosable.
const TOKEN_CONTEXT = '{{DOCSEARCH_CONTEXT}}';
const TOKEN_SCRIPTS = '{{DOCSEARCH_SCRIPTS}}';

// Legacy literal from pre-token releases. Still replaced so an upgrade over an
// older checkout cannot leave a stale Claude-shaped path in a Codex install.
const LEGACY_CONTEXT_PATH = '.claude/skills/docSearch/context.md';

const MANIFEST_FILENAME = 'docsearch-manifest.json';
const PKG = require('../package.json');

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
// Runtime definitions
//
// commandsDir  - where the skill markdown lands
// scriptsDir   - where the pipeline scripts land. Deliberately OUTSIDE any
//                directory a runtime scans for its own command/skill discovery,
//                so `.js` files can never be mistaken for skill definitions.
// contextRef   - the path patched in for {{DOCSEARCH_CONTEXT}}
// scriptsRef   - the path patched in for {{DOCSEARCH_SCRIPTS}}
//
// Local installs use paths relative to the project root, because every skill
// already resolves `.index/` relative to the cwd the runtime was launched in —
// the same root. Global installs must be absolute: the cwd there is whichever
// vault the user happens to be in, which is exactly not where the files live.
// ---------------------------------------------------------------------------
const RUNTIMES = [
  {
    key:          'claude-local',
    label:        'Claude Code - local project',
    commandsDir:  () => path.join(process.cwd(), '.claude', 'commands', 'docSearch'),
    scriptsDir:   () => path.join(process.cwd(), '.claude', 'docsearch', 'scripts'),
    manifestPath: () => path.join(process.cwd(), '.claude', MANIFEST_FILENAME),
    hooksDir:     () => path.join(process.cwd(), '.claude', 'hooks', 'docSearch'),
    settingsPath: () => path.join(process.cwd(), '.claude', 'settings.json'),
    contextRef:   () => '.claude/commands/docSearch/context.md',
    scriptsRef:   () => '.claude/docsearch/scripts',
    isCodex:      false,
    invoke:       '/docSearch:<skill>',
  },
  {
    key:          'claude-global',
    label:        'Claude Code - global (all projects)',
    commandsDir:  () => path.join(getClaudeGlobalDir(), 'commands', 'docSearch'),
    scriptsDir:   () => path.join(getClaudeGlobalDir(), 'docsearch', 'scripts'),
    manifestPath: () => path.join(getClaudeGlobalDir(), MANIFEST_FILENAME),
    hooksDir:     () => path.join(getClaudeGlobalDir(), 'hooks', 'docSearch'),
    settingsPath: () => path.join(getClaudeGlobalDir(), 'settings.json'),
    contextRef:   () => path.join(getClaudeGlobalDir(), 'commands', 'docSearch', 'context.md').replace(/\\/g, '/'),
    scriptsRef:   () => path.join(getClaudeGlobalDir(), 'docsearch', 'scripts').replace(/\\/g, '/'),
    isCodex:      false,
    invoke:       '/docSearch:<skill>',
  },
  {
    key:          'codex-local',
    label:        'Codex - local project',
    commandsDir:  () => path.join(process.cwd(), '.codex', 'skills'),
    scriptsDir:   () => path.join(process.cwd(), '.codex', 'docsearch', 'scripts'),
    manifestPath: () => path.join(process.cwd(), '.codex', MANIFEST_FILENAME),
    contextRef:   () => '.codex/skills/docSearch-context/context.md',
    scriptsRef:   () => '.codex/docsearch/scripts',
    isCodex:      true,
    invoke:       'docSearch-<skill>',
  },
  {
    key:          'codex-global',
    label:        'Codex - global (all projects)',
    commandsDir:  () => path.join(getCodexGlobalDir(), 'skills'),
    scriptsDir:   () => path.join(getCodexGlobalDir(), 'docsearch', 'scripts'),
    manifestPath: () => path.join(getCodexGlobalDir(), MANIFEST_FILENAME),
    contextRef:   () => path.join(getCodexGlobalDir(), 'skills', 'docSearch-context', 'context.md').replace(/\\/g, '/'),
    scriptsRef:   () => path.join(getCodexGlobalDir(), 'docsearch', 'scripts').replace(/\\/g, '/'),
    isCodex:      true,
    invoke:       'docSearch-<skill>',
  },
];

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

function setFrontmatterName(content, name) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return `---\nname: ${name}\n---\n\n${content}`;
  }

  const frontmatter = match[1];
  const updatedFrontmatter = /^name:\s*.*$/m.test(frontmatter)
    ? frontmatter.replace(/^name:\s*.*$/m, `name: ${name}`)
    : `name: ${name}\n${frontmatter}`;

  return content.slice(0, match.index)
    + `---\n${updatedFrontmatter}\n---`
    + content.slice(match.index + match[0].length);
}

// ---------------------------------------------------------------------------
// Legacy hook removal
//
// docSearch 1.x installed PreToolUse/PostToolUse validators that intercepted
// Write and Edit against `.index/`. Those existed to catch structural mistakes
// a model made while authoring index JSON by hand. In 2.x a model never authors
// that JSON — the pipeline scripts do — so the hooks guard a write path that no
// longer exists, and they only ever covered Claude, leaving Codex on a second
// safety tier.
//
// Upgrading must therefore remove them. Their scripts are no longer shipped, so
// leaving the settings entries behind would point `node` at files that are not
// there and break every Write to `.index/`.
// ---------------------------------------------------------------------------
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'SessionStart'];

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

// Removes exactly the hook entries a previous docSearch install recorded in its
// manifest, leaving any hooks the user configured themselves untouched.
// Returns how many entries were removed, so the installer can say so.
function removeLegacyHooks(settingsPath, prevHooks) {
  if (!settingsPath || !prevHooks) return 0;
  const { value, existed, malformed } = readJSONSafe(settingsPath);
  if (!existed || malformed) return 0;

  const settings = value;
  if (!settings.hooks || typeof settings.hooks !== 'object') return 0;

  let removed = 0;
  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event]) || !Array.isArray(prevHooks[event])) continue;
    const before = settings.hooks[event].length;
    settings.hooks[event] = removeDeepEqual(settings.hooks[event], prevHooks[event]);
    removed += before - settings.hooks[event].length;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  if (removed) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return removed;
}

// Removes the 1.x hook scripts and their directory, which 2.x no longer ships.
function removeLegacyHookFiles(hooksDir) {
  if (!hooksDir || !fs.existsSync(hooksDir)) return 0;
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(hooksDir, { withFileTypes: true })) {
      const full = path.join(hooksDir, entry.name);
      if (entry.isDirectory()) {
        removed += removeLegacyHookFiles(full);
        try { fs.rmdirSync(full); } catch (_) {}
      } else if (entry.name.endsWith('.js')) {
        fs.unlinkSync(full);
        removed++;
      }
    }
    if (fs.readdirSync(hooksDir).length === 0) fs.rmdirSync(hooksDir);
  } catch (_) { /* best effort — reported as a count either way */ }
  return removed;
}

// ---------------------------------------------------------------------------
// Pipeline scripts
//
// These are copied into the install target rather than referenced in place:
// `npx` unpacks this package into a transient, hash-keyed cache that npm
// garbage-collects, so nothing installed may ever point back at it.
// ---------------------------------------------------------------------------
function installScriptFiles(scriptsDestDir) {
  const installed = [];
  function copyDir(srcDir, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else if (entry.name.endsWith('.js')) {
        fs.copyFileSync(srcPath, destPath);
        try { fs.chmodSync(destPath, 0o755); } catch (_) { /* Windows */ }
        installed.push(destPath);
      }
    }
  }
  copyDir(SCRIPTS_SRC, scriptsDestDir);
  return installed;
}

// ---------------------------------------------------------------------------
// Permissions
//
// The pipeline runs `node <scriptsDir>/<script>.js`, which Claude Code gates
// behind Bash approval. Pre-allowing exactly that directory keeps an ingestion
// run from prompting once per document.
//
// This entry is deliberately fail-open: it is declarative, executes nothing,
// and carries no correctness weight. If the merge fails, or a user strips it,
// the pipeline still works — it just asks first. That is the opposite of the
// hooks this replaced, which were load-bearing and failed closed.
// ---------------------------------------------------------------------------
function buildDocSearchPermissions(runtime) {
  return [`Bash(node ${runtime.scriptsRef()}/*)`];
}

function mergePermissionsIntoSettings(settingsPath, newPerms, prevPerms) {
  const { value, existed, malformed } = readJSONSafe(settingsPath);
  if (malformed) {
    throw new Error(`${settingsPath} exists but is not valid JSON — refusing to modify it. Fix or remove the file, then re-run install.`);
  }
  const settings = existed ? value : {};
  settings.permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};

  let allow = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
  if (Array.isArray(prevPerms)) allow = allow.filter(p => !prevPerms.includes(p));
  for (const p of newPerms) if (!allow.includes(p)) allow.push(p);

  if (allow.length) settings.permissions.allow = allow;
  else delete settings.permissions.allow;
  if (Object.keys(settings.permissions).length === 0) delete settings.permissions;

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------
function install(runtime) {
  const commandsDir  = runtime.commandsDir();
  const manifestPath = runtime.manifestPath();
  const contextRef   = runtime.contextRef();
  const scriptsRef   = runtime.scriptsRef();

  // If a previous install manifest exists, remove those files first (clean reinstall)
  let prevHooks = null;
  let prevPermissions = null;
  if (fs.existsSync(manifestPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      prevHooks = prev.hooks || null;
      prevPermissions = prev.permissions || null;
      for (const f of (prev.files || [])) {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f);
          removeEmptyDirsUntil(path.dirname(f), prev.commandsDir || commandsDir);
        }
      }
      // Remove the old commands dir if it is now empty and different from the new target
      if (prev.commandsDir && prev.commandsDir !== commandsDir && fs.existsSync(prev.commandsDir)) {
        try {
          if (fs.readdirSync(prev.commandsDir).length === 0) fs.rmdirSync(prev.commandsDir);
        } catch (_) {}
      }
    } catch (_) {}
  }

  fs.mkdirSync(commandsDir, { recursive: true });

  const installedFiles = [];

  for (const file of fs.readdirSync(SKILLS_SRC)) {
    if (!file.endsWith('.md')) continue;

    const srcPath = path.join(SKILLS_SRC, file);
    let content = fs.readFileSync(srcPath, 'utf8');
    let destPath;

    // Patch runtime paths before any branch — context.md carries script
    // invocations of its own, so it needs the same treatment as a skill.
    content = content.split(TOKEN_CONTEXT).join(contextRef);
    content = content.split(TOKEN_SCRIPTS).join(scriptsRef);
    content = content.split(LEGACY_CONTEXT_PATH).join(contextRef);

    if (file === 'context.md') {
      if (runtime.isCodex) {
        // Codex: shared support material lives in a non-skill folder.
        const contextDir = path.join(commandsDir, 'docSearch-context');
        fs.mkdirSync(contextDir, { recursive: true });
        destPath = path.join(contextDir, 'context.md');
        fs.writeFileSync(destPath, content);
      } else {
        // Claude: lives in the namespace dir alongside skills.
        // Prepend frontmatter so it does not appear as /docSearch:context in the menu.
        const suppressed = '---\nuser-invocable: false\ndisable-model-invocation: true\n---\n\n' + content;
        destPath = path.join(commandsDir, 'context.md');
        fs.writeFileSync(destPath, suppressed);
      }
    } else {
      // Claude: bare filename, namespace comes from parent dir  e.g. query.md -> /docSearch:query
      // Codex:  prefixed skill directory with SKILL.md           e.g. docSearch-query/SKILL.md
      if (runtime.isCodex) {
        const skillName = 'docSearch-' + file.replace(/\.md$/, '');
        const skillDir = path.join(commandsDir, skillName);
        fs.mkdirSync(skillDir, { recursive: true });
        content = setFrontmatterName(content, skillName);
        destPath = path.join(skillDir, 'SKILL.md');
      } else {
        destPath = path.join(commandsDir, file);
      }
      fs.writeFileSync(destPath, content);
    }

    try { fs.chmodSync(destPath, 0o644); } catch (_) { /* Windows */ }
    installedFiles.push(destPath);
  }

  // Pipeline scripts: identical on every runtime. This is what makes Claude and
  // Codex produce the same artifacts — the structural work lives here, not in
  // an agent's reading of prose.
  const scriptsDir = runtime.scriptsDir();
  const scriptFiles = installScriptFiles(scriptsDir);
  installedFiles.push(...scriptFiles);

  // Claude-only settings work. Codex has no settings.json equivalent here, and
  // needs none: correctness lives in the scripts, identically on both runtimes.
  let settingsPath = null;
  let newPermissions = null;
  let legacyHooksRemoved = 0;
  if (!runtime.isCodex) {
    settingsPath = runtime.settingsPath();

    // Upgrading from 1.x: strip the old hook entries and their scripts.
    legacyHooksRemoved = removeLegacyHooks(settingsPath, prevHooks);
    removeLegacyHookFiles(runtime.hooksDir());

    // Best-effort: a failure here costs approval prompts, never correctness,
    // so it must not abort an otherwise-good install.
    try {
      newPermissions = buildDocSearchPermissions(runtime);
      mergePermissionsIntoSettings(settingsPath, newPermissions, prevPermissions);
    } catch (err) {
      newPermissions = null;
      console.log('\n    ' + yellow('Note: could not pre-approve the scripts directory in settings.json (' + err.message + ').'));
      console.log('    ' + dim('docSearch still works — you will be asked to approve script runs.'));
    }
  }

  // Write manifest for clean uninstall / reinstall
  const manifest = {
    version:      PKG.version,
    timestamp:    new Date().toISOString(),
    runtime:      runtime.key,
    commandsDir:  commandsDir,
    scriptsDir:   scriptsDir,
    files:        installedFiles,
    permissions:  newPermissions,
    settingsPath: settingsPath,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    commandsDir,
    scriptsDir,
    installedFiles,
    scriptCount: scriptFiles.length,
    manifestPath,
    legacyHooksRemoved,
    permissionsAdded: !!newPermissions,
    settingsPath,
  };
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------
function prompt(question) {
  const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => iface.question(question, a => { iface.close(); resolve(a.trim()); }));
}

function parseMultiChoice(answer, max) {
  const parts = (answer || '').trim().split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return null;
  const indices = [];
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (isNaN(n) || n < 1 || n > max) return null;
    if (!indices.includes(n - 1)) indices.push(n - 1);
  }
  return indices.length ? indices : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n' + bold('docSearch Skills Installer') + '\n');

  // -- Runtime selection
  console.log('  ' + yellow('Which runtime(s) would you like to install for?'));
  console.log('  ' + dim('Select multiple by separating numbers with spaces or commas.') + '\n');

  RUNTIMES.forEach((r, i) => {
    console.log('    ' + cyan(String(i + 1)) + '  ' + r.label + '  ' + dim(toTildePath(r.commandsDir())));
  });
  console.log();

  let selectedIndices;
  while (true) {
    const answer = await prompt('  Choice ' + dim('[1]') + ': ');
    const parsed = parseMultiChoice(answer || '1', RUNTIMES.length);
    if (parsed) { selectedIndices = parsed; break; }
    console.log('  ' + red('Invalid - enter numbers between 1 and ' + RUNTIMES.length + '.') + '\n');
  }

  const selected = selectedIndices.map(i => RUNTIMES[i]);

  // -- Confirm
  console.log('\n  ' + yellow('Install paths:'));
  for (const r of selected) {
    console.log('    ' + dim('*') + ' ' + r.label + '  ->  ' + dim(toTildePath(r.commandsDir())));
  }
  console.log();

  const confirm = await prompt('  Proceed? ' + dim('[y/N]') + ': ');
  if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
    console.log('\n  Aborted.\n'); process.exit(0);
  }

  // -- Install
  console.log();
  const results = [];

  for (const runtime of selected) {
    process.stdout.write('  Installing for ' + bold(runtime.label) + '...');
    try {
      const result = install(runtime);
      process.stdout.write(' ' + green('done') + '\n');
      results.push({ runtime, ...result, ok: true });
    } catch (err) {
      process.stdout.write(' ' + red('FAILED') + '\n');
      console.log('    ' + red(err.message));
      results.push({ runtime, ok: false, err });
    }
  }

  // -- Summary
  const ok     = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);

  if (ok.length) {
    console.log('\n  ' + bold(green('Done.')) + ' ' + ok.length + ' runtime' + (ok.length > 1 ? 's' : '') + ' installed.\n');

    for (const { runtime, commandsDir, scriptsDir, installedFiles, scriptCount, legacyHooksRemoved, permissionsAdded, settingsPath } of ok) {
      console.log('  ' + bold(runtime.label) + '  ' + dim(toTildePath(commandsDir)) + '\n');
      for (const f of installedFiles) {
        // Scripts live outside commandsDir; showing them relative to it would
        // print a wall of `../..`. Count them instead, listed separately below.
        if (f.startsWith(scriptsDir)) continue;
        console.log('    + ' + dim(path.relative(commandsDir, f)));
      }
      console.log('    + ' + dim(scriptCount + ' pipeline script(s)') + '  ' + dim(toTildePath(scriptsDir)));

      console.log('');
      if (legacyHooksRemoved) {
        console.log('  ' + yellow('Removed ' + legacyHooksRemoved + ' docSearch 1.x hook entr' + (legacyHooksRemoved === 1 ? 'y' : 'ies') + ' from ' + toTildePath(settingsPath) + '.'));
        console.log('  ' + dim('Validation now runs inside the pipeline scripts, on every runtime, rather than'));
        console.log('  ' + dim('intercepting writes on one of them. Hooks you added yourself were not touched.'));
      }
      if (permissionsAdded) {
        console.log('  ' + dim('Scripts directory pre-approved in ' + toTildePath(settingsPath)));
      }
      console.log('\n  ' + dim('Verify the install: ') + cyan('node ' + runtime.scriptsRef() + '/selftest.js'));
      const pfx = runtime.isCodex ? 'docSearch-' : '/docSearch:';
      console.log('\n  Invoke as: ' + cyan(runtime.invoke) + '\n');
      console.log(dim(
        '    ' + pfx + 'onboard          - first-time setup\n' +
        '    ' + pfx + 'ingest           - add documents\n' +
        '    ' + pfx + 'query            - search your vault\n' +
        '    ' + pfx + 'config-update    - change settings\n' +
        '    ' + pfx + 'modify           - re-index a changed file\n' +
        '    ' + pfx + 'remove           - remove a document\n' +
        '    ' + pfx + 'rebuild-summary  - rebuild the document summary index\n' +
        '    ' + pfx + 'schema-migration - migrate schema after config changes\n' +
        '    ' + pfx + 'doctor           - read-only health check of the index\n' +
        '    ' + pfx + 'sync             - reconcile the index against the vault\n'
      ));
      console.log('  To uninstall: ' + cyan('npx docsearch-skills-uninstall') + '\n');
    }
  }

  if (failed.length) {
    console.log('  ' + red(failed.length + ' installation' + (failed.length > 1 ? 's' : '') + ' failed:'));
    for (const { runtime, err } of failed) {
      console.log('    x ' + runtime.label + ': ' + err.message);
    }
    console.log();
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Non-interactive (CI / piped)
//
// `--runtime <key>` selects targets without a prompt, comma-separated for
// several. Without it this defaults to claude-local, which is right for a
// piped `npx` but leaves the Codex half of the matrix unreachable from a
// script — and an install path that cannot be exercised in CI is one that
// breaks quietly.
// ---------------------------------------------------------------------------
function parseRuntimeFlag(argv) {
  const idx = argv.findIndex(a => a === '--runtime' || a.startsWith('--runtime='));
  if (idx === -1) return null;
  const raw = argv[idx].includes('=') ? argv[idx].split('=').slice(1).join('=') : argv[idx + 1];
  if (!raw) return null;
  const keys = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  const chosen = [];
  for (const key of keys) {
    const runtime = RUNTIMES.find(r => r.key === key);
    if (!runtime) {
      console.error(red(`\n  Unknown runtime "${key}". Valid: ${RUNTIMES.map(r => r.key).join(', ')}\n`));
      process.exit(2);
    }
    if (!chosen.includes(runtime)) chosen.push(runtime);
  }
  return chosen.length ? chosen : null;
}

const explicitRuntimes = parseRuntimeFlag(process.argv.slice(2));

if (explicitRuntimes || !process.stdin.isTTY) {
  const targets = explicitRuntimes || [RUNTIMES[0]];
  if (!explicitRuntimes) {
    console.log(yellow('\n  Non-interactive - defaulting to Claude Code local install.'));
    console.log(dim('  Use --runtime <' + RUNTIMES.map(r => r.key).join('|') + '> to choose.\n'));
  }
  let anyFailed = false;
  for (const runtime of targets) {
    try {
      const { commandsDir, installedFiles, scriptsDir } = install(runtime);
      console.log(green('  + ' + runtime.label + ': ' + installedFiles.length + ' files'));
      console.log(dim('      skills:  ' + commandsDir));
      console.log(dim('      scripts: ' + scriptsDir));
    } catch (err) {
      console.error(red('  x ' + runtime.label + ' failed: ' + err.message));
      anyFailed = true;
    }
  }
  console.log('');
  if (anyFailed) process.exit(1);
} else {
  main().catch(err => {
    console.error(red('\n  Error: ' + err.message + '\n'));
    process.exit(1);
  });
}
