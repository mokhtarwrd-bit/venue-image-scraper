#!/usr/bin/env node
// =============================================================================
// Analyze scraped data + transcripts → generate markdown research report
// Usage: node scripts/report.js <project-name>
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const projectName = process.argv[2];
if (!projectName) {
  console.error('Usage: node scripts/report.js <project-name>');
  process.exit(1);
}

const projectDir = join(import.meta.dirname, '..', 'projects', projectName);
const rawPostsFile = join(projectDir, 'raw-posts.json');
const transcriptsDir = join(projectDir, 'transcripts');
const hooksDir = join(projectDir, 'hook-screenshots');
const reportFile = join(projectDir, 'report.md');

if (!existsSync(rawPostsFile)) {
  console.error('No raw-posts.json found. Run scrape.js first.');
  process.exit(1);
}

const data = JSON.parse(readFileSync(rawPostsFile, 'utf8'));
const config = existsSync(join(projectDir, 'config.json'))
  ? JSON.parse(readFileSync(join(projectDir, 'config.json'), 'utf8'))
  : {};

// Parse engagement to number
function parseEngagement(post) {
  const likeStr = post.likes || post.likesFromBtn || '';
  const contextStr = post.likesContext || '';
  const viewStr = post.views || '';

  let match = likeStr.match(/([\d,.]+)\s*([KkMm])?/);
  if (match) {
    let num = parseFloat(match[1].replace(/,/g, ''));
    if (match[2]?.match(/[Kk]/)) num *= 1000;
    if (match[2]?.match(/[Mm]/)) num *= 1000000;
    return num;
  }

  match = contextStr.match(/and\s+([\d,.]+)\s*([KkMm])?\s*others/i);
  if (match) {
    let num = parseFloat(match[1].replace(/,/g, ''));
    if (match[2]?.match(/[Kk]/)) num *= 1000;
    if (match[2]?.match(/[Mm]/)) num *= 1000000;
    return num + 1;
  }

  match = viewStr.match(/([\d,.]+)\s*([KkMm])?/);
  if (match) {
    let num = parseFloat(match[1].replace(/,/g, ''));
    if (match[2]?.match(/[Kk]/)) num *= 1000;
    if (match[2]?.match(/[Mm]/)) num *= 1000000;
    return num;
  }

  return 0;
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return num.toLocaleString();
}

function loadTranscript(postId) {
  const txtFile = join(transcriptsDir, `${postId}.txt`);
  if (existsSync(txtFile)) return readFileSync(txtFile, 'utf8').trim();
  return null;
}

function getPostId(post) {
  return (post.href || post.url || '').match(/\/(p|reel)\/([\w-]+)/)?.[2] || '';
}

function hasHookScreenshots(postId) {
  if (!existsSync(hooksDir)) return false;
  return existsSync(join(hooksDir, `${postId}_0s.jpg`));
}

function extractFirstLine(text) {
  if (!text) return '';
  return text.split('\n').find(l => l.trim().length > 5)?.trim() || text.substring(0, 100);
}

// =============================================================================
// Build report
// =============================================================================

const posts = data.posts.map(p => ({
  ...p,
  engagementNum: parseEngagement(p),
  postId: getPostId(p),
  transcript: loadTranscript(getPostId(p)),
  hasScreenshots: hasHookScreenshots(getPostId(p)),
}));

posts.sort((a, b) => b.engagementNum - a.engagementNum);

const reels = posts.filter(p => p.type === 'reel');
const images = posts.filter(p => p.type === 'image');
const withTranscripts = posts.filter(p => p.transcript);

const top20 = posts.slice(0, 20);

const nicheTitle = config.niche || projectName.replace(/-/g, ' ');
const niceDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const reelPct = posts.length ? Math.round(reels.length / posts.length * 100) : 0;

const lines = [];
lines.push(`# Instagram Research Report: ${nicheTitle}`);
lines.push('');
lines.push(`_Generated ${niceDate}_`);
lines.push('');
lines.push('## Overview');
lines.push('');
lines.push(`- **Project:** ${config.name || projectName}`);
lines.push(`- **Niche:** ${config.niche || projectName}`);
lines.push(`- **Search terms:** ${(config.searchTerms || []).map(t => '#' + t).join(', ') || 'N/A'}`);
lines.push(`- **Competitors:** ${(config.competitors || []).join(', ') || 'None'}`);
lines.push(`- **Posts analyzed:** ${posts.length} (${reels.length} reels, ${images.length} images)`);
lines.push(`- **Reels share:** ${reelPct}%`);
lines.push(`- **Transcribed:** ${withTranscripts.length}`);
lines.push(`- **Visual hooks captured:** ${posts.filter(p => p.hasScreenshots).length}`);
lines.push('');

lines.push('## Top Performing Posts');
lines.push('');

top20.forEach((post, i) => {
  const rank = i + 1;
  const author = post.author || 'unknown';
  const url = post.url || ('https://www.instagram.com' + post.href);
  const eng = post.likes || formatNumber(post.engagementNum) || 'no data';
  const comments = post.comments || post.commentsCount || '';
  const hook = post.transcript ? extractFirstLine(post.transcript) : '';

  lines.push(`### ${rank}. @${author} — ${(post.type || 'reel').toUpperCase()}`);
  lines.push('');
  lines.push(`- **Engagement:** ${eng}${comments ? ` | ${comments}` : ''}`);
  lines.push(`- **URL:** ${url}`);
  if (post.date) lines.push(`- **Date:** ${post.date}`);
  if (post.hasScreenshots) {
    lines.push(`- **Visual hook screenshots:** \`hook-screenshots/${post.postId}_0s.jpg\`, \`_1s.jpg\`, \`_2s.jpg\``);
  }
  if (hook) {
    lines.push(`- **Spoken hook:** "${hook}"`);
  }
  const caption = (post.caption || '').trim();
  if (caption && caption.length > 20) {
    lines.push(`- **Caption:** ${caption.substring(0, 300)}${caption.length > 300 ? '…' : ''}`);
  }
  if (post.transcript) {
    lines.push('');
    lines.push('<details><summary>Full transcript</summary>');
    lines.push('');
    lines.push(post.transcript);
    lines.push('');
    lines.push('</details>');
  }
  lines.push('');
});

writeFileSync(reportFile, lines.join('\n'));

console.log(`\n========================================`);
console.log(`  Markdown report generated!`);
console.log(`  ${reportFile}`);
console.log(`========================================`);
console.log(`  Posts: ${posts.length}`);
console.log(`  Top performers listed: ${top20.length}`);
console.log(`  Transcripts: ${withTranscripts.length}`);
console.log(`========================================`);
