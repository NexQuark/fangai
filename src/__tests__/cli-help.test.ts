/**
 * TDD test: CLI `--help` output must include typical fang + pi usage
 * examples so users can discover common patterns without reading docs.
 *
 * Each test spawns the real CLI as a child process and inspects stdout,
 * mirroring the prod-style smoke checks rather than reading source.
 *
 * Acceptance follows the boundary set in the handoff: assert that key
 * content EXISTS, not that it matches a specific format — regex tolerance
 * is intentional (Commander.js can rewrap / re-indent the text).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/__tests__/foo.test.ts → src/cli.ts
const CLI = resolve(__dirname, '..', 'cli.ts');

/**
 * Spawn the real CLI with `--help` and return its combined stdout/stderr.
 * The actual CLI prints help to stdout via Commander's default handler;
 * we keep stderr merged so a future refactor (e.g. writing help to
 * stderr) doesn't silently break this test.
 */
function runHelp(args: readonly string[]): string {
  return execFileSync(
    'node',
    ['--experimental-strip-types', '--no-warnings', CLI, ...args],
    { encoding: 'utf8', timeout: 10_000 },
  );
}

describe('CLI --help output (discoverability)', () => {
  describe('fang --help (top-level)', () => {
    const out = runHelp(['--help']);

    it('lists the existing subcommands so help does not regress', () => {
      // Boundary: existing commands MUST remain visible. Lose any one and
      // a user's muscle-memory invocation breaks silently.
      for (const cmd of ['wrap', 'serve', 'detect', 'discover', 'send', 'card']) {
        expect(out).toMatch(new RegExp(`\\b${cmd}\\b`));
      }
    });

    it('shows an Examples: section with the 8 typical invocations', () => {
      // The handoff promised "8 typical examples" plus a 3-step workflow.
      // We assert presence of each command that should appear in the
      // Examples block — commander renders `Examples:` then `$ fang <cmd>`.
      expect(out).toMatch(/Examples?:/);
      // The 8 commands the prod owner wired into the Examples block:
      // detect / wrap / wrap (aider) / wrap (claude-code) / serve / send /
      // discover / card. We just check the command verbs are referenced.
      for (const verb of ['detect', 'wrap', 'serve', 'send', 'discover', 'card']) {
        expect(out).toMatch(new RegExp(`fang ${verb}\\b`));
      }
    });

    it('includes a "Typical workflow" 3-step guide', () => {
      // The prod owner wrote a 3-step "Typical workflow" section to
      // teach the detect → wrap → send pattern. We check that the
      // numbered workflow mentions detect and wrap (the two non-optional
      // steps in the example pipeline) rather than asserting exact text.
      expect(out).toMatch(/Typical workflow/);
      expect(out).toMatch(/fang detect/);
      expect(out).toMatch(/fang wrap/);
    });
  });

  describe('fang wrap --help', () => {
    const out = runHelp(['wrap', '--help']);

    it('shows Examples: for the wrap subcommand', () => {
      expect(out).toMatch(/Examples?:/);
      // At least one wrap example should reference pi (the most common
      // wrapped agent) so the user sees the canonical invocation.
      expect(out).toMatch(/fang wrap ["']?pi/i);
    });

    it('documents "Common pi flags" with --mode rpc', () => {
      // The handoff's #2 ask: pi-specific guidance inside `wrap --help`
      // so users don't have to read pi's own docs to find --mode rpc.
      expect(out).toMatch(/Common pi flags/);
      // --mode rpc is REQUIRED for A2A — must be the headline guidance.
      expect(out).toMatch(/--mode rpc/);
    });
  });

  describe('fang serve --help', () => {
    const out = runHelp(['serve', '--help']);

    it('shows an Examples: section for serve', () => {
      expect(out).toMatch(/Examples?:/);
    });

    it('embeds a fang.yaml schema with at least 2 example agents', () => {
      // The handoff's #3 ask: serve --help must inline a fang.yaml
      // example so users don't have to read fang.yaml.example. We
      // require schema fields (agents:, cli:, port:) plus ≥ 2 distinct
      // top-level agent names under `agents:`.
      expect(out).toMatch(/agents:/);
      expect(out).toMatch(/cli:/);
      expect(out).toMatch(/port:/);

      // Extract top-level keys under `agents:` (2-4 space indent per
      // Commander's default rendering — tolerance is intentional).
      const agentNames = (out.match(/^[ ]{2,4}([A-Za-z_][\w-]*):\s*(#.*)?$/gm) || [])
        .map(m => m.trim().split(':')[0]);
      // The prod owner put pi + claude + aider in the schema example.
      // We just assert ≥ 2 distinct agent names so a single-agent
      // regression would still be caught.
      const distinct = new Set(agentNames);
      expect(distinct.size).toBeGreaterThanOrEqual(2);
    });
  });

  describe('other subcommands each have their own Examples:', () => {
    // The handoff said "其他 4 个 subcommand 各有 Examples". commander
    // does not by default require this — if any regression drops the
    // Examples: block from a subcommand, the user has to read README.

    it('fang send --help shows Examples:', () => {
      const out = runHelp(['send', '--help']);
      expect(out).toMatch(/Examples?:/);
      // Send is the user-facing "do work" command — must show at least
      // one real invocation pattern with a quoted message string.
      expect(out).toMatch(/fang send ["']/);
    });

    it('fang discover --help shows Examples:', () => {
      const out = runHelp(['discover', '--help']);
      expect(out).toMatch(/Examples?:/);
    });

    it('fang card --help shows Examples:', () => {
      const out = runHelp(['card', '--help']);
      expect(out).toMatch(/Examples?:/);
    });

    it('fang detect --help shows Examples:', () => {
      const out = runHelp(['detect', '--help']);
      expect(out).toMatch(/Examples?:/);
    });
  });
});