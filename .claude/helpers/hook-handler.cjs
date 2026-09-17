#!/usr/bin/env node
/**
 * Claude Flow Hook Handler (Cross-Platform)
 * Dispatches hook events to the appropriate helper modules.
 *
 * Usage: node hook-handler.cjs <command> [args...]
 *
 * Commands:
 *   route          - Route a task to optimal agent (reads PROMPT from env/stdin)
 *   pre-bash       - Validate command safety before execution
 *   post-edit      - Record edit outcome for learning
 *   session-restore - Restore previous session state
 *   session-end    - End session and persist state
 *
 * Output Protocol:
 *   All stdout output is a single JSON object of the form:
 *     { "continue": true }
 *     { "continue": false, "stopReason": "<explanation>" }
 */

const path = require("path");
const fs = require("fs");

const helpersDir = __dirname;

// Emit the hook decision as a stringified JSON line and return it so callers
// can short-circuit. `continue: true` means proceed; `continue: false` halts
// with `stopReason` shown to the user.
function emitProceed() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
}

function emitStop(stopReason) {
  process.stdout.write(JSON.stringify({ continue: false, stopReason: String(stopReason) }) + "\n");
}

// Safe require with stdout suppression - the helper modules have CLI
// sections that run unconditionally on require(), so we mute console
// during the require to prevent noisy output.
function safeRequire(modulePath) {
  try {
    if (fs.existsSync(modulePath)) {
      const origLog = console.log;
      const origError = console.error;
      console.log = () => {};
      console.error = () => {};
      try {
        const mod = require(modulePath);
        return mod;
      } finally {
        console.log = origLog;
        console.error = origError;
      }
    }
  } catch (e) {
    // silently fail
  }
  return null;
}

const router = safeRequire(path.join(helpersDir, "router.js"));
const session = safeRequire(path.join(helpersDir, "session.js"));
const memory = safeRequire(path.join(helpersDir, "memory.js"));
const intelligence = safeRequire(path.join(helpersDir, "intelligence.cjs"));

// Mute helper-module console output so only our JSON decision reaches stdout.
const noop = () => {};
console.log = noop;
console.error = noop;
console.info = noop;
console.warn = noop;

// Get the command from argv
const [, , command, ...args] = process.argv;

// Read stdin with timeout — Claude Code sends hook data as JSON via stdin.
// Timeout prevents hanging when stdin is not properly closed (common on Windows).
async function readStdin() {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(data);
    }, 500);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.resume();
  });
}

async function main() {
  let stdinData = "";
  try {
    stdinData = await readStdin();
  } catch (e) {
    /* ignore stdin errors */
  }

  let hookInput = {};
  if (stdinData.trim()) {
    try {
      hookInput = JSON.parse(stdinData);
    } catch (e) {
      /* ignore parse errors */
    }
  }

  // Merge stdin data into prompt resolution: prefer stdin fields, then env, then argv
  const prompt =
    hookInput.prompt ||
    hookInput.command ||
    hookInput.toolInput ||
    process.env.PROMPT ||
    process.env.TOOL_INPUT_command ||
    args.join(" ") ||
    "";

  const handlers = {
    route: () => {
      // Best-effort: invoke router/intelligence for their side effects (memory
      // updates, pattern access counts) but discard their stdout — the hook's
      // only output is the JSON decision.
      if (intelligence && intelligence.getContext) {
        try {
          intelligence.getContext(prompt);
        } catch (e) {
          /* non-fatal */
        }
      }
      if (router && router.routeTask) {
        try {
          router.routeTask(prompt);
        } catch (e) {
          /* non-fatal */
        }
      }
      emitProceed();
    },

    "pre-bash": () => {
      const cmd = (hookInput.command || prompt).toLowerCase();
      const dangerous = ["rm -rf /", "format c:", "del /s /q c:\\", ":(){:|:&};:"];
      for (const d of dangerous) {
        if (cmd.includes(d)) {
          emitStop(`Dangerous command detected: ${d}`);
          return;
        }
      }
      emitProceed();
    },

    "post-edit": () => {
      if (session && session.metric) {
        try {
          session.metric("edits");
        } catch (e) {
          /* no active session */
        }
      }
      if (intelligence && intelligence.recordEdit) {
        try {
          const file =
            hookInput.file_path ||
            (hookInput.toolInput && hookInput.toolInput.file_path) ||
            process.env.TOOL_INPUT_file_path ||
            args[0] ||
            "";
          intelligence.recordEdit(file);
        } catch (e) {
          /* non-fatal */
        }
      }
      emitProceed();
    },

    "session-restore": () => {
      if (session) {
        try {
          const existing = session.restore && session.restore();
          if (!existing) {
            session.start && session.start();
          }
        } catch (e) {
          /* non-fatal */
        }
      }
      if (intelligence && intelligence.init) {
        try {
          intelligence.init();
        } catch (e) {
          /* non-fatal */
        }
      }
      emitProceed();
    },

    "session-end": () => {
      if (intelligence && intelligence.consolidate) {
        try {
          intelligence.consolidate();
        } catch (e) {
          /* non-fatal */
        }
      }
      if (session && session.end) {
        try {
          session.end();
        } catch (e) {
          /* non-fatal */
        }
      }
      emitProceed();
    },

    "pre-task": () => {
      if (session && session.metric) {
        try {
          session.metric("tasks");
        } catch (e) {
          /* no active session */
        }
      }
      if (router && router.routeTask && prompt) {
        try {
          router.routeTask(prompt);
        } catch (e) {
          /* non-fatal */
        }
      }
      emitProceed();
    },

    "post-task": () => {
      if (intelligence && intelligence.feedback) {
        try {
          intelligence.feedback(true);
        } catch (e) {
          /* non-fatal */
        }
      }
      emitProceed();
    },

    stats: () => {
      if (intelligence && intelligence.stats) {
        try {
          intelligence.stats(args.includes("--json"));
        } catch (e) {
          /* non-fatal */
        }
      }
      emitProceed();
    },
  };

  if (command && handlers[command]) {
    try {
      handlers[command]();
    } catch (e) {
      // Hooks should never crash Claude Code — surface the error as a
      // proceed (non-blocking) decision so subsequent hooks still run.
      emitProceed();
    }
  } else if (command) {
    // Unknown command — pass through without blocking.
    emitProceed();
  } else {
    emitStop(
      "Usage: hook-handler.cjs <route|pre-bash|post-edit|session-restore|session-end|pre-task|post-task|stats>"
    );
  }
}

// Hooks must ALWAYS exit 0 — Claude Code treats non-zero as "hook error"
// and skips all subsequent hooks for the event.
process.exitCode = 0;
main()
  .catch(() => {
    try {
      emitProceed();
    } catch (_) {}
  })
  .finally(() => {
    process.exit(0);
  });
