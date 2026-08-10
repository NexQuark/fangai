#!/usr/bin/env node

/**
 * fang — Any CLI coding agent. A2A citizen. One command.
 */

import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { detectAdapter, ALL_ADAPTERS } from './adapters.ts';
import { detectAdapters } from './core.ts';
import { createFangServer } from './server.ts';
import { FangClient, discoverAgents } from './client.ts';

const program = new Command()
  .name('fang')
  .description('Any CLI coding agent. A2A citizen. One command. 🐺')
  .version('0.1.0')
  .addHelpText('after', `
Examples:
  $ fang detect                                # See which CLI agents you have
  $ fang wrap "pi --mode rpc" --port 3000       # Wrap pi (most common)
  $ fang wrap "aider --no-auto-commits" -p 3001 # Wrap aider
  $ fang wrap "claude-code" --cwd ~/myproject   # Wrap with custom workdir
  $ fang serve -c fang.yaml                     # Start all agents from config
  $ fang send "fix the bug in server.ts"        # Send task to running fang
  $ fang discover                              # Find fang servers on LAN
  $ fang card -p 3000                           # Inspect an agent's A2A card

Typical workflow:
  1. fang detect                    (find your agents)
  2. fang wrap "pi --mode rpc" -p N  (expose one as A2A server)
  3. fang send "..."                (or use any A2A client)

Docs: https://github.com/kariemSeiam/fangai
`);

