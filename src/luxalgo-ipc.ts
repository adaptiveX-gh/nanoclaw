/**
 * LuxAlgo Quant Integration - Host-side IPC Handler
 *
 * Handles luxalgo_* IPC messages from container agents.
 * Spawns script subprocesses that use Playwright browser automation.
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// Chrome path must come from .env — nanoclaw never loads secrets into
// process.env, and the luxalgo scripts default to a Windows path that
// won't exist if Chrome is installed elsewhere. Read once at module load.
const { CHROME_PATH } = readEnvFile(['CHROME_PATH']);

interface SkillResult {
  success: boolean;
  message: string;
  data?: unknown;
}

const DEFAULT_TIMEOUT = 120000;
const CHAT_TIMEOUT = 180000; // 3 minutes for LLM streaming responses

function runScript(
  script: string,
  args: object,
  timeout = DEFAULT_TIMEOUT,
): Promise<SkillResult> {
  const scriptPath = path.join(
    process.cwd(),
    '.claude',
    'skills',
    'luxalgo-quant',
    'scripts',
    `${script}.ts`,
  );

  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', scriptPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NANOCLAW_ROOT: process.cwd(),
        ...(CHROME_PATH ? { CHROME_PATH } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    // On Windows, SIGTERM only kills the shell — Chrome child processes
    // survive and hold the browser profile lock, breaking subsequent calls.
    // Use taskkill /F /T to kill the entire process tree on timeout.
    const killTree = () => {
      if (proc.pid == null) return;
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
        } catch {
          // process may have already exited
        }
      } else {
        proc.kill('SIGTERM');
      }
    };

    const timer = setTimeout(() => {
      killTree();
      resolve({
        success: false,
        message: `Script timed out (${timeout / 1000}s)`,
      });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      // Try parsing the last line of stdout as JSON — the browser scripts
      // always write a JSON result to stdout, even on error (exit code 1).
      // Only fall back to stderr/code if stdout doesn't contain valid JSON.
      const trimmedStdout = stdout.trim();
      if (trimmedStdout) {
        try {
          const lines = trimmedStdout.split('\n');
          const parsed = JSON.parse(lines[lines.length - 1]) as SkillResult;
          resolve(parsed);
          return;
        } catch {
          // stdout wasn't valid JSON — fall through
        }
      }
      if (code !== 0) {
        const detail = stderr.trim().slice(-500);
        resolve({
          success: false,
          message: `Script exited with code: ${code}${detail ? ` — ${detail}` : ''}`,
        });
        return;
      }
      resolve({
        success: false,
        message: `Failed to parse output: ${trimmedStdout.slice(0, 200)}`,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, message: `Failed to spawn: ${err.message}` });
    });
  });
}

function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: SkillResult,
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'luxalgo_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${requestId}.json`),
    JSON.stringify(result),
  );
}

/**
 * Handle LuxAlgo Quant IPC messages.
 * @returns true if message was handled, false if not a luxalgo message
 */
export async function handleLuxAlgoIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;

  if (!type?.startsWith('luxalgo_')) {
    return false;
  }

  if (!isMain) {
    logger.warn(
      { sourceGroup, type },
      'LuxAlgo integration blocked: not main group',
    );
    return true;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'LuxAlgo integration blocked: missing requestId');
    return true;
  }

  logger.info({ type, requestId }, 'Processing LuxAlgo request');

  let result: SkillResult;

  switch (type) {
    case 'luxalgo_chat':
      if (!data.message) {
        result = { success: false, message: 'Missing message' };
        break;
      }
      result = await runScript(
        'chat',
        { message: data.message, archetype: data.archetype },
        CHAT_TIMEOUT,
      );
      break;

    case 'luxalgo_new_conversation':
      result = await runScript('new-conversation', {});
      break;

    case 'luxalgo_get_history':
      result = await runScript('get-history', {});
      break;

    default:
      return false;
  }

  writeResult(dataDir, sourceGroup, requestId, result);
  if (result.success) {
    logger.info({ type, requestId }, 'LuxAlgo request completed');
  } else {
    logger.error(
      { type, requestId, message: result.message },
      'LuxAlgo request failed',
    );
  }
  return true;
}
