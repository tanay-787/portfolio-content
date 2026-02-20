#!/usr/bin/env node
/**
 * screenshot.js
 *
 * Scans all project folders in the portfolio-content repo and, for each folder
 * that contains assets/Showcase.png (or .webp), checks whether the corresponding
 * GitHub repository has new commits since the last screenshot was taken.
 * If it does, a new screenshot of the project's landing page is captured with
 * Puppeteer and the existing Showcase image is overwritten.
 *
 * Metadata about the last screenshot timestamp for each project is stored in
 * .github/data/screenshot-timestamps.json so that only changed projects are
 * re-screenshotted.
 */

'use strict';

const { graphql } = require('@octokit/graphql');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = 'tanay-787';

// Resolve paths relative to the repository root (two levels up from .github/scripts/)
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const TIMESTAMPS_FILE = path.resolve(__dirname, '..', 'data', 'screenshot-timestamps.json');

/**
 * Read the stored screenshot timestamps from disk.
 * @returns {Record<string, string>} Map of project name to ISO timestamp string.
 */
function readTimestamps() {
  if (fs.existsSync(TIMESTAMPS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(TIMESTAMPS_FILE, 'utf-8'));
    } catch {
      console.warn('Warning: could not parse screenshot-timestamps.json; starting fresh.');
    }
  }
  return {};
}

/**
 * Persist updated screenshot timestamps to disk.
 * @param {Record<string, string>} timestamps
 */
function writeTimestamps(timestamps) {
  fs.mkdirSync(path.dirname(TIMESTAMPS_FILE), { recursive: true });
  fs.writeFileSync(TIMESTAMPS_FILE, JSON.stringify(timestamps, null, 2) + '\n');
}

/**
 * Scan the repository root for project folders that contain a Showcase image.
 * Hidden directories (starting with '.') and non-directories are skipped.
 * @returns {string[]} List of project folder names.
 */
function getProjectFolders() {
  return fs
    .readdirSync(ROOT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => {
      const assetsDir = path.join(ROOT_DIR, name, 'assets');
      if (!fs.existsSync(assetsDir)) return false;
      const files = fs.readdirSync(assetsDir);
      return files.some((f) => f === 'Showcase.png' || f === 'Showcase.webp');
    });
}

/**
 * GraphQL query that fetches the homepage URL and the committed date of the
 * latest commit on the default branch of a repository.
 * Pattern referenced from tanay-787/dev-portfolio lib/getPortfolioRepos.ts.
 */
const REPO_INFO_QUERY = `
  query GetRepoInfo($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      homepageUrl
      defaultBranchRef {
        target {
          ... on Commit {
            committedDate
          }
        }
      }
    }
  }
`;

/**
 * Fetch repository metadata (homepage URL + latest commit date) from the
 * GitHub GraphQL API.
 *
 * @param {string} owner Repository owner login.
 * @param {string} name  Repository name.
 * @returns {Promise<{homepageUrl: string|null, committedDate: string|null}>}
 */
async function getRepoInfo(owner, name) {
  const graphqlWithAuth = graphql.defaults({
    headers: { authorization: `token ${GITHUB_TOKEN}` },
  });

  const result = await graphqlWithAuth(REPO_INFO_QUERY, { owner, name });
  const repo = result.repository;

  return {
    homepageUrl: repo?.homepageUrl || null,
    committedDate: repo?.defaultBranchRef?.target?.committedDate || null,
  };
}

/**
 * Use Puppeteer to capture a full-width screenshot of the given URL and save
 * it to the specified file path. The image format is inferred from the file
 * extension (.webp or .png).
 *
 * @param {string} url        Landing page URL to screenshot.
 * @param {string} outputPath Absolute path where the image will be written.
 */
async function takeScreenshot(url, outputPath) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });

    const imageType = outputPath.endsWith('.webp') ? 'webp' : 'png';
    await page.screenshot({ path: outputPath, type: imageType });

    console.log(`  Screenshot saved to: ${path.relative(ROOT_DIR, outputPath)}`);
  } finally {
    await browser.close();
  }
}

/**
 * Determine the path of the Showcase image inside a project's assets directory.
 * Prefers .png; falls back to .webp.
 *
 * @param {string} project Project folder name.
 * @returns {string} Absolute path to the Showcase image file.
 */
function getShowcasePath(project) {
  const assetsDir = path.join(ROOT_DIR, project, 'assets');
  const pngPath = path.join(assetsDir, 'Showcase.png');
  return fs.existsSync(pngPath) ? pngPath : path.join(assetsDir, 'Showcase.webp');
}

async function main() {
  if (!GITHUB_TOKEN) {
    console.error('Error: GITHUB_TOKEN environment variable is required.');
    process.exit(1);
  }

  const timestamps = readTimestamps();
  const projects = getProjectFolders();
  let screenshotCount = 0;
  let timestampOnlyCount = 0;

  console.log(`Found ${projects.length} project(s): ${projects.join(', ')}\n`);

  for (const project of projects) {
    console.log(`Processing: ${project}`);

    try {
      const { homepageUrl, committedDate } = await getRepoInfo(REPO_OWNER, project);

      if (!committedDate) {
        console.log(`  Skipping: could not determine latest commit date for '${REPO_OWNER}/${project}'.`);
        continue;
      }

      const lastScreenshot = timestamps[project];

      if (lastScreenshot && new Date(committedDate) <= new Date(lastScreenshot)) {
        console.log(`  Up to date (last commit: ${committedDate}, last screenshot: ${lastScreenshot}).`);
        continue;
      }

      if (!homepageUrl) {
        console.log(`  No homepage URL configured for '${REPO_OWNER}/${project}'; skipping screenshot.`);
        // Record the commit date so we don't recheck on every run.
        timestamps[project] = committedDate;
        timestampOnlyCount++;
        continue;
      }

      console.log(`  New commits detected. Screenshotting: ${homepageUrl}`);

      const outputPath = getShowcasePath(project);
      await takeScreenshot(homepageUrl, outputPath);

      timestamps[project] = committedDate;
      screenshotCount++;

      console.log(`  Done.`);
    } catch (err) {
      console.error(`  Error processing '${project}': ${err.message}`);
    }
  }

  writeTimestamps(timestamps);

  if (screenshotCount > 0 || timestampOnlyCount > 0) {
    console.log(
      `\nFinished. Screenshots taken: ${screenshotCount}. Timestamp-only updates: ${timestampOnlyCount}. Timestamps written.`
    );
  } else {
    console.log('\nFinished. No updates were necessary.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
