#!/usr/bin/env node
/**
 * Recompute Aphex scores for all existing attested genomes.
 * Usage: node scripts/recompute-aphex.js <content-dir>
 */
import fs from 'fs';
import path from 'path';
import { parse, serialize } from '../src/lib/frontmatter.js';
import { computeAphexScore } from '../src/lib/aphex.js';

const contentDir = process.argv[2];
if (!contentDir) {
  console.error('Usage: node scripts/recompute-aphex.js <content-dir>');
  process.exit(1);
}

function findSdnaFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findSdnaFiles(full));
    else if (entry.name.endsWith('.sdna')) results.push(full);
  }
  return results;
}

const files = findSdnaFiles(contentDir);
let updated = 0;
let skipped = 0;

for (const filePath of files) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parse(raw);

    if (frontmatter.attestation?.status !== 'attested') {
      skipped++;
      continue;
    }

    // Compute Aphex score from existing attestation + genome body
    const aphex = computeAphexScore(frontmatter.attestation, body);
    frontmatter.attestation.aphex_score = aphex.aphex_score;
    frontmatter.attestation.aphex_tier = aphex.tier;
    frontmatter.attestation.aphex_components = aphex.components;

    fs.writeFileSync(filePath, serialize(frontmatter, body));
    const rel = path.relative(contentDir, filePath);
    console.log(`  ${rel}: ${aphex.aphex_score} (${aphex.tier})`);
    updated++;
  } catch (err) {
    console.error(`  ERROR ${filePath}: ${err.message}`);
  }
}

console.log(`\nDone: ${updated} updated, ${skipped} skipped (unattested)`);
