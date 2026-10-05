/**
 * sennel/lib/progress.js
 *
 * Progress bar and logging utility for the build pipeline.
 *
 * Layout (TTY, non-verbose):
 *   [n/N] ████░░░░░░ nn%  step-name
 *   [step] log message ...
 *
 * The header line is pinned to the top using ANSI escape sequences.
 * In non-TTY or verbose mode, plain text is used instead.
 */

const BAR_WIDTH = 20;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Global progress instance, set during build pipeline. */
let _current = null;

/** Get the active progress instance (null if not in a pipeline). */
function getProgress() {
  return _current;
}

/**
 * Create a logger scoped to a command name.
 * Routes through the active progress instance if in a build pipeline,
 * otherwise writes directly to stderr.
 *
 * @param {string} prefix - Command name (e.g. "scan", "data")
 * @returns {{ log: (msg: string) => void, verbose: (msg: string) => void }}
 */
export function createLogger(prefix) {
  return {
    log(msg) {
      const p = _current;
      if (p) {
        p.log(`[${prefix}] ${msg}`);
      } else {
        process.stderr.write(`[${prefix}] ${msg}\n`);
      }
    },
    verbose(msg) {
      const p = _current;
      if (p) {
        p.verbose(`[${prefix}] ${msg}`);
      } else {
        process.stderr.write(`[${prefix}] ${msg}\n`);
      }
    },
  };
}

/**
 * Format elapsed milliseconds as human-readable string.
 * e.g. 1234 → "1.2s", 65432 → "1m 5s", 3661000 → "1h 1m 1s"
 */
function formatElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m ${rs}s`;
}

/**
 * @param {{ label: string, weight: number }[]} steps
 * @param {{ verbose?: boolean }} opts
 */
export function createProgress(steps, { verbose = false, title = "" } = {}) {
  const isTTY = process.stderr.isTTY;
  const useBar = isTTY && !verbose;
  const totalWeight = steps.reduce((s, st) => s + st.weight, 0);
  let doneWeight = 0;
  let currentIdx = -1;
  let started = false;
  let spinnerFrame = 0;
  let spinnerTimer = null;
  let stepStartTime = null;
  const pipelineStartTime = Date.now();

  function renderBar(stepIdx, weight, spinner) {
    const pct = Math.round((weight / totalWeight) * 100);
    const filled = Math.round((weight / totalWeight) * BAR_WIDTH);
    const bar = "\u2588".repeat(filled) + "\u2591".repeat(BAR_WIDTH - filled);
    const label = steps[stepIdx]?.label || "";
    return `[${stepIdx + 1}/${steps.length}] ${bar} ${String(pct).padStart(3)}%  ${label} ${spinner}`;
  }

  function updateHeader(text) {
    const row = title ? 3 : 1;
    process.stderr.write(
      "\x1b[s"               // save cursor
      + `\x1b[${row};1H`    // move to header row
      + "\x1b[2K"            // clear line
      + "  " + text
      + "\x1b[u",            // restore cursor
    );
  }

  function startSpinner() {
    stopSpinner();
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      if (currentIdx >= 0) {
        updateHeader(renderBar(currentIdx, doneWeight, SPINNER_FRAMES[spinnerFrame]));
      }
    }, 80);
    spinnerTimer.unref();
  }

  function stopSpinner() {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  }

  function initScreen() {
    if (started) return;
    started = true;
    if (useBar) {
      process.stderr.write("\x1b[2J\x1b[1;1H"); // clear screen
      if (title) {
        process.stderr.write("  \x1b[1m" + title + "\x1b[0m\n");
        process.stderr.write("\n\n\n"); // reserve lines (blank + bar + gap)
      } else {
        process.stderr.write("\n\n"); // reserve 2 lines (header + gap)
      }
    }
  }

  const instance = {
    /**
     * Begin a new step.
     * @param {string} label - Step name (must match a steps[].label)
     */
    start(label) {
      initScreen();
      const idx = steps.findIndex((s) => s.label === label);
      if (idx === -1) return;
      currentIdx = idx;
      stepStartTime = Date.now();

      if (useBar) {
        updateHeader(renderBar(idx, doneWeight, SPINNER_FRAMES[0]));
        startSpinner();
      }
    },

    /**
     * Print a log line (always visible).
     * @param {string} msg
     */
    log(msg) {
      if (useBar) {
        process.stderr.write("  " + msg + "\n");
      } else {
        process.stderr.write(msg + "\n");
      }
    },

    /**
     * Print a verbose-only log line.
     * @param {string} msg
     */
    verbose(msg) {
      if (!verbose) return;
      process.stderr.write(msg + "\n");
    },

    /**
     * Mark the current step as done and advance the weight counter.
     */
    stepDone() {
      if (currentIdx >= 0 && currentIdx < steps.length) {
        const label = steps[currentIdx].label;
        const elapsed = stepStartTime ? formatElapsed(Date.now() - stepStartTime) : "";
        doneWeight += steps[currentIdx].weight;
        if (useBar) {
          stopSpinner();
          updateHeader(renderBar(currentIdx, doneWeight, "\u2713"));
        }
        instance.log(`[${label}] done (${elapsed})`);
      }
    },

    /**
     * Mark the entire pipeline as complete.
     */
    done() {
      stopSpinner();
      if (useBar) {
        const bar = "\u2588".repeat(BAR_WIDTH);
        const row = title ? 3 : 1;
        process.stderr.write(
          "\x1b[s"
          + `\x1b[${row};1H`
          + "\x1b[2K"
          + `  [${steps.length}/${steps.length}] ${bar} 100%  done \u2713`
          + "\x1b[u\n",
        );
      }
      if (pipelineStartTime) {
        instance.log(`total: ${formatElapsed(Date.now() - pipelineStartTime)}`);
      }
      _current = null;
    },
  };

  _current = instance;
  return instance;
}
