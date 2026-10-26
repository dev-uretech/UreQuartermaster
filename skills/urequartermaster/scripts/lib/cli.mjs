// qm's command table: usage text, routing of argv to a handler, and the background update tick
// before the commands that use the index. Handlers live in commands/; qm.mjs only calls dispatch.
import { VERSION } from './version.mjs';
import { cmdHook } from './agent/hook.mjs';
import { autoUpdateTick } from './update/update.mjs';
import { UsageError } from './commands/common.mjs';
import { cmdSearch } from './commands/search.mjs';
import { cmdLoad } from './commands/load.mjs';
import { cmdList, cmdIndex } from './commands/list.mjs';
import { cmdAdd, cmdSync, cmdPark, cmdUnpark } from './commands/library.mjs';
import { cmdInit } from './commands/init.mjs';
import { cmdDoctor } from './commands/doctor.mjs';
import { cmdUpdate, cmdRollback } from './commands/update.mjs';

export { UsageError };

export const USAGE = `Usage:
  qm search <query>... [--limit N] [--kind skill|mcp|plugin|cli] [--json]
  qm load <name|id>
  qm list [--kind skill|mcp|plugin|cli] [--state installed|library|plugin-disabled|available] [--all]
  qm index [--json]
  qm add <url> [--name <collection>]
  qm sync
  qm park <skill>
  qm park --plugin <plugin> [--yes]
  qm unpark <skill> [--forget]
  qm init [--remove] [--dry-run] [--agent claude|codex|gemini|copilot|opencode]
  qm doctor
  qm update [--check]
  qm rollback
  qm hook   (reads a prompt JSON on stdin; used by the Claude Code hook)
  qm --version
  qm help`;

export function cmdVersion(out) { out(VERSION); return 0; }

// Commands that may start the background update check. Never the hook.
const TICK_COMMANDS = new Set(['search', 'load', 'index', 'list']);

/** Routes argv to a command; `deps` lets tests replace the hook, the commands and the tick. */
export function dispatch(argv, out, deps = {}) {
  const [cmd, ...rest] = argv;
  const commands = deps.commands || COMMANDS;
  if (cmd === '--version' || cmd === '-v') return cmdVersion(out);
  if (cmd === 'hook') return (deps.hook || cmdHook)(out);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { out(USAGE); return 0; }
  if (!cmd || !Object.hasOwn(commands, cmd)) throw new UsageError(cmd ? `Unknown command "${cmd}"` : 'No command given');
  if (TICK_COMMANDS.has(cmd)) (deps.tick || autoUpdateTick)({});
  return commands[cmd](rest, out);
}

export const COMMANDS = { update: cmdUpdate, rollback: cmdRollback, init: cmdInit, doctor: cmdDoctor, search: cmdSearch, load: cmdLoad, list: cmdList, index: cmdIndex, add: cmdAdd, sync: cmdSync, park: cmdPark, unpark: cmdUnpark };
