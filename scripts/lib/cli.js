'use strict';

// ---------------------------------------------------------------------------
// Shared CLI contract for every docSearch script.
//
// Exit codes are the whole interface an orchestrating skill needs:
//   0  success
//   1  the operation ran but its subject failed (validation errors, etc.)
//   2  the operation could not run (bad usage, unreadable file, missing config)
//
// stdout is ALWAYS a single JSON object and nothing else, so a skill can
// capture and parse it without stripping log noise. Anything human-facing goes
// to stderr.
// ---------------------------------------------------------------------------

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_ERROR = 2;

// Parses `--key value`, `--key=value`, and `--flag` into an object.
// Bare (non `--`) arguments collect into `_`.
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function note(message) {
  process.stderr.write(message + '\n');
}

// Wraps a script body so an unexpected throw still produces parseable stdout
// rather than a stack trace the calling skill has to interpret.
function run(main) {
  try {
    const result = main();
    const code = result && typeof result.exitCode === 'number' ? result.exitCode : EXIT_OK;
    if (result && result.payload !== undefined) emit(result.payload);
    process.exit(code);
  } catch (err) {
    emit({
      ok: false,
      error: {
        message: err && err.message ? err.message : String(err),
        code: (err && err.docsearchCode) || 'unexpected_error',
      },
    });
    process.exit(EXIT_ERROR);
  }
}

// A error carrying a stable machine-readable code, so skills can branch on the
// failure kind without pattern-matching prose.
function fail(code, message) {
  const err = new Error(message);
  err.docsearchCode = code;
  return err;
}

module.exports = { EXIT_OK, EXIT_FAILED, EXIT_ERROR, parseArgs, emit, note, run, fail };
