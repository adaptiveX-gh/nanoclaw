import fs from 'fs';
import path from 'path';
import { parse } from '../lib/frontmatter.js';
import { computeHash, displayHash, verifyHash } from '../lib/hash.js';
import { buildDAG, getEdges, computeFrontier, getDepths } from '../lib/dag.js';

/**
 * Quality tier — prefer Aphex tier, fall back to Sharpe-based.
 */
function qualityTier(attestation) {
  if (attestation?.aphex_tier) return attestation.aphex_tier;
  const sharpe = attestation?.walk_forward_sharpe;
  if (sharpe == null) return 'experimental';
  if (sharpe >= 1.5) return 'exceptional';
  if (sharpe >= 1.0) return 'strong';
  if (sharpe >= 0.5) return 'viable';
  return 'experimental';
}

/**
 * Recursively find all GENOME.sdna files in a directory.
 */
function findGenomeFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findGenomeFiles(fullPath));
    } else if (entry.name === 'GENOME.sdna' || entry.name.endsWith('.sdna')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Build registry.json from a content directory.
 * @param {string} contentDir - Path to content directory
 * @param {string} outputDir - Path to output directory
 */
export function buildRegistry(contentDir, outputDir = 'dist') {
  const files = findGenomeFiles(contentDir);
  const genomes = [];
  const errors = [];

  for (const filePath of files) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = parse(raw);

      // Compute hash from body
      const computedHash = computeHash(body);
      const computedDisplay = displayHash(computedHash);

      // Verify hash if present
      let hashValid = true;
      if (frontmatter.hash && frontmatter.hash !== '') {
        hashValid = verifyHash(body, frontmatter.hash);
        if (!hashValid) {
          errors.push({
            file: filePath,
            error: `Hash mismatch: expected ${frontmatter.hash}, computed ${computedDisplay}`,
          });
        }
      }

      // Derive ID from relative path
      const relPath = path.relative(contentDir, filePath).replace(/\\/g, '/');
      const id = relPath
        .replace(/\/GENOME\.sdna$/, '')
        .replace(/\.sdna$/, '')
        .replace(/\//g, '/');

      const att = frontmatter.attestation || { status: 'unattested' };

      genomes.push({
        id,
        name: frontmatter.name || id,
        hash: computedDisplay,
        fullHash: computedHash,
        parent: frontmatter.parent || null,
        operator: frontmatter.operator || '',
        author: frontmatter.author || '',
        description: frontmatter.description || '',
        tags: frontmatter.tags || [],
        created: frontmatter.created || '',
        runtime: frontmatter.runtime || 'freqtrade',
        sdna_version: frontmatter.sdna_version || '0.1',
        attestation: att,
        tier: qualityTier(att),
        path: relPath,
        hashValid,
        // Body fields useful for search
        timeframe: body.timeframe || '',
        pairs: body.pairs || [],
      });
    } catch (err) {
      errors.push({ file: filePath, error: err.message });
    }
  }

  // Build DAG
  const dag = buildDAG(genomes);
  const edges = getEdges(genomes);
  const depths = getDepths(genomes, dag.parents);
  const frontier = computeFrontier(genomes, dag.leaves);

  // Build leaderboard sorted by Aphex score (fallback to Sharpe)
  const leaderboard = genomes
    .filter(g => g.attestation?.status === 'attested')
    .sort((a, b) => {
      const aScore = a.attestation.aphex_score ?? (a.attestation.walk_forward_sharpe || 0);
      const bScore = b.attestation.aphex_score ?? (b.attestation.walk_forward_sharpe || 0);
      return bScore - aScore;
    })
    .map((g, rank) => ({
      rank: rank + 1,
      id: g.id,
      name: g.name,
      hash: g.hash,
      aphex_score: g.attestation.aphex_score || 0,
      aphex_tier: g.attestation.aphex_tier || g.tier,
      aphex_components: g.attestation.aphex_components || null,
      sharpe: g.attestation.walk_forward_sharpe || 0,
      trades: g.attestation.total_trades || 0,
      profit_factor: g.attestation.profit_factor || 0,
      max_drawdown: g.attestation.max_drawdown || 0,
      win_rate: g.attestation.win_rate || 0,
      operator: g.operator,
      tags: g.tags,
    }));

  // Compute stats
  const operators = new Set(genomes.map(g => g.operator).filter(Boolean));
  const attested = genomes.filter(g => g.attestation?.status === 'attested').length;

  const registry = {
    version: '0.1',
    built: new Date().toISOString(),
    stats: {
      total: genomes.length,
      operators: operators.size,
      attested,
      errors: errors.length,
    },
    genomes,
    dag: {
      roots: dag.roots,
      edges,
      leaves: dag.leaves,
      frontier,
    },
    leaderboard,
    errors: errors.length > 0 ? errors : undefined,
  };

  // Write output
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'registry.json');
  fs.writeFileSync(outputPath, JSON.stringify(registry, null, 2));

  return { registry, stats: registry.stats, outputPath };
}