program.command('wrap')
  .description('Wrap a CLI agent as an A2A-compliant server')
  .argument('<command>', 'CLI command (e.g. "pi --mode rpc")')
  .requiredOption('-p, --port <number>', 'Port', parseInt)
  .option('-n, --name <name>', 'Agent name')
  .option('--api-key <key>', 'API key for auth')
  .option('--cwd <path>', 'Working directory')
  .option('--timeout <seconds>', 'Task timeout in seconds', '300')
  .option('--cors', 'Enable CORS')
  .addHelpText('after', `
Examples:
  $ fang wrap "pi --mode rpc" --port 3000
  $ fang wrap "aider" --api-key secret --port 3001
  $ fang wrap "claude-code" --cwd ~/project --timeout 600
  $ fang wrap "codex --quiet" --port 3002 --cors

Common pi flags (most common wrapped agent):
  --mode rpc         Run in non-interactive RPC mode (REQUIRED for A2A)
  -i                 Interactive mode (NOT recommended for A2A)
  --model <name>     Pick model (e.g. claude-sonnet-4-5, gpt-5)
  --no-color         Strip ANSI colors from output
  --cwd <path>       Set working directory

Full fang wrap syntax: fang wrap "<agent-binary> [agent-flags...]" [fang-flags]
`)
  .action(async (command: string, opts: any) => {
    const port = parseInt(opts.port);
    const adapter = detectAdapter(command);

    console.log(`\n  🐺 ${adapter.displayName} (${adapter.mode}, tier ${adapter.tier}) on :${port}`);
    console.log(`     Wrapping: ${command}\n`);

    const server = createFangServer({
      cli: command, adapter, port,
      name: opts.name,
      workdir: opts.cwd ? resolve(opts.cwd) : undefined,
      apiKey: opts.apiKey,
      taskTimeout: parseInt(opts.timeout),
      cors: opts.cors,
    });

    const app = express();
    server.setupApp(app);

    app.listen(port, () => {
      console.log(`  ✓ ${opts.name || adapter.displayName + '-agent'}`);
      console.log(`    Card:   http://localhost:${port}/.well-known/agent-card.json`);
      console.log(`    RPC:    http://localhost:${port}/a2a/jsonrpc`);
      console.log(`    REST:   http://localhost:${port}/a2a/rest`);
      console.log(`    Health: http://localhost:${port}/health\n`);
    });

    const stop = async () => { await server.executor.shutdown(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

program.command('serve')
  .description('Start agents from fang.yaml')
  .option('-c, --config <path>', 'Config file', 'fang.yaml')
  .addHelpText('after', `
Examples:
  $ fang serve                   # Use ./fang.yaml
  $ fang serve -c ~/prod.yaml    # Use specific config

fang.yaml schema (one entry per agent):

  # fang.yaml
  agents:
    pi:                          # agent name (used in 'fang send --name pi')
      cli: "pi --mode rpc"        # required: shell command to wrap
      port: 3001                  # required: HTTP port
      timeout: 600                # optional: task timeout (seconds, default 300)
      api_key: "secret"           # optional: bearer auth on /a2a/*
      cwd: "/path/to/project"     # optional: agent's working directory
      cors: true                  # optional: enable CORS

    claude:
      cli: "claude"
      port: 3002

    aider:
      cli: "aider --no-auto-commits"
      port: 3003
      timeout: 300

After editing fang.yaml, run 'fang serve' to start all agents at once.
See fang.yaml.example for a full starter file.
`)
  .action(async (opts: any) => {
    const configPath = resolve(opts.config);
    if (!existsSync(configPath)) { console.error(`Config not found: ${configPath}`); process.exit(1); }

    const { parse } = await import('yaml');
    const yaml = parse(readFileSync(configPath, 'utf-8')) as any;
    const agents = yaml.agents as Record<string, any> || {};

    console.log(`\n  🐺 Starting agents from ${configPath}\n`);
    const executors: any[] = [];

    for (const [name, cfg] of Object.entries(agents)) {
      const cli = cfg.cli as string;
      const port = parseInt(cfg.port) || 3001;
      const adapter = detectAdapter(cli);

      const server = createFangServer({
        cli, adapter, port, name,
        workdir: cfg.cwd ? resolve(cfg.cwd) : undefined,
        apiKey: cfg.api_key,
        taskTimeout: cfg.timeout ? parseInt(cfg.timeout) : undefined,
      });

      const app = express();
      server.setupApp(app);
      executors.push(server.executor);

      app.listen(port, () => console.log(`  ✓ ${name} on :${port} (${adapter.mode}, tier ${adapter.tier})`));
    }
    console.log();

    const stop = async () => {
      await Promise.all(executors.map((e: any) => e.shutdown()));
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

program.command('detect')
  .description('Detect installed CLI coding agents')
  .addHelpText('after', `
Examples:
  $ fang detect
  $ fang detect | grep -i pi

Looks for: pi, aider, claude-code, codex, cursor, opencode, generic CLIs.
`)
  .action(async () => {
    console.log('\n  🐺 Scanning for CLI agents...\n');
    const results = await detectAdapters(ALL_ADAPTERS);

    if (results.length === 0) {
      console.log('  No CLI agents found on PATH.\n');
      return;
    }

    for (const { adapter, detection } of results) {
      const tierLabel = ['', '⭐ Tier 1', '🔶 Tier 2', '⚪ Tier 3'][adapter.tier];
      console.log(`  ✓ ${adapter.displayName.padEnd(14)} ${tierLabel}`);
      console.log(`    Binary: ${detection.binary} (${detection.version})`);
      console.log(`    Path:   ${detection.path}`);
      console.log(`    Mode:   ${adapter.mode}`);
      console.log(`    Protocol: ${detection.protocol}`);
      console.log(`    Skills: ${adapter.skills.map(s => s.name).join(', ')}`);
      console.log();
    }
  });

program.command('discover')
  .description('Discover running fang agents')
  .option('--json', 'JSON output')
  .addHelpText('after', `
Examples:
  $ fang discover
  $ fang discover --json | jq '.[] | .url'
  $ fang discover --json > agents.json  # Save for scripting
`)
  .action(async (opts: any) => {
    const agents = await discoverAgents();
    if (opts.json) { console.log(JSON.stringify(agents, null, 2)); return; }
    if (!agents.length) { console.log('\n  No fang agents running.\n'); return; }
    console.log('\n  🐺 Running agents:\n');
    for (const a of agents) console.log(`  ✓ ${a.name} — ${a.url}`);
    console.log();
  });

program.command('send')
  .description('Send a task to a running agent')
  .argument('<message>', 'Task message')
  .option('-p, --port <number>', 'Port', '3001')
  .option('-u, --url <url>', 'Full URL')
  .addHelpText('after', `
Examples:
  $ fang send "list files in current dir"
  $ fang send "fix the bug" --port 30100
  $ fang send "explain this code" --url http://agent.local:3001
  $ fang send "refactor src/server.ts to use async/await" -p 3000

Notes:
  - The target agent must be running (use 'fang discover' to find one)
  - Default port is 3001 (override with --port or --url)
`)
  .action(async (message: string, opts: any) => {
    const url = opts.url || `http://localhost:${opts.port}`;
    const client = new FangClient(url);

    try {
      const result = await client.send(message);
      if (result.error) console.log(`\n  ✗ ${result.error}\n`);
      else if (result.text) console.log(`\n${result.text}\n`);
      else console.log(JSON.stringify(result, null, 2));
    } catch (err: any) {
      console.error(`\n  ✗ ${err.message}\n`);
    }
  });

program.command('card')
  .description('Show agent card')
  .option('-p, --port <number>', 'Port', '3001')
  .addHelpText('after', `
Examples:
  $ fang card                    # Fetch card from default port 3001
  $ fang card -p 3000 | jq .     # Fetch + format
`)
  .action(async (opts: any) => {
    const client = new FangClient(`http://localhost:${opts.port}`);
    const card = await client.getCard();
    console.log(JSON.stringify(card, null, 2));
  });

program.parse();
