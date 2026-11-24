import fs from 'node:fs';
import path from 'node:path';
import { CommandInvocation, CommandInvocationError, NativeExecutableInvocation, NodeScriptInvocation } from './command-invocation.js';

const CMD_META_CHARACTERS = new Set('()[]%!^"`<>&|;, *?');
function escapeCmdSyntax(text) {
  return [...text].map((character) => CMD_META_CHARACTERS.has(character) ? '^' + character : character).join('');
}
function quoteWindowsArgument(value) {
  let quoted = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === '\\') { slashes += 1; continue; }
    quoted += '\\'.repeat(character === '"' ? slashes * 2 + 1 : slashes) + character;
    slashes = 0;
  }
  return quoted + '\\'.repeat(slashes * 2) + '"';
}

/** Internal cmd.exe adapter; persistence keeps the original literal invocation. */
export class WindowsBatchInvocation extends CommandInvocation {
  constructor(original, batchFile, interpreter) {
    if (!(original instanceof NativeExecutableInvocation)) throw new CommandInvocationError('batch adaptation requires a native invocation');
    if ([batchFile, ...original.args].some((value) => /[\r\n]/.test(value))) throw new CommandInvocationError('Windows batch parameters cannot encode line breaks; configure a native executable or Node script');
    // npm's forwarding .bin shim adds another cmd parse. Ordinary batch
    // parameters use the single interpreter escape layer.
    const forwardingShim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(batchFile);
    const encoded = original.args.map((argument) => {
      const escaped = escapeCmdSyntax(quoteWindowsArgument(argument));
      return forwardingShim ? escapeCmdSyntax(escaped) : escaped;
    });
    const command = [escapeCmdSyntax(batchFile), ...encoded].join(' ');
    super({ ...original.processOptions(), executable: interpreter, args: ['/d', '/s', '/v:off', '/c', '"' + command + '"'] });
    this.original = original;
    this.batchFile = batchFile;
    Object.freeze(this);
  }
  processOptions() { return { ...super.processOptions(), windowsVerbatimArguments: true }; }
  toJSON() { return this.original.toJSON(); }
}

/** Resolve Windows installed Node CLI shims without routing arguments through cmd.exe. */
export function resolveExecutableInvocation(invocation, { platform = process.platform, environment = process.env } = {}) {
  if (!(invocation instanceof CommandInvocation)) throw new CommandInvocationError('executable resolution requires a typed invocation');
  if (platform !== 'win32' || invocation instanceof NodeScriptInvocation) return invocation;
  const env = invocation.env ?? environment;
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const executable = invocation.executable;
  const directories = /[\\/]/.test(executable) ? [''] : pathValue.split(';');
  const extension = path.win32.extname(executable);
  const candidates = directories.flatMap((directory) => {
    const base = directory ? path.win32.resolve(invocation.cwd ?? process.cwd(), directory, executable)
      : path.win32.resolve(invocation.cwd ?? process.cwd(), executable);
    return extension ? [base] : ['.exe', '.com', '.cmd', '.bat'].map((suffix) => base + suffix);
  });
  const selected = candidates.find((candidate) => fs.existsSync(candidate));
  if (!selected) return invocation; // Normal spawn ENOENT remains the diagnostic authority.
  if (!/\.(cmd|bat)$/i.test(selected)) return new NativeExecutableInvocation({ ...invocation.toJSON(), executable: selected });
  const content = fs.readFileSync(selected, 'utf8');
  // Recognize npm/cmd-shim's complete argument-free Node template. Merely
  // finding a quoted .js path would silently discard custom setup or shebang
  // flags. Other batch programs retain their invocation through the batch adapter.
  const normalized = content.replace(/\r\n/g, '\n');
  const target = normalized.match(/"%_prog%"  "%dp0%\\([^"\r\n]+)" %\*\n$/)?.[1];
  if (target !== undefined) {
    const canonical = [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start',
      'SETLOCAL', 'CALL :find_dp0', '', 'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')', '',
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${target}" %*`, '',
    ].join('\n');
    const script = path.win32.resolve(path.win32.dirname(selected), target);
    if (normalized === canonical && fs.existsSync(script)) {
      return new NodeScriptInvocation({ ...invocation.processOptions(), script, args: invocation.args });
    }
  }
  const interpreter = Object.entries(environment).find(([key]) => key.toUpperCase() === 'COMSPEC')?.[1] ?? 'cmd.exe';
  return new WindowsBatchInvocation(invocation, selected, interpreter);
}
