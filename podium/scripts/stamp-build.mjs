#!/usr/bin/env node

/**
 * Updates BUILD, VERSION, and COMMIT in assets/js/protocol.js.
 *
 * Usage:
 *   node scripts/stamp-build.mjs             # Bumps BUILD + 1, updates COMMIT from git
 *   node scripts/stamp-build.mjs --no-bump   # Updates COMMIT from git, keeps BUILD as is
 *   node scripts/stamp-build.mjs --version 1.1 # Sets VERSION to 1.1, bumps BUILD + 1, updates COMMIT
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_PATH = path.resolve(__dirname, '../assets/js/protocol.js');

function getGitCommit() {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA.slice(0, 7);
  }
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const args = process.argv.slice(2);
const noBump = args.includes('--no-bump');
const versionArgIdx = args.indexOf('--version');
const explicitVersion = versionArgIdx !== -1 && args[versionArgIdx + 1] ? args[versionArgIdx + 1] : null;

let content = fs.readFileSync(PROTOCOL_PATH, 'utf8');

// Match BUILD
const buildMatch = content.match(/export const BUILD = (\d+);/);
if (!buildMatch) {
  console.error('Could not find "export const BUILD = <number>;" in protocol.js');
  process.exit(1);
}
const currentBuild = parseInt(buildMatch[1], 10);
const newBuild = noBump ? currentBuild : currentBuild + 1;

// Match VERSION
const versionMatch = content.match(/export const VERSION = '([^']+)';/);
const currentVersion = versionMatch ? versionMatch[1] : '1.0';
const newVersion = explicitVersion || currentVersion;

// Get Commit Hash
const commit = getGitCommit() || (content.match(/export const COMMIT = '([^']*)';/)?.[1] ?? '');

// Replace BUILD
content = content.replace(/export const BUILD = \d+;/, `export const BUILD = ${newBuild};`);

// Replace VERSION
if (versionMatch) {
  content = content.replace(/export const VERSION = '[^']+';/, `export const VERSION = '${newVersion}';`);
}

// Replace or Insert COMMIT
if (/export const COMMIT = '[^']*';/.test(content)) {
  content = content.replace(/export const COMMIT = '[^']*';/, `export const COMMIT = '${commit}';`);
} else {
  content = content.replace(
    /(export const VERSION = '[^']+';)/,
    `$1\nexport const COMMIT = '${commit}';`
  );
}

// Ensure versionStamp() is exported
if (!content.includes('export function versionStamp(')) {
  content = content.replace(
    /(export const COMMIT = '[^']*';)/,
    `$1\n\nexport function versionStamp() {\n  return \`v\${VERSION} · build \${BUILD}\${COMMIT ? \` · \${COMMIT}\` : ''}\`;\n}`
  );
}

fs.writeFileSync(PROTOCOL_PATH, content, 'utf8');

console.log(`Updated protocol.js:`);
console.log(`  VERSION: ${newVersion}`);
console.log(`  BUILD:   ${newBuild} ${noBump ? '(unchanged)' : `(bumped from ${currentBuild})`}`);
console.log(`  COMMIT:  ${commit || '(none)'}`);
