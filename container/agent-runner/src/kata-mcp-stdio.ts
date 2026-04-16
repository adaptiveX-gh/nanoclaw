/**
 * Stdio MCP Server for NanoClaw Kata Runner Integration
 *
 * Provides 5 tools for managing kata improvement races:
 *   kata_start   — submit a race request (starts a kata container)
 *   kata_stop    — cancel a running race
 *   kata_status  — read progress of a specific race
 *   kata_list    — list all active/recent races
 *   kata_import  — copy a graduated strategy to strategies dir
 *
 * Communication: writes .request.json files to a shared mount directory,
 * reads .status.json files written by the host-side kata-runner.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const KATA_RUNNER_DIR =
  process.env.KATA_RUNNER_DIR || '/workspace/extra/kata-runner';
const REQUEST_DIR = path.join(KATA_RUNNER_DIR, 'requests');
const RACES_DIR = path.join(KATA_RUNNER_DIR, 'races');

function log(message: string): void {
  console.error(`[KATA] ${message}`);
}

function ok(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
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

function generateRequestId(): string {
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  return `kata_${ts}_${rand}`;
}

/**
 * Write a request file and wait for the host-side kata-runner to process it.
 * Polls for a .status.json response file up to the specified timeout.
 */
async function submitAndWait(
  requestId: string,
  request: Record<string, unknown>,
  timeoutMs: number = 60_000,
): Promise<Record<string, unknown>> {
  const requestPath = path.join(REQUEST_DIR, `${requestId}.request.json`);
  fs.writeFileSync(requestPath, JSON.stringify(request, null, 2));
  log(`Request submitted: ${requestId} (${request.type})`);

  // Poll for status
  const statusPath = path.join(REQUEST_DIR, `${requestId}.status.json`);
  const startTime = Date.now();
  const pollInterval = 500;

  while (Date.now() - startTime < timeoutMs) {
    if (fs.existsSync(statusPath)) {
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      log(`Response received: ${requestId} → ${status.status}`);
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `Timeout waiting for kata-runner response (${timeoutMs / 1000}s). ` +
      `Is the NanoClaw host process running?`,
  );
}

const server = new McpServer({ name: 'katarunner', version: '1.0.0' });

// ─── Kata Start ─────────────────────────────────────────────────────

server.tool(
  'kata_start',
  'Start a kata improvement race for a strategy. Creates a container that runs iterate_container.py to evolve the strategy through walk-forward benchmarking. Returns immediately with race_id.',
  {
    race_id: z
      .string()
      .describe('Unique race ID (e.g. "race_20260415_192058")'),
    candidate_name: z
      .string()
      .describe('Human-readable strategy name'),
    strategy_code: z
      .string()
      .describe('Full Python source of the KataStrategy class'),
    pair: z
      .string()
      .describe('Trading pair (e.g. "LINK/USDT:USDT")'),
    timeframe: z
      .string()
      .optional()
      .describe('Timeframe (e.g. "4h"). Default: "4h"'),
    archetype: z
      .string()
      .optional()
      .describe('Strategy archetype (e.g. "BREAKOUT")'),
    max_experiments: z
      .number()
      .optional()
      .describe('Max improvement iterations. Default: 50'),
    group_folder: z
      .string()
      .optional()
      .describe('Group folder for locating race dir and knowledge'),
  },
  async (args) => {
    try {
      if (!fs.existsSync(REQUEST_DIR)) {
        return err(
          'Kata runner request directory not found. Is the kata-runner enabled on the host?',
        );
      }

      const requestId = generateRequestId();
      const result = await submitAndWait(requestId, {
        type: 'start_race',
        race_id: args.race_id,
        candidate_name: args.candidate_name,
        strategy_code: args.strategy_code,
        pair: args.pair,
        timeframe: args.timeframe || '4h',
        archetype: args.archetype || 'UNKNOWN',
        max_experiments: args.max_experiments || 50,
        group_folder: args.group_folder,
        submitted_at: new Date().toISOString(),
      });

      if (result.status === 'failed') {
        return err(`Failed to start race: ${result.error}`);
      }

      return ok(result);
    } catch (e) {
      return err(`kata_start failed: ${(e as Error).message}`);
    }
  },
);

// ─── Kata Stop ──────────────────────────────────────────────────────

server.tool(
  'kata_stop',
  'Stop and remove a kata race container. This is irreversible — the container is killed. Results written so far are preserved in the race directory.',
  {
    race_id: z.string().describe('Race ID to stop'),
    confirm: z
      .boolean()
      .describe('Must be true to confirm container removal'),
  },
  async (args) => {
    try {
      if (!args.confirm) {
        return err(
          'confirm must be true to stop a race. This kills the container.',
        );
      }

      if (!fs.existsSync(REQUEST_DIR)) {
        return err('Kata runner request directory not found.');
      }

      const requestId = generateRequestId();
      const result = await submitAndWait(requestId, {
        type: 'stop_race',
        race_id: args.race_id,
        confirm: true,
        submitted_at: new Date().toISOString(),
      });

      if (result.status === 'failed') {
        return err(`Failed to stop race: ${result.error}`);
      }

      return ok(result);
    } catch (e) {
      return err(`kata_stop failed: ${(e as Error).message}`);
    }
  },
);

// ─── Kata Status ────────────────────────────────────────────────────

server.tool(
  'kata_status',
  'Read the current status of a kata race. Returns experiments count, scores, sharpe trajectory, WF pattern, DSR, PBO, and graduate path if applicable. No IPC needed — reads status file directly.',
  {
    race_id: z.string().describe('Race ID to check'),
  },
  async (args) => {
    try {
      const statusPath = path.join(RACES_DIR, `${args.race_id}.status.json`);
      const content = readFile(statusPath);
      if (!content) {
        return err(
          `No race status found for ${args.race_id}. Race may not be started.`,
        );
      }

      const status = JSON.parse(content);
      log(`Status read: ${args.race_id} → ${status.status}`);
      return ok(status);
    } catch (e) {
      return err(`kata_status failed: ${(e as Error).message}`);
    }
  },
);

// ─── Kata List ──────────────────────────────────────────────────────

server.tool(
  'kata_list',
  'List all kata races with their current status. Returns an array of race status objects.',
  {},
  async () => {
    try {
      if (!fs.existsSync(RACES_DIR)) {
        return ok({ races: [], count: 0 });
      }

      const files = fs
        .readdirSync(RACES_DIR)
        .filter((f) => f.endsWith('.status.json'));
      const races = files.map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(RACES_DIR, f), 'utf-8'));
        } catch {
          return { race_id: f.replace('.status.json', ''), status: 'unknown' };
        }
      });

      log(`Listed ${races.length} races`);
      return ok({ races, count: races.length });
    } catch (e) {
      return err(`kata_list failed: ${(e as Error).message}`);
    }
  },
);

