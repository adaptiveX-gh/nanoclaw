/**
 * Stdio MCP Server for NanoClaw FreqSwarm Integration
 * Provides 21 tools: 6 read-only for viewing strategy research reports,
 * 6 trigger tools for matrix sweeps, batch backtests, autoresearch batches, and job management,
 * 2 blocking execution tools (swarm_execute_sweep, swarm_execute_autoresearch),
 * 2 seed library tools for loading pre-built native sdna seed genomes,
 * 1 strategy library tool for listing available strategies,
 * 1 strategy scanner tool for determining mutation eligibility of non-sdna strategies,
 * 1 history tool for querying past autoresearch mutations on a strategy,
 * 2 graduation tools for applying per-archetype gates and staging keepers to roster.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const REPORT_DIR = process.env.SWARM_REPORT_DIR || '/workspace/extra/swarm-reports';

function log(message: string): void {
  console.error(`[SWARM] ${message}`);
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Pre-flight validation of seed genome schemas before submission.
 * Catches common agent mistakes that would otherwise only surface after
 * the job is queued, spawned, and Pydantic rejects it (full round-trip delay).
 */
function validateSeedGenomes(seedGenomes: any[]): string[] {
  const errors: string[] = [];
  for (let i = 0; i < seedGenomes.length; i++) {
    const sg = seedGenomes[i];
    const g = sg?.genome;
    if (!g) continue; // derived_subclass backend — no genome to validate

    const pfx = `seed_genomes[${i}].genome`;

    // identity.genome_id required
    if (!g.identity?.genome_id) {
      errors.push(`${pfx}.identity.genome_id: required (use a unique string or content hash)`);
    }

    // signal_stack conditions must use "column" and "value"
    if (Array.isArray(g.signal_stack)) {
      for (let s = 0; s < g.signal_stack.length; s++) {
        const signal = g.signal_stack[s];
        if (Array.isArray(signal.conditions)) {
          for (let c = 0; c < signal.conditions.length; c++) {
            const cond = signal.conditions[c];
            if (cond.field !== undefined && cond.column === undefined) {
              errors.push(`${pfx}.signal_stack[${s}].conditions[${c}]: use "column" not "field"`);
            } else if (cond.column === undefined) {
              errors.push(`${pfx}.signal_stack[${s}].conditions[${c}].column: required`);
            }
            if (cond.value_field !== undefined && cond.value === undefined) {
              errors.push(`${pfx}.signal_stack[${s}].conditions[${c}]: use "value" not "value_field"`);
            } else if (cond.value === undefined) {
              errors.push(`${pfx}.signal_stack[${s}].conditions[${c}].value: required (number or column name string)`);
            }
          }
        }
      }
    }

    // filters[].condition (singular, not conditions)
    if (Array.isArray(g.filters)) {
      for (let f = 0; f < g.filters.length; f++) {
        const filter = g.filters[f];
        if (filter.conditions !== undefined && filter.condition === undefined) {
          errors.push(`${pfx}.filters[${f}]: use "condition" (singular) not "conditions"`);
        }
        if (filter.condition) {
          if (filter.condition.field !== undefined && filter.condition.column === undefined) {
            errors.push(`${pfx}.filters[${f}].condition: use "column" not "field"`);
          }
          if (filter.condition.value === undefined) {
            errors.push(`${pfx}.filters[${f}].condition.value: required`);
          }
        }
      }
    }

    // risk_model.stoploss must be a negative number
    if (g.risk_model?.stoploss !== undefined) {
      if (typeof g.risk_model.stoploss === 'string') {
        errors.push(`${pfx}.risk_model.stoploss: must be a negative float (e.g. -0.05), got string "${g.risk_model.stoploss}"`);
      } else if (typeof g.risk_model.stoploss === 'number' && g.risk_model.stoploss > 0) {
        errors.push(`${pfx}.risk_model.stoploss: must be negative (e.g. -0.05), got ${g.risk_model.stoploss}`);
      }
    }

    // hyperoptable_parameters must have param_type, min_val, max_val, default, space
    if (Array.isArray(g.hyperoptable_parameters)) {
      for (let h = 0; h < g.hyperoptable_parameters.length; h++) {
        const hp = g.hyperoptable_parameters[h];
        if (!hp.param_type) {
          errors.push(`${pfx}.hyperoptable_parameters[${h}].param_type: required ("int", "float", or "categorical")`);
        }
        if (hp.min_val === undefined && hp.param_type !== 'categorical') {
          errors.push(`${pfx}.hyperoptable_parameters[${h}].min_val: required for ${hp.param_type || 'numeric'} params`);
        }
        if (hp.max_val === undefined && hp.param_type !== 'categorical') {
          errors.push(`${pfx}.hyperoptable_parameters[${h}].max_val: required for ${hp.param_type || 'numeric'} params`);
        }
      }
    }
  }
  return errors;
}

const server = new McpServer({ name: 'swarm', version: '1.0.0' });

// ─── Report Reading ──────────────────────────────────────────────────

