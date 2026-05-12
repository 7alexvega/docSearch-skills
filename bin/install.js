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
const SKILLS_SRC = path.join(__dirname, '..', 'skills', 'docSearch');

// Pattern in source skill files that gets replaced with the correct context path
const CONTEXT_SRC_PATH = '.claude/skills/docSearch/context.md';

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
// Claude runtimes:
//   commandsDir  - .claude/commands/docSearch/  (namespace dir, gives /docSearch:<skill>)
//   contextRef   - null  (skills use ${CLAUDE_SKILL_DIR}/context.md, no patching needed)
//   isCodex      - false
//
// Codex runtimes:
//   commandsDir  - .codex/skills/  (skill folders get docSearch- prefix)
//   contextRef   - path string patched into each skill Step 0
//   isCodex      - true
// ---------------------------------------------------------------------------
const RUNTIMES = [
  {
    key:          'claude-local',
    label:        'Claude Code - local project',
    commandsDir:  () => path.join(process.cwd(), '.claude', 'commands', 'docSearch'),
    manifestPath: () => path.join(process.cwd(), '.claude', MANIFEST_FILENAME),
    contextRef:   null,
    isCodex:      false,
    invoke:       '/docSearch:<skill>',
  },
  {
    key:          'claude-global',
    label:        'Claude Code - global (all projects)',
    commandsDir:  () => path.join(getClaudeGlobalDir(), 'commands', 'docSearch'),
    manifestPath: () => path.join(getClaudeGlobalDir(), MANIFEST_FILENAME),
    contextRef:   null,
    isCodex:      false,
    invoke:       '/docSearch:<skill>',
  },
  {
    key:          'codex-local',
    label:        'Codex - local project',
    commandsDir:  () => path.join(process.cwd(), '.codex', 'skills'),
    manifestPath: () => path.join(process.cwd(), '.codex', MANIFEST_FILENAME),
    contextRef:   () => '.codex/skills/docSearch-context/context.md',
    isCodex:      true,
    invoke:       'docSearch-<skill>',
  },
  {
    key:          'codex-global',
    label:        'Codex - global (all projects)',
    commandsDir:  () => path.join(getCodexGlobalDir(), 'skills'),
    manifestPath: () => path.join(getCodexGlobalDir(), MANIFEST_FILENAME),
    contextRef:   () => toTildePath(path.join(getCodexGlobalDir(), 'skills', 'docSearch-context', 'context.md')),
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
// Install
// ---------------------------------------------------------------------------
function install(runtime) {
  const commandsDir  = runtime.commandsDir();
  const manifestPath = runtime.manifestPath();
  const contextRef   = runtime.isCodex
    ? runtime.contextRef()
    : '${CLAUDE_SKILL_DIR}/context.md';

  // If a previous install manifest exists, remove those files first (clean reinstall)
  if (fs.existsSync(manifestPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
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
      // Skill file: patch the context path reference then write
      content = content.split(CONTEXT_SRC_PATH).join(contextRef);

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

  // Write manifest for clean uninstall / reinstall
  const manifest = {
    version:     PKG.version,
    timestamp:   new Date().toISOString(),
    runtime:     runtime.key,
    commandsDir: commandsDir,
    files:       installedFiles,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { commandsDir, installedFiles, manifestPath };
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

    for (const { runtime, commandsDir, installedFiles } of ok) {
      console.log('  ' + bold(runtime.label) + '  ' + dim(toTildePath(commandsDir)) + '\n');
      for (const f of installedFiles) {
        console.log('    + ' + dim(path.relative(commandsDir, f)));
      }
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
        '    ' + pfx + 'schema-migration - migrate schema after config changes\n'
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
// Non-interactive fallback (CI / piped)
// ---------------------------------------------------------------------------
if (!process.stdin.isTTY) {
  console.log(yellow('\n  Non-interactive - defaulting to Claude Code local install.\n'));
  try {
    const { commandsDir, installedFiles } = install(RUNTIMES[0]);
    console.log(green('  + Installed ' + installedFiles.length + ' files to ' + commandsDir + '\n'));
  } catch (err) {
    console.error(red('  x Install failed: ' + err.message + '\n'));
    process.exit(1);
  }
} else {
  main().catch(err => {
    console.error(red('\n  Error: ' + err.message + '\n'));
    process.exit(1);
  });
}