// ─── Kata Import ────────────────────────────────────────────────────

server.tool(
  'kata_import',
  'Import a graduated strategy from a kata race. Reads the graduate file from the race directory and returns its contents for the agent to save to the strategies directory.',
  {
    race_id: z.string().describe('Race ID of the graduated strategy'),
  },
  async (args) => {
    try {
      // Read status to find graduate path
      const statusPath = path.join(RACES_DIR, `${args.race_id}.status.json`);
      const statusContent = readFile(statusPath);
      if (!statusContent) {
        return err(`No race status found for ${args.race_id}.`);
      }

      const status = JSON.parse(statusContent);
      if (status.status !== 'graduated') {
        return err(
          `Race ${args.race_id} has not graduated (status: ${status.status}). Cannot import.`,
        );
      }

      // Read graduate file from races dir (copied there by kata-runner daemon)
      const graduatePath = path.join(RACES_DIR, `${args.race_id}.graduate.py`);
      const code = readFile(graduatePath);
      if (!code) {
        return err(
          `No graduate strategy file found for ${args.race_id}. ` +
            `Expected ${args.race_id}.graduate.py in kata-runner races dir. ` +
            `The kata-runner daemon copies this on graduation.`,
        );
      }

      log(`Import: ${args.race_id} → ${args.race_id}.graduate.py (${code.length} chars)`);

      return ok({
        race_id: args.race_id,
        candidate_name: status.candidate_name,
        graduate_file: path.basename(graduatePath),
        strategy_code: code,
        final_score: status.best_score,
        experiments: status.experiments,
        wf_pattern: status.wf_pattern,
        dsr: status.dsr,
        pbo: status.pbo,
      });
    } catch (e) {
      return err(`kata_import failed: ${(e as Error).message}`);
    }
  },
);

// ─── Server Start ───────────────────────────────────────────────────

async function main() {
  log('Kata Runner MCP server starting...');

  const hasRequestDir = fs.existsSync(REQUEST_DIR);
  const hasRacesDir = fs.existsSync(RACES_DIR);
  log(`Directories: requests=${hasRequestDir}, races=${hasRacesDir}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Kata Runner MCP server connected via stdio');
}

main().catch((err) => {
  console.error(`[KATA] Fatal: ${err}`);
  process.exit(1);
});
