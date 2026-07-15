#!/usr/bin/env node
/**
 * Static contract for /brain and /brain-save skills.
 * Zero deps — node:test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function skill(name) {
  const p = join(ROOT, 'skills', name, 'SKILL.md');
  assert.ok(existsSync(p), `missing ${p}`);
  return readFileSync(p, 'utf8');
}

function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, 'missing YAML frontmatter');
  return m[1];
}

describe('skill contract — brain', () => {
  const md = skill('brain');
  const fm = frontmatter(md);

  it('name is brain', () => {
    assert.match(fm, /^name:\s*brain\s*$/m);
  });

  it('documents /brain trigger', () => {
    assert.match(md, /\/brain\b/);
  });

  it('is read-oriented (search)', () => {
    assert.match(md, /brain_search|Search the governed/i);
  });

  it('points write work at /brain-save', () => {
    assert.match(md, /\/brain-save/);
  });
});

describe('skill contract — brain-save', () => {
  const md = skill('brain-save');
  const fm = frontmatter(md);

  it('name is brain-save', () => {
    assert.match(fm, /^name:\s*brain-save\s*$/m);
  });

  it('documents /brain-save trigger', () => {
    assert.match(md, /\/brain-save\b/);
  });

  it('is write-oriented (capture)', () => {
    assert.match(md, /brain_capture|capture/i);
  });

  it('disable-model-invocation is true (never auto-write)', () => {
    assert.match(fm, /disable-model-invocation:\s*true/);
  });
});