server.tool(
  'swarm_latest_report',
  'Read the latest morning report leaderboard (Markdown format). Shows ranked strategies from the most recent overnight screening run.',
  {},
  async () => {
    try {
      const content = readFile(path.join(REPORT_DIR, 'latest', 'leaderboard.md'));
      if (!content) {
        return err('No leaderboard report found. Has the swarm run completed? Check swarm_run_status for details.');
      }
      log('Read latest leaderboard.md');
      return ok(content);
    } catch (e) {
      return err(`Failed to read report: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_leaderboard',
  'Read the latest leaderboard as structured JSON. Contains total_screened, top_k count, and ranked strategy entries with metrics (sharpe, sortino, max_drawdown, profit_factor, win_rate, composite_score).',
  {},
  async () => {
    try {
      const content = readFile(path.join(REPORT_DIR, 'latest', 'leaderboard.json'));
      if (!content) {
        return err('No leaderboard data found. Has the swarm run completed?');
      }
      const data = JSON.parse(content);
      log(`Read leaderboard: ${data.total_screened || 0} screened, ${data.top_k || 0} in top-K`);
      return ok(data);
    } catch (e) {
      return err(`Failed to read leaderboard: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_run_status',
  'Check the status of the latest swarm run. Returns status (running/completed/failed), timestamps, program name, and task statistics.',
  {},
  async () => {
    try {
      const content = readFile(path.join(REPORT_DIR, 'latest', 'status.json'));
      if (!content) {
        return err('No status file found. No swarm run has been started yet.');
      }
      const data = JSON.parse(content);
      log(`Run status: ${data.status} (program=${data.program || 'unknown'})`);
      return ok(data);
    } catch (e) {
      return err(`Failed to read status: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_list_runs',
  'List all archived swarm runs with their timestamps. Returns an array of run IDs (ISO timestamps) sorted newest first.',
  {},
  async () => {
    try {
      const runsDir = path.join(REPORT_DIR, 'runs');
      if (!fs.existsSync(runsDir)) {
        return ok({ runs: [], message: 'No archived runs yet.' });
      }
      const entries = fs.readdirSync(runsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort()
        .reverse();
      log(`Listed ${entries.length} archived runs`);
      return ok({ runs: entries, total: entries.length });
    } catch (e) {
      return err(`Failed to list runs: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_run_details',
  'Get detailed results for a specific archived run by its ID (ISO timestamp). Returns the leaderboard JSON and status for that run.',
  {
    run_id: z.string().describe('Run ID (ISO timestamp, e.g. "2026-03-17T02:00:00Z"). Get available IDs from swarm_list_runs.'),
  },
  async (args) => {
    try {
      const runDir = path.join(REPORT_DIR, 'runs', args.run_id);
      if (!fs.existsSync(runDir)) {
        return err(`Run not found: ${args.run_id}. Use swarm_list_runs to see available runs.`);
      }
      const leaderboard = readFile(path.join(runDir, 'leaderboard.json'));
      const status = readFile(path.join(runDir, 'status.json'));
      const result: Record<string, unknown> = { run_id: args.run_id };
      if (leaderboard) result.leaderboard = JSON.parse(leaderboard);
      if (status) result.status = JSON.parse(status);
      log(`Read run details: ${args.run_id}`);
      return ok(result);
    } catch (e) {
      return err(`Failed to read run details: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_health',
  'Check swarm health: report directory, recent data freshness, and last 5 triggered job outcomes. Returns swarm_likely_broken=true if the last 3 jobs all failed (infrastructure may need restart). Use before triggering new jobs.',
  {},
  async () => {
    try {
      const health: Record<string, unknown> = {
        report_dir: REPORT_DIR,
        exists: fs.existsSync(REPORT_DIR),
      };

      if (health.exists) {
        const latestDir = path.join(REPORT_DIR, 'latest');
        health.latest_dir_exists = fs.existsSync(latestDir);

        const statusPath = path.join(latestDir, 'status.json');
        if (fs.existsSync(statusPath)) {
          const stat = fs.statSync(statusPath);
          const ageMs = Date.now() - stat.mtimeMs;
          const ageHours = Math.round(ageMs / 3600000 * 10) / 10;
          health.last_status_age_hours = ageHours;
          health.last_status_fresh = ageHours < 48;

          const content = readFile(statusPath);
          if (content) {
            const data = JSON.parse(content);
            health.last_run_status = data.status;
            health.last_run_program = data.program;
          }
        } else {
          health.last_status_age_hours = null;
          health.last_status_fresh = false;
        }

        const runsDir = path.join(REPORT_DIR, 'runs');
        if (fs.existsSync(runsDir)) {
          const runs = fs.readdirSync(runsDir, { withFileTypes: true })
            .filter(d => d.isDirectory());
          health.total_archived_runs = runs.length;
        } else {
          health.total_archived_runs = 0;
        }

        // Scan recent triggered job statuses for failure pattern detection
        const requestDir = path.join(REPORT_DIR, 'requests');
        if (fs.existsSync(requestDir)) {
          const statusFiles = fs.readdirSync(requestDir)
            .filter(f => f.endsWith('.status.json'))
            .sort().reverse()   // newest first (timestamp in run_id)
            .slice(0, 5);

          const recentJobs = statusFiles.map(f => {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(requestDir, f), 'utf-8'));
              return {
                run_id: data.run_id || f.replace('.status.json', ''),
                status: data.status,
                finished_at: data.finished_at,
                exit_code: data.exit_code,
                error: data.error?.slice(0, 200),
                common_error: data.common_error,
              };
            } catch {
              return { run_id: f.replace('.status.json', ''), status: 'unknown' };
            }
          });

          health.recent_jobs = recentJobs;
          const recentFailures = recentJobs.filter(j => j.status === 'failed').length;
          health.consecutive_failures = recentFailures;
          // All recent jobs failed → swarm may be broken
          health.swarm_likely_broken = recentJobs.length >= 3
            && recentJobs.slice(0, 3).every(j => j.status === 'failed');
        } else {
          health.recent_jobs = [];
          health.consecutive_failures = 0;
          health.swarm_likely_broken = false;
        }
      }

      log(`Health check: exists=${health.exists}, fresh=${health.last_status_fresh}, likely_broken=${health.swarm_likely_broken}`);
      return ok(health);
    } catch (e) {
      return err(`Health check failed: ${(e as Error).message}`);
    }
  },
);

// ─── Trigger Tools ──────────────────────────────────────────────────

const REQUEST_DIR = path.join(REPORT_DIR, 'requests');

server.tool(
  'swarm_selftest',
  'Run a minimal smoke test (BTC/USDT:USDT, 1h, 1 WF window, SampleStrategy) to verify the swarm pipeline works end-to-end. Returns a run_id — poll with swarm_poll_run. Takes ~2-3 minutes. Use when swarm_health shows swarm_likely_broken=true.',
  {},
  async () => {
    try {
      const runId = `selftest_${Date.now()}`;
      fs.mkdirSync(REQUEST_DIR, { recursive: true });

      const spec = {
        genome: {
          identity: { genome_id: `selftest_${Date.now()}`, name: 'BbandsRsiAdx', version: '1.0' },
        },
        pairs: ['BTC/USDT:USDT'],
        timeframes: ['1h', '4h'],
        timerange: '20250901-20260301',
        n_walkforward_windows: 2,
        skip_hyperopt: true,
        exchange: 'binance',
        strategy_path: 'data/user_data/strategies/BbandsRsiAdx.py',
        enable_audits: false,
      };

      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.spec.json`),
        JSON.stringify(spec, null, 2),
      );
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.request.json`),
        JSON.stringify({
          run_id: runId,
          run_type: 'selftest',
          submitted_at: new Date().toISOString(),
          workers: 1,
          priority: 'high',
          group_folder: process.env.GROUP_FOLDER || '',
          chat_jid: process.env.NANOCLAW_CHAT_JID || '',
        }, null, 2),
      );

      log(`Self-test submitted: ${runId}`);
      return ok({
        run_id: runId,
        status: 'submitted',
        message: 'Self-test submitted. Poll with swarm_poll_run. Expected ~2-3 min.',
      });
    } catch (e) {
      return err(`Failed to submit self-test: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_trigger_run',
  'Submit a matrix sweep or nightly run request. Writes a spec JSON to the request queue; the host-side runner picks it up and spawns the FreqSwarm process with the specified worker count. Returns a run_id for polling with swarm_poll_run.',
  {
    spec_json: z.string().describe('MatrixSweepSpec JSON string (genome, pairs, timeframes, n_walkforward_windows)'),
    run_type: z.string().optional().describe('Run type: "matrix_sweep" (default) or "nightly"'),
    workers: z.number().optional().describe('Parallel worker count: 4 for small sweeps (≤50 combos), 6 for medium, 8 for large (100+). Default 4, max 8.'),
    priority: z.string().optional().describe('Queue priority: "high" for interactive user requests (jumps queue), "normal" for scheduled/background. Default "normal".'),
  },
  async (args) => {
    try {
      // Validate JSON
      const spec = JSON.parse(args.spec_json);

      // Structural validation — catch bad specs before writing to disk
      const validationErrors: string[] = [];
      if (!spec.genome || typeof spec.genome !== 'object') {
        validationErrors.push('Missing "genome" object');
      } else if (!spec.genome.identity || typeof spec.genome.identity !== 'object') {
        validationErrors.push('Missing "genome.identity" object');
      } else {
        if (!spec.genome.identity.name || typeof spec.genome.identity.name !== 'string') {
          validationErrors.push('Missing or empty "genome.identity.name"');
        }
        if (!spec.genome.identity.genome_id || typeof spec.genome.identity.genome_id !== 'string') {
          validationErrors.push('Missing or empty "genome.identity.genome_id"');
        }
      }
      if (!Array.isArray(spec.pairs) || spec.pairs.length === 0) {
        validationErrors.push('Missing or empty "pairs" array');
      }
      if (!Array.isArray(spec.timeframes) || spec.timeframes.length === 0) {
        validationErrors.push('Missing or empty "timeframes" array');
      }
      if (validationErrors.length > 0) {
        return err(`Invalid sweep spec: ${validationErrors.join('; ')}. Fix the spec and resubmit.`);
      }

      const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      fs.mkdirSync(REQUEST_DIR, { recursive: true });

      // Write spec file
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.spec.json`),
        JSON.stringify(spec, null, 2),
      );

      // Write request manifest with workers and priority
      const workers = Math.min(Math.max(args.workers || 4, 1), 8);
      const priority = args.priority === 'high' ? 'high' : 'normal';
      const manifest = {
        run_id: runId,
        run_type: args.run_type || 'matrix_sweep',
        submitted_at: new Date().toISOString(),
        workers,
        priority,
        group_folder: process.env.GROUP_FOLDER || '',
        chat_jid: process.env.NANOCLAW_CHAT_JID || '',
      };
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.request.json`),
        JSON.stringify(manifest, null, 2),
      );

      log(`Trigger: submitted ${runId} (type=${manifest.run_type}, workers=${workers}, priority=${priority})`);
      return ok({ run_id: runId, status: 'submitted', workers, priority, message: 'Request queued. You\'ll be notified when it completes.' });
    } catch (e) {
      return err(`Failed to submit run: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_poll_run',
  'Check the status of a submitted swarm run by its run_id. Returns status (queued/running/completed/failed), exit code, timestamps, and common_error (if most tasks failed with the same root cause). For completed jobs, includes report_dir path — use swarm_job_results to read full results.',
  {
    run_id: z.string().describe('Run ID returned by swarm_trigger_run'),
  },
  async (args) => {
    try {
      const statusPath = path.join(REQUEST_DIR, `${args.run_id}.status.json`);
      if (!fs.existsSync(statusPath)) {
        // Check if request exists but hasn't been picked up yet
        const requestPath = path.join(REQUEST_DIR, `${args.run_id}.request.json`);
        if (fs.existsSync(requestPath)) {
          return ok({ run_id: args.run_id, status: 'queued', message: 'Request is queued but not yet started by the host runner.' });
        }
        return err(`Run not found: ${args.run_id}. Use swarm_trigger_run to submit a new run.`);
      }

      const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      log(`Poll: ${args.run_id} → ${status.status}`);
      return ok(status);
    } catch (e) {
      return err(`Failed to poll run: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_job_results',
  'Read the full results of a completed swarm job. Works for all job types: matrix sweep (returns results[], top_k, heatmap), autoresearch (returns keepers[], rejects[], mutation_family_stats), and batch backtest (returns results[]). Call after swarm_poll_run shows status=completed.',
  {
    run_id: z.string().describe('Run ID returned by swarm_trigger_run, swarm_trigger_autoresearch, or swarm_trigger_batch_backtest'),
  },
  async (args) => {
    try {
      // First check status to get report_dir
      const statusPath = path.join(REQUEST_DIR, `${args.run_id}.status.json`);
      if (!fs.existsSync(statusPath)) {
        return err(`Run not found: ${args.run_id}. Use swarm_trigger_run to submit a new run.`);
      }

      const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      if (status.status !== 'completed') {
        return err(`Run ${args.run_id} is not completed (status: ${status.status}). Wait for completion before reading results.`);
      }

      if (!status.report_dir) {
        return err(`Run ${args.run_id} completed but has no report_dir. Check exit code: ${status.exit_code}`);
      }

      // Read results.json from report dir
      const resultsPath = path.join(status.report_dir, 'latest', 'results.json');
      const content = readFile(resultsPath);
      if (!content) {
        return err(`Results file not found at ${resultsPath}. The job may have failed to write output.`);
      }

      const results = JSON.parse(content);
      // Log summary appropriate to job type
      const runType = status.run_type || 'unknown';
      if (results.keepers !== undefined) {
        // Autoresearch result
        log(`Job results: ${args.run_id} (${runType}) — keepers=${results.keepers?.length || 0}, rejects=${results.rejects?.length || 0}, total_variants=${results.total_variants || 0}, status=${results.status}`);
      } else {
        // Matrix sweep or batch backtest result
        log(`Job results: ${args.run_id} (${runType}) — ${results.results?.length || 0} combinations, status=${results.status}`);
      }
      return ok(results);
    } catch (e) {
      return err(`Failed to read job results: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_cancel_run',
  'Cancel a running or queued swarm run by writing a cancel marker. The host runner will stop the process on next poll.',
  {
    run_id: z.string().describe('Run ID to cancel'),
  },
  async (args) => {
    try {
      const cancelPath = path.join(REQUEST_DIR, `${args.run_id}.cancel`);
      fs.mkdirSync(REQUEST_DIR, { recursive: true });
      fs.writeFileSync(cancelPath, JSON.stringify({ cancelled_at: new Date().toISOString() }));
      log(`Cancel: wrote cancel marker for ${args.run_id}`);
      return ok({ run_id: args.run_id, status: 'cancel_requested', message: 'Cancel marker written. The host runner will stop the process shortly.' });
    } catch (e) {
      return err(`Failed to cancel run: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_trigger_autoresearch',
  'Submit an autoresearch batch job that generates mutations from seed genomes, runs walk-forward validation on each variant in parallel, and classifies results as keepers or rejects. Returns a run_id for polling with swarm_poll_run. Use swarm_job_results to read the final keepers/rejects after completion.',
  {
    spec_json: z.string().describe('AutoresearchSpec JSON string. Required fields: seed_genomes (array of {genome, pair, timeframe, parent_sharpe}), mutations_per_genome (int), timerange (string). Optional: mutation_seed, allowed_families, max_mutations_per_variant, n_walkforward_windows, exchange, config_path, keeper_sharpe_threshold, parent_sharpe_gate, discard_hashes.'),
    workers: z.number().optional().describe('Parallel worker count (1-8). Default 4. Use 4 for ≤10 variants, 6 for 10-20, 8 for 20+.'),
    priority: z.string().optional().describe('Queue priority: "high" for interactive (jumps queue), "normal" for background. Default "normal".'),
  },
  async (args) => {
    try {
      // Validate JSON
      const spec = JSON.parse(args.spec_json);

      // Basic validation
      if (!spec.seed_genomes || !Array.isArray(spec.seed_genomes) || spec.seed_genomes.length === 0) {
        return err('spec_json must contain a non-empty seed_genomes array');
      }
      if (!spec.timerange) {
        return err('spec_json must contain a timerange (e.g. "20250101-20260301")');
      }

      // Validate each seed genome has required structure
      for (let i = 0; i < spec.seed_genomes.length; i++) {
        const sg = spec.seed_genomes[i];
        if (!sg.genome || typeof sg.genome !== 'object') {
          return err(`seed_genomes[${i}]: missing "genome" object`);
        }
        if (!sg.genome.identity?.name) {
          return err(`seed_genomes[${i}]: missing "genome.identity.name"`);
        }
        if (!sg.pair || typeof sg.pair !== 'string') {
          return err(`seed_genomes[${i}]: missing "pair" (string)`);
        }
        if (!sg.timeframe || typeof sg.timeframe !== 'string') {
          return err(`seed_genomes[${i}]: missing "timeframe" (string)`);
        }
      }

      // Deep schema validation — catch wrong field names before queuing
      const schemaErrors = validateSeedGenomes(spec.seed_genomes);
      if (schemaErrors.length > 0) {
        return err(`Genome schema errors (fix before resubmitting):\n${schemaErrors.join('\n')}`);
      }

      const runId = `ar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      fs.mkdirSync(REQUEST_DIR, { recursive: true });

      // Write spec file
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.spec.json`),
        JSON.stringify(spec, null, 2),
      );

      // Write request manifest
      const workers = Math.min(Math.max(args.workers || 4, 1), 8);
      const priority = args.priority === 'high' ? 'high' : 'normal';
      const totalVariants = spec.seed_genomes.length * (spec.mutations_per_genome || 7);
      const manifest = {
        run_id: runId,
        run_type: 'autoresearch',
        submitted_at: new Date().toISOString(),
        workers,
        priority,
        group_folder: process.env.GROUP_FOLDER || '',
        chat_jid: process.env.NANOCLAW_CHAT_JID || '',
      };
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.request.json`),
        JSON.stringify(manifest, null, 2),
      );

      log(`Autoresearch: submitted ${runId} (${spec.seed_genomes.length} seeds × ${spec.mutations_per_genome || 7} mutations = ~${totalVariants} variants, workers=${workers})`);
      return ok({
        run_id: runId,
        status: 'submitted',
        seeds: spec.seed_genomes.length,
        mutations_per_genome: spec.mutations_per_genome || 7,
        estimated_variants: totalVariants,
        workers,
        priority,
        message: 'Autoresearch job queued. Use swarm_poll_run to check progress, swarm_job_results to read keepers/rejects when done.',
      });
    } catch (e) {
      return err(`Failed to submit autoresearch: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_trigger_batch_backtest',
  'Submit a batch backtest triage job — runs MANY strategies through a single raw backtest each, in parallel. Designed for fast triage of large strategy pools (e.g. 255 strategies). Returns a run_id for polling with swarm_poll_run. Use swarm_job_results to read ranked results when done.',
  {
    strategies: z.array(z.string()).describe('Array of strategy class names to backtest. Strategies are resolved from the swarm library (~450 community + WolfClaw). Use swarm_list_strategies to see available names.'),
    timerange: z.string().describe('Backtest date range in YYYYMMDD-YYYYMMDD format'),
    pairs: z.array(z.string()).optional().describe('Trading pairs to test. Default: ["BTC/USDT:USDT"]'),
    timeframes: z.array(z.string()).optional().describe('Timeframes to test. Default: ["1h"]'),
    fee: z.number().optional().describe('Fee fraction (e.g. 0.001). Default: 0.001'),
    workers: z.number().optional().describe('Parallel worker count (1-8). Default 4. Use 6-8 for 100+ strategies.'),
    priority: z.string().optional().describe('Queue priority: "high" (jumps queue) or "normal". Default "normal".'),
  },
  async (args) => {
    try {
      if (args.strategies.length === 0) {
        return err('strategies array must not be empty');
      }

      const spec = {
        strategies: args.strategies,
        pairs: args.pairs || ['BTC/USDT:USDT'],
        timeframes: args.timeframes || ['1h'],
        timerange: args.timerange,
        fee: args.fee || 0.001,
        exchange: 'binance',
      };

      const nTasks = spec.strategies.length * spec.pairs.length * spec.timeframes.length;
      const runId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      fs.mkdirSync(REQUEST_DIR, { recursive: true });

      // Write spec file
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.spec.json`),
        JSON.stringify(spec, null, 2),
      );

      // Write request manifest
      const workers = Math.min(Math.max(args.workers || 4, 1), 8);
      const priority = args.priority === 'high' ? 'high' : 'normal';
      const manifest = {
        run_id: runId,
        run_type: 'batch_backtest',
        submitted_at: new Date().toISOString(),
        workers,
        priority,
        group_folder: process.env.GROUP_FOLDER || '',
        chat_jid: process.env.NANOCLAW_CHAT_JID || '',
      };
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.request.json`),
        JSON.stringify(manifest, null, 2),
      );

      log(`Batch backtest: submitted ${runId} (${spec.strategies.length} strategies, ${nTasks} tasks, workers=${workers})`);
      return ok({
        run_id: runId,
        status: 'submitted',
        strategies: spec.strategies.length,
        total_tasks: nTasks,
        workers,
        priority,
        message: 'Batch backtest queued. Use swarm_poll_run to check progress, swarm_job_results to read ranked results when done.',
      });
    } catch (e) {
      return err(`Failed to submit batch backtest: ${(e as Error).message}`);
    }
  },
);

// ─── Blocking Execution Tools ─────────────────────────────────────────
// These spawn `python -m src execute` and block until completion.
// Results are returned directly — no polling, no status files.

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
const execFileAsync = promisify(execFile);

const FREQSWARM_DIR = process.env.FREQSWARM_DIR || '/workspace/extra/freqswarm';
const EXECUTE_TIMEOUT_MS = parseInt(process.env.EXECUTE_TIMEOUT_MS || '2700000', 10); // 45 min default

async function runExecute(
  subcommand: string,
  specJson: string,
  reportDir: string,
  workers: number,
): Promise<{ stdout: string; stderr: string }> {
  // Write spec to temp file
  const tmpSpec = path.join(os.tmpdir(), `exec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`);
  fs.writeFileSync(tmpSpec, specJson);

  const args = ['-m', 'src', 'execute', subcommand, '--spec', tmpSpec];
  if (reportDir) {
    args.push('--report-dir', reportDir);
  }

  try {
    const result = await execFileAsync('python', args, {
      cwd: FREQSWARM_DIR,
      timeout: EXECUTE_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024, // 50 MB
      env: {
        ...process.env,
        MAX_CONCURRENT_BACKTESTS: String(workers),
      },
    });
    return result;
  } finally {
    try { fs.unlinkSync(tmpSpec); } catch { /* ignore */ }
  }
}

server.tool(
  'swarm_execute_sweep',
  'BLOCKING: Run a matrix sweep to completion and return results directly (no polling needed). ' +
  'Takes ~5-30 min depending on pairs × timeframes × windows. ' +
  'Returns the full JobResults JSON with results array, heatmap, top_k, and composite scores. ' +
  'Use this instead of swarm_trigger_run + swarm_poll_run when you want to wait for results.',
  {
    spec_json: z.string().describe('MatrixSweepSpec JSON string (genome, pairs, timeframes, n_walkforward_windows)'),
    workers: z.number().optional().describe('Parallel worker count (1-8). Default 4.'),
    report_dir: z.string().optional().describe('Optional directory to also write results.json to disk.'),
  },
  async (args) => {
    try {
      // Validate JSON structure
      const spec = JSON.parse(args.spec_json);
      if (!spec.genome?.identity?.name) {
        return err('Invalid spec: missing genome.identity.name');
      }
      if (!Array.isArray(spec.pairs) || spec.pairs.length === 0) {
        return err('Invalid spec: missing or empty pairs array');
      }

      const workers = Math.min(Math.max(args.workers || 4, 1), 8);
      const reportDir = args.report_dir || '';

      log(`execute_sweep: starting (workers=${workers}, timeout=${EXECUTE_TIMEOUT_MS}ms)`);
      const { stdout, stderr } = await runExecute('sweep', args.spec_json, reportDir, workers);

      if (stderr) {
        log(`execute_sweep stderr (last 500): ${stderr.slice(-500)}`);
      }

      // Parse JSON from stdout (skip any non-JSON log lines)
      const jsonStart = stdout.indexOf('{');
      if (jsonStart === -1) {
        return err(`execute_sweep: no JSON output. stderr: ${stderr.slice(-500)}`);
      }
      const results = JSON.parse(stdout.slice(jsonStart));
      log(`execute_sweep: done — status=${results.status}, combinations=${results.results?.length || 0}`);
      return ok(results);
    } catch (e: unknown) {
      const error = e as Error & { stderr?: string; code?: string };
      if (error.code === 'ERR_CHILD_PROCESS_TIMEOUT' || error.code === 'ETIMEDOUT') {
        return err(`execute_sweep: timed out after ${EXECUTE_TIMEOUT_MS / 1000}s`);
      }
      const stderrTail = error.stderr ? `\nstderr: ${error.stderr.slice(-500)}` : '';
      return err(`execute_sweep failed: ${error.message}${stderrTail}`);
    }
  },
);

server.tool(
  'swarm_execute_autoresearch',
  'BLOCKING: Run an autoresearch mutation batch to completion and return results directly (no polling needed). ' +
  'Takes ~10-40 min depending on seed count × mutations. ' +
  'Returns the full AutoresearchResults JSON with keepers, rejects, mutation_family_stats, and composite scores. ' +
  'Use this instead of swarm_trigger_autoresearch + swarm_poll_run when you want to wait for results.',
  {
    spec_json: z.string().describe('AutoresearchSpec JSON string. Required: seed_genomes, timerange. Optional: mutations_per_genome, mutation_seed, allowed_families, keeper_sharpe_threshold, parent_sharpe_gate, discard_hashes.'),
    workers: z.number().optional().describe('Parallel worker count (1-8). Default 4.'),
    report_dir: z.string().optional().describe('Optional directory to also write results.json to disk.'),
  },
  async (args) => {
    try {
      // Validate JSON structure
      const spec = JSON.parse(args.spec_json);
      if (!spec.seed_genomes || !Array.isArray(spec.seed_genomes) || spec.seed_genomes.length === 0) {
        return err('Invalid spec: missing or empty seed_genomes array');
      }
      if (!spec.timerange) {
        return err('Invalid spec: missing timerange');
      }

      // Deep schema validation — catch wrong field names before execution
      const schemaErrors = validateSeedGenomes(spec.seed_genomes);
      if (schemaErrors.length > 0) {
        return err(`Genome schema errors (fix before resubmitting):\n${schemaErrors.join('\n')}`);
      }

      const workers = Math.min(Math.max(args.workers || 4, 1), 8);
      const reportDir = args.report_dir || '';
      const totalVariants = spec.seed_genomes.length * (spec.mutations_per_genome || 7);

      log(`execute_autoresearch: starting (${spec.seed_genomes.length} seeds × ${spec.mutations_per_genome || 7} = ~${totalVariants} variants, workers=${workers})`);
      const { stdout, stderr } = await runExecute('autoresearch', args.spec_json, reportDir, workers);

      if (stderr) {
        log(`execute_autoresearch stderr (last 500): ${stderr.slice(-500)}`);
      }

      // Parse JSON from stdout
      const jsonStart = stdout.indexOf('{');
      if (jsonStart === -1) {
        return err(`execute_autoresearch: no JSON output. stderr: ${stderr.slice(-500)}`);
      }
      const results = JSON.parse(stdout.slice(jsonStart));
      log(`execute_autoresearch: done — status=${results.status}, keepers=${results.keepers?.length || 0}, rejects=${results.rejects?.length || 0}`);
      return ok(results);
    } catch (e: unknown) {
      const error = e as Error & { stderr?: string; code?: string };
      if (error.code === 'ERR_CHILD_PROCESS_TIMEOUT' || error.code === 'ETIMEDOUT') {
        return err(`execute_autoresearch: timed out after ${EXECUTE_TIMEOUT_MS / 1000}s`);
      }
      const stderrTail = error.stderr ? `\nstderr: ${error.stderr.slice(-500)}` : '';
      return err(`execute_autoresearch failed: ${error.message}${stderrTail}`);
    }
  },
);

// ─── Seed Library ─────────────────────────────────────────────────────

const SEED_DIR = path.join(REPORT_DIR, 'seeds');

server.tool(
  'swarm_list_seeds',
  'List available native sdna seed genomes in the seed library. These are pre-built, verified genomes guaranteed to compile and run correctly with the autoresearch mutation engine. Use swarm_load_seed to get the full genome JSON for submission.',
  {},
  async () => {
    try {
      if (!fs.existsSync(SEED_DIR)) {
        return ok({ seeds: [], message: 'Seed library is empty.' });
      }
      const seeds = fs.readdirSync(SEED_DIR)
        .filter(f => f.endsWith('.genome.json'))
        .map(f => f.replace('.genome.json', ''));
      log(`Listed ${seeds.length} seed genomes`);
      return ok({ seeds, total: seeds.length });
    } catch (e) {
      return err(`Failed to list seeds: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_load_seed',
  'Load a pre-built native sdna seed genome from the seed library by name. Returns the genome JSON ready to pass as genome in seed_genomes[] of swarm_trigger_autoresearch. Genome IDs are auto-generated from content hash. Use swarm_list_seeds to see available seeds.',
  {
    name: z.string().describe('Seed genome name (e.g. "RSI_MACD_STOCHASTIC_TON", "Donchian_EMA_ADX_CHOP_WFO"). Get names from swarm_list_seeds.'),
  },
  async ({ name }) => {
    try {
      const seedPath = path.join(SEED_DIR, `${name}.genome.json`);
      if (!fs.existsSync(seedPath)) {
        const available = fs.existsSync(SEED_DIR)
          ? fs.readdirSync(SEED_DIR).filter(f => f.endsWith('.genome.json')).map(f => f.replace('.genome.json', ''))
          : [];
        return err(`Seed not found: ${name}. Available: ${available.join(', ') || 'none'}`);
      }
      const genome = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));

      // Auto-generate genome_id: SHA-256[:16] of content excluding identity (matches Python content_hash())
      const { identity: _identity, ...content } = genome;
      const contentHash = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
      genome.identity = { ...genome.identity, genome_id: contentHash };

      log(`Loaded seed: ${name} (genome_id=${contentHash})`);
      return ok({ genome, message: `Loaded seed: ${name} (genome_id=${contentHash})` });
    } catch (e) {
      return err(`Failed to load seed: ${(e as Error).message}`);
    }
  },
);

// ─── Strategy Library ─────────────────────────────────────────────────

const SWARM_STRATEGIES_DIR = path.join(FREQSWARM_DIR, 'data', 'user_data', 'strategies');

server.tool(
  'swarm_list_strategies',
  'List all available strategy .py files in the swarm strategies library. Returns class names that can be used with swarm_trigger_batch_backtest or swarm_scan_strategy. Includes ~450 community strategies (migrated to modern FreqTrade API) plus any WolfClaw strategies. Use name_filter to search by substring.',
  {
    name_filter: z.string().optional().describe('Optional substring filter for strategy names (case-insensitive). E.g. "wolf", "nfi", "cluc"'),
    count_only: z.boolean().optional().describe('If true, only return the count. Default false.'),
  },
  async (args) => {
    try {
      if (!fs.existsSync(SWARM_STRATEGIES_DIR)) {
        return err('Swarm strategies directory not found. Is freqswarm mounted?');
      }
      let strategies = fs.readdirSync(SWARM_STRATEGIES_DIR)
        .filter(f => f.endsWith('.py') && !f.startsWith('__'))
        .map(f => f.replace('.py', ''))
        .sort();

      if (args.name_filter) {
        const filter = args.name_filter.toLowerCase();
        strategies = strategies.filter(s => s.toLowerCase().includes(filter));
      }

      if (args.count_only) {
        return ok({ total: strategies.length, filter: args.name_filter || null });
      }

      log(`Listed ${strategies.length} strategies${args.name_filter ? ` (filter: ${args.name_filter})` : ''}`);
      return ok({ strategies, total: strategies.length, filter: args.name_filter || null });
    } catch (e) {
      return err(`Failed to list strategies: ${(e as Error).message}`);
    }
  },
);

// ─── Strategy Scanner ─────────────────────────────────────────────────

server.tool(
  'swarm_scan_strategy',
  'Scan a Freqtrade strategy to determine what patch-based mutations are safe to apply. Returns strategy_ref (for use in swarm_trigger_autoresearch with execution_backend="derived_subclass"), strategy_facts (scanner observations), and mutation_eligibility (which patch families are eligible: risk_override, param_pin). Poll with swarm_poll_run (~5s). This is the recommended way to start autoresearch on non-sdna (pre-existing Python) strategies.',
  {
    name: z.string().describe('Strategy class name (e.g. "BbandsRsiAdx"). The .py file must exist in the swarm strategies dir.'),
  },
  async ({ name }) => {
    try {
      const runId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      fs.mkdirSync(REQUEST_DIR, { recursive: true });

      // Write spec
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.spec.json`),
        JSON.stringify({ strategy_name: name }, null, 2),
      );

      // Write request manifest
      fs.writeFileSync(
        path.join(REQUEST_DIR, `${runId}.request.json`),
        JSON.stringify({
          run_id: runId,
          run_type: 'strategy_scan',
          submitted_at: new Date().toISOString(),
          group_folder: process.env.GROUP_FOLDER || '',
          chat_jid: process.env.NANOCLAW_CHAT_JID || '',
        }, null, 2),
      );

      log(`Scan submitted: ${runId} for strategy=${name}`);
      return ok({
        run_id: runId,
        status: 'submitted',
        message: 'Strategy scan submitted. Poll with swarm_poll_run (~5s). Result includes strategy_ref, strategy_facts, mutation_eligibility.',
      });
    } catch (e) {
      return err(`Failed to submit scan: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_autoresearch_history',
  'Scan all completed autoresearch runs and return mutations tried on a specific strategy. ' +
  'Use BEFORE a new autoresearch run to: avoid repeating failed mutations, detect plateaus ' +
  '(many tried, 0 keepers), and identify productive mutation families.\n' +
  'Returns up to 50 most recent mutations sorted newest-first, plus a per-family keeper-rate summary.',
  {
    genome_id_or_name: z.string().describe(
      'Strategy class name (e.g. "BbandsRsiAdx") or genome ID prefix. ' +
      'Matched against variant_name, variant_genome_id, and parent_genome_id.',
    ),
  },
  async ({ genome_id_or_name }) => {
    try {
      if (!fs.existsSync(REQUEST_DIR)) {
        return ok({
          genome_id_or_name,
          mutations: [],
          total_found: 0,
          returned: 0,
          summary: { total_tried: 0, keepers: 0, best_composite: null, worst_composite: null, families_tried: {} },
          message: 'No requests directory found.',
        });
      }

      type Entry = {
        run_id: string;
        variant_genome_id: string;
        variant_name: string;
        parent_genome_id: string;
        mutations: unknown[];
        composite_score: number;
        mean_sharpe: number;
        is_keeper: boolean;
        reason: string;
      };
      const entries: Entry[] = [];
      const q = genome_id_or_name.toLowerCase();

      for (const sf of fs.readdirSync(REQUEST_DIR).filter(f => f.endsWith('.status.json'))) {
        let status: Record<string, unknown>;
        try {
          status = JSON.parse(fs.readFileSync(path.join(REQUEST_DIR, sf), 'utf-8'));
        } catch {
          continue;
        }
        if (status.run_type !== 'autoresearch' || status.status !== 'completed' || !status.report_dir) continue;

        const resultsPath = path.join(String(status.report_dir), 'latest', 'results.json');
        if (!fs.existsSync(resultsPath)) continue;

        let results: Record<string, unknown>;
        try {
          results = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
        } catch {
          continue;
        }

        const runId = String(status.run_id || sf.replace('.status.json', ''));
        const allVariants = [
          ...(Array.isArray(results.keepers) ? results.keepers : []),
          ...(Array.isArray(results.rejects) ? results.rejects : []),
        ] as Record<string, unknown>[];

        for (const v of allVariants) {
          const vId = String(v.variant_genome_id || '');
          const vName = String(v.variant_name || '');
          const pId = String(v.parent_genome_id || '');
          if (
            !vId.toLowerCase().startsWith(q) &&
            !vName.toLowerCase().includes(q) &&
            !pId.toLowerCase().includes(q)
          ) continue;
          entries.push({
            run_id: runId,
            variant_genome_id: vId,
            variant_name: vName,
            parent_genome_id: pId,
            mutations: Array.isArray(v.mutations) ? v.mutations : [],
            composite_score: Number(v.composite_score ?? 0),
            mean_sharpe: Number(v.mean_sharpe ?? 0),
            is_keeper: Boolean(v.is_keeper),
            reason: String(v.reason || ''),
          });
        }
      }

      entries.sort((a, b) => b.run_id.localeCompare(a.run_id));
      const limited = entries.slice(0, 50);

      // Per-family keeper rates
      const familyStats: Record<string, { tried: number; keepers: number }> = {};
      for (const e of entries) {
        const seen = new Set<string>();
        for (const mut of e.mutations) {
          const family = String((mut as Record<string, unknown>).family || 'unknown');
          if (seen.has(family)) continue;
          seen.add(family);
          if (!familyStats[family]) familyStats[family] = { tried: 0, keepers: 0 };
          familyStats[family].tried++;
          if (e.is_keeper) familyStats[family].keepers++;
        }
      }
      const familiesTried = Object.fromEntries(
        Object.entries(familyStats).map(([k, v]) => [
          k,
          { ...v, keeper_rate: v.tried > 0 ? Math.round((v.keepers / v.tried) * 1000) / 1000 : 0 },
        ]),
      );

      const totalTried = entries.length;
      const scores = entries.map(e => e.composite_score);

      log(`History: query="${genome_id_or_name}" → ${totalTried} matches, returning ${limited.length}`);
      return ok({
        genome_id_or_name,
        mutations: limited,
        total_found: totalTried,
        returned: limited.length,
        summary: {
          total_tried: totalTried,
          keepers: entries.filter(e => e.is_keeper).length,
          best_composite: scores.length ? Math.max(...scores) : null,
          worst_composite: scores.length ? Math.min(...scores) : null,
          families_tried: familiesTried,
        },
        message: totalTried === 0
          ? `No autoresearch history found for "${genome_id_or_name}".`
          : totalTried > 50
            ? `Found ${totalTried} total — showing newest 50. Narrow the query for more precision.`
            : `Found ${totalTried} mutations.`,
      });
    } catch (e) {
      return err(`Failed to read autoresearch history: ${(e as Error).message}`);
    }
  },
);

// ─── Graduation Gate Enforcement ────────────────────────────────────

/** Parse graduation_gates for a given archetype from archetypes.yaml (no js-yaml dependency). */
function parseGraduationGates(
  yamlContent: string,
  archetype: string,
): { min_trades_per_window: number; min_wf_sharpe: number; max_wf_degradation_pct: number; max_drawdown_pct: number } | null {
  // Find the archetype section: "  ARCHETYPE_NAME:"
  const sectionRegex = new RegExp(`^  ${archetype}:`, 'm');
  const sectionMatch = sectionRegex.exec(yamlContent);
  if (!sectionMatch) return null;

  // Find graduation_gates: within this section (before next archetype or end)
  const afterSection = yamlContent.slice(sectionMatch.index);
  const gatesMatch = afterSection.match(/graduation_gates:\s*\n((?:\s+\w+:.*\n?)+)/);
  if (!gatesMatch) return null;

  const gatesBlock = gatesMatch[1];
  const extract = (key: string): number => {
    const m = gatesBlock.match(new RegExp(`${key}:\\s*([\\d.]+)`));
    return m ? parseFloat(m[1]) : NaN;
  };

  const gates = {
    min_trades_per_window: extract('min_trades_per_window'),
    min_wf_sharpe: extract('min_wf_sharpe'),
    max_wf_degradation_pct: extract('max_wf_degradation_pct'),
    max_drawdown_pct: extract('max_drawdown_pct'),
  };

  if (Object.values(gates).some(v => isNaN(v))) return null;
  return gates;
}

type WfPattern = 'CONSISTENT' | 'DEGRADING' | 'ALTERNATING' | 'SINGLE_SPIKE';

/** Classify walk-forward pattern from per-window Sharpe values. */
function classifyWfPattern(sharpes: number[]): WfPattern {
  if (sharpes.length < 2) return 'CONSISTENT';

  const mean = sharpes.reduce((a, b) => a + b, 0) / sharpes.length;
  const positiveCount = sharpes.filter(s => s > 0).length;
  const positiveRatio = positiveCount / sharpes.length;
  const maxSharpe = Math.max(...sharpes);

  // SINGLE_SPIKE: one window > 1.0, mean of others < 0.1
  if (maxSharpe > 1.0) {
    const others = sharpes.filter(s => s !== maxSharpe);
    const othersMean = others.length > 0 ? others.reduce((a, b) => a + b, 0) / others.length : 0;
    if (othersMean < 0.1) return 'SINGLE_SPIKE';
  }

  // DEGRADING: first half significantly better than second half
  const half = Math.floor(sharpes.length / 2);
  const firstHalf = sharpes.slice(0, half);
  const secondHalf = sharpes.slice(half);
  const firstMean = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const secondMean = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  if (firstMean > 0 && firstMean > 2 * secondMean) return 'DEGRADING';

  // CONSISTENT: >=75% windows positive, no single window dominates (max < 2× mean)
  if (positiveRatio >= 0.75 && (mean <= 0 || maxSharpe < 2 * mean)) return 'CONSISTENT';

  return 'ALTERNATING';
}

const ARCHETYPES_PATHS = [
  '/home/node/.claude/skills/archetype-taxonomy/archetypes.yaml',
  '/workspace/skills/archetype-taxonomy/archetypes.yaml',
];

server.tool(
  'swarm_check_graduation_gates',
  'Apply per-archetype graduation gates from archetypes.yaml to keepers from a completed autoresearch run. Calculates WF degradation, classifies walk-forward patterns (CONSISTENT/DEGRADING/ALTERNATING/SINGLE_SPIKE), and checks all 4 gates (Sharpe, degradation, trades/window, max drawdown). Returns structured verdicts: passed/failed/near_miss for each keeper. Use after swarm_job_results shows keepers.',
  {
    run_id: z.string().describe('Run ID of a completed autoresearch job'),
    archetype: z.string().describe('Archetype name from archetypes.yaml (e.g. "MEAN_REVERSION", "TREND_MOMENTUM")'),
  },
  async (args) => {
    try {
      // 1. Load graduation gates from archetypes.yaml
      let yamlContent: string | null = null;
      for (const p of ARCHETYPES_PATHS) {
        yamlContent = readFile(p);
        if (yamlContent) break;
      }
      if (!yamlContent) {
        return err(`archetypes.yaml not found at any known path: ${ARCHETYPES_PATHS.join(', ')}. Ensure archetype-taxonomy skill is installed.`);
      }

      const gates = parseGraduationGates(yamlContent, args.archetype);
      if (!gates) {
        return err(`Archetype "${args.archetype}" not found in archetypes.yaml or graduation_gates malformed. Valid archetypes: TREND_MOMENTUM, MEAN_REVERSION, BREAKOUT, RANGE_BOUND, SCALPING, CARRY_FUNDING, VOLATILITY_HARVEST.`);
      }

      // 2. Read job results (same pattern as swarm_job_results)
      const statusPath = path.join(REQUEST_DIR, `${args.run_id}.status.json`);
      if (!fs.existsSync(statusPath)) {
        return err(`Run not found: ${args.run_id}. Use swarm_trigger_autoresearch to submit a run first.`);
      }
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      if (status.status !== 'completed') {
        return err(`Run ${args.run_id} is not completed (status: ${status.status}). Wait for completion.`);
      }
      if (!status.report_dir) {
        return err(`Run ${args.run_id} completed but has no report_dir. Check exit code: ${status.exit_code}`);
      }
      const resultsPath = path.join(status.report_dir, 'latest', 'results.json');
      const resultsContent = readFile(resultsPath);
      if (!resultsContent) {
        return err(`Results file not found at ${resultsPath}. The job may have failed to write output.`);
      }
      const results = JSON.parse(resultsContent);
      const keepers: Array<Record<string, unknown>> = results.keepers || [];

      if (keepers.length === 0) {
        log(`Graduation gates: ${args.run_id} — no keepers to evaluate`);
        return ok({
          archetype: args.archetype,
          gates_used: gates,
          keepers: [],
          summary: { total: 0, passed: 0, failed: 0, near_miss: 0 },
          message: 'No keepers found in autoresearch results. All variants were rejected by FreqSwarm.',
        });
      }

      // 3. Evaluate each keeper against graduation gates
      const NEAR_MISS_TOLERANCE = 0.10; // 10% tolerance for near-miss
      const evaluated = keepers.map((keeper: Record<string, unknown>) => {
        const perWindow = (keeper.per_window_results || []) as Array<Record<string, unknown>>;
        const meanSharpe = (keeper.mean_sharpe as number) || 0;
        const variantName = (keeper.variant_name as string) || 'unknown';
        const pair = (keeper.pair as string) || 'unknown';
        const timeframe = (keeper.timeframe as string) || 'unknown';

        // Extract per-window Sharpe values
        const windowSharpes = perWindow.map((w) => {
          const metrics = (w.metrics || {}) as Record<string, unknown>;
          return (metrics.sharpe as number) ?? (metrics.Sharpe as number) ?? 0;
        });

        // Extract per-window trade counts and drawdowns
        const windowTrades = perWindow.map((w) => {
          const metrics = (w.metrics || {}) as Record<string, unknown>;
          return (metrics.trades as number) ?? (metrics.trade_count as number) ?? 0;
        });
        const windowDrawdowns = perWindow.map((w) => {
          const metrics = (w.metrics || {}) as Record<string, unknown>;
          const dd = (metrics.max_drawdown_pct as number) ?? (metrics.max_drawdown as number) ?? 0;
          // Normalize: drawdown should be positive for comparison (e.g. 15 means 15%)
          return Math.abs(dd) > 1 ? Math.abs(dd) : Math.abs(dd) * 100;
        });

        // Calculate degradation
        const half = Math.floor(windowSharpes.length / 2);
        const firstHalf = windowSharpes.slice(0, Math.max(half, 1));
        const secondHalf = windowSharpes.slice(Math.max(half, 1));
        const firstMean = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
        const secondMean = secondHalf.length > 0 ? secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length : 0;
        const degradationPct = firstMean > 0 ? (1 - secondMean / firstMean) * 100 : 100;

        // Min trades across windows (gate requires ALL windows to meet minimum)
        const minTrades = windowTrades.length > 0 ? Math.min(...windowTrades) : 0;

        // Worst drawdown across windows
        const worstDrawdownPct = windowDrawdowns.length > 0 ? Math.max(...windowDrawdowns) : 0;

        // Classify WF pattern
        const wfPattern = classifyWfPattern(windowSharpes);

        // Check 4 gates
        const gateDetails = {
          sharpe: meanSharpe >= gates.min_wf_sharpe,
          degradation: degradationPct <= gates.max_wf_degradation_pct,
          trades: minTrades >= gates.min_trades_per_window,
          drawdown: worstDrawdownPct <= gates.max_drawdown_pct,
        };

        const allPassed = Object.values(gateDetails).every(Boolean);

        // Near-miss: check if ALL failed gates are within 10% tolerance
        let isNearMiss = false;
        if (!allPassed) {
          const failures: boolean[] = [];
          if (!gateDetails.sharpe) {
            failures.push(meanSharpe >= gates.min_wf_sharpe * (1 - NEAR_MISS_TOLERANCE));
          }
          if (!gateDetails.degradation) {
            failures.push(degradationPct <= gates.max_wf_degradation_pct * (1 + NEAR_MISS_TOLERANCE));
          }
          if (!gateDetails.trades) {
            failures.push(minTrades >= gates.min_trades_per_window * (1 - NEAR_MISS_TOLERANCE));
          }
          if (!gateDetails.drawdown) {
            failures.push(worstDrawdownPct <= gates.max_drawdown_pct * (1 + NEAR_MISS_TOLERANCE));
          }
          isNearMiss = failures.length > 0 && failures.every(Boolean);
        }

        const verdict = allPassed ? 'passed' : isNearMiss ? 'near_miss' : 'failed';

        return {
          variant_name: variantName,
          pair,
          timeframe,
          mean_sharpe: Math.round(meanSharpe * 1000) / 1000,
          degradation_pct: Math.round(degradationPct * 10) / 10,
          min_trades: minTrades,
          worst_drawdown_pct: Math.round(worstDrawdownPct * 10) / 10,
          wf_pattern: wfPattern,
          verdict,
          gate_details: gateDetails,
          per_window_sharpes: windowSharpes.map(s => Math.round(s * 1000) / 1000),
        };
      });

      const summary = {
        total: evaluated.length,
        passed: evaluated.filter(e => e.verdict === 'passed').length,
        failed: evaluated.filter(e => e.verdict === 'failed').length,
        near_miss: evaluated.filter(e => e.verdict === 'near_miss').length,
      };

      log(`Graduation gates: ${args.run_id} (${args.archetype}) — ${summary.passed} passed, ${summary.near_miss} near-miss, ${summary.failed} failed out of ${summary.total} keepers`);

      return ok({
        archetype: args.archetype,
        gates_used: gates,
        keepers: evaluated,
        summary,
        message: summary.passed > 0
          ? `${summary.passed} keeper(s) passed graduation gates for ${args.archetype}! Ready to graduate.`
          : summary.near_miss > 0
            ? `No keepers passed, but ${summary.near_miss} are within 10% of threshold. Consider an extra research round.`
            : `All ${summary.total} keepers failed graduation gates for ${args.archetype}.`,
      });
    } catch (e) {
      return err(`Failed to check graduation gates: ${(e as Error).message}`);
    }
  },
);

server.tool(
  'swarm_graduate_keeper',
  'Graduate a keeper strategy that passed graduation gates. Writes archetype header tags to the strategy .py file and adds/updates the entry in roster.json for auto-mode discovery. Call AFTER swarm_check_graduation_gates confirms a keeper passed. The agent should also call aphexdata_record_event with verb_id="research_graduated" separately.',
  {
    strategy_path: z.string().describe('Absolute path to the strategy .py file inside the container (e.g. /workspace/group/user_data/strategies/MyStrategy.py)'),
    archetype: z.string().describe('Archetype name (e.g. "MEAN_REVERSION")'),
    pair: z.string().describe('Validated pair (e.g. "ETH/USDT:USDT")'),
    timeframe: z.string().describe('Validated timeframe (e.g. "1h")'),
    wf_sharpe: z.number().describe('Walk-forward Sharpe ratio (mean across windows)'),
    wf_degradation_pct: z.number().describe('Walk-forward degradation percentage'),
    roster_path: z.string().optional().describe('Path to roster.json (default: /workspace/group/roster.json)'),
  },
  async (args) => {
    try {
      const rosterPath = args.roster_path || '/workspace/group/roster.json';
      const strategyName = path.basename(args.strategy_path, '.py');
      const today = new Date().toISOString().split('T')[0];

      // 1. Prepend header tags to strategy file
      if (!fs.existsSync(args.strategy_path)) {
        return err(`Strategy file not found: ${args.strategy_path}`);
      }
      const existingContent = fs.readFileSync(args.strategy_path, 'utf-8');

      // Remove any existing graduation headers (re-graduation scenario)
      const cleanedContent = existingContent.replace(
        /^# (ARCHETYPE|GRADUATED|WALK_FORWARD_DEGRADATION|VALIDATED_PAIRS):.*\n/gm,
        '',
      );

      const headerTags = [
        `# ARCHETYPE: ${args.archetype}`,
        `# GRADUATED: ${today}`,
        `# WALK_FORWARD_DEGRADATION: ${Math.round(args.wf_degradation_pct)}%`,
        `# VALIDATED_PAIRS: ${args.pair}`,
      ].join('\n');

      fs.writeFileSync(args.strategy_path, headerTags + '\n' + cleanedContent.replace(/^\n+/, ''));

      // 2. Update roster.json
      interface RosterCell {
        pair: string;
        timeframe: string;
        status: string;
        last_activated: string | null;
        last_deactivated: string | null;
        activation_count: number;
      }
      interface RosterEntry {
        strategy_name: string;
        strategy_path: string;
        archetype: string;
        validated_pairs: string[];
        timeframe: string;
        wf_degradation_pct: number;
        wf_sharpe: number;
        graduated_at: string;
        cells: RosterCell[];
      }
      interface Roster {
        version: number;
        roster: RosterEntry[];
        last_updated: string;
      }

      let roster: Roster;
      if (fs.existsSync(rosterPath)) {
        roster = JSON.parse(fs.readFileSync(rosterPath, 'utf-8'));
      } else {
        roster = { version: 1, roster: [], last_updated: today };
      }

      // Find existing entry for this strategy or create new one
      let entry = roster.roster.find(r => r.strategy_name === strategyName);
      if (entry) {
        // Merge: add pair if not already validated, add cell
        if (!entry.validated_pairs.includes(args.pair)) {
          entry.validated_pairs.push(args.pair);
        }
        // Update graduation metrics to latest
        entry.wf_sharpe = args.wf_sharpe;
        entry.wf_degradation_pct = args.wf_degradation_pct;
        entry.graduated_at = today;
        // Add cell if not already present for this pair+timeframe
        const cellExists = entry.cells.some(
          c => c.pair === args.pair && c.timeframe === args.timeframe,
        );
        if (!cellExists) {
          entry.cells.push({
            pair: args.pair,
            timeframe: args.timeframe,
            status: 'staged',
            last_activated: null,
            last_deactivated: null,
            activation_count: 0,
          });
        }
      } else {
        entry = {
          strategy_name: strategyName,
          strategy_path: args.strategy_path,
          archetype: args.archetype,
          validated_pairs: [args.pair],
          timeframe: args.timeframe,
          wf_degradation_pct: args.wf_degradation_pct,
          wf_sharpe: args.wf_sharpe,
          graduated_at: today,
          cells: [
            {
              pair: args.pair,
              timeframe: args.timeframe,
              status: 'staged',
              last_activated: null,
              last_deactivated: null,
              activation_count: 0,
            },
          ],
        };
        roster.roster.push(entry);
      }

      roster.last_updated = new Date().toISOString();
      fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2) + '\n');

      log(`Graduated: ${strategyName} (${args.archetype}) for ${args.pair}/${args.timeframe} — Sharpe ${args.wf_sharpe}, degradation ${args.wf_degradation_pct}%`);

      return ok({
        graduated: true,
        strategy_name: strategyName,
        archetype: args.archetype,
        pair: args.pair,
        timeframe: args.timeframe,
        header_tags_written: true,
        roster_updated: true,
        roster_path: rosterPath,
        roster_entry: entry,
        message: `${strategyName} graduated for ${args.archetype}! WF Sharpe: ${args.wf_sharpe} | Degradation: ${Math.round(args.wf_degradation_pct)}% | Staged to roster for auto-mode discovery.`,
      });
    } catch (e) {
      return err(`Failed to graduate keeper: ${(e as Error).message}`);
    }
  },
);

// ─── Start ───────────────────────────────────────────────────────────

log(`Starting Swarm MCP server (report_dir=${REPORT_DIR})`);
const transport = new StdioServerTransport();
await server.connect(transport);
