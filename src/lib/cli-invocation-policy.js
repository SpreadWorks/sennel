/** Trusted core metadata determines storage before container initialization. */
export class CliInvocationPolicy {
  constructor(registry, argv) {
    const [head] = argv;
    const builtinHelp = head === undefined || ['help', '-h', '--help', '-v', '-V', '--version'].includes(head);
    let definition = null;
    let consumed = 0;
    for (let length = 1; length <= argv.length; length += 1) {
      const candidate = registry.find(argv.slice(0, length));
      if (candidate === null) break;
      definition = candidate;
      consumed = length;
    }
    const arguments_ = argv.slice(consumed);
    const schema = definition?.args ?? {};
    const flags = new Set(schema.flags ?? []);
    const values = new Set(schema.options ?? []);
    const optional = new Set(schema.optionalOptions ?? []);
    let dryRun = false;
    let help = builtinHelp;
    let validOptions = true;
    for (let index = 0; index < arguments_.length; index += 1) {
      const token = schema.aliases?.[arguments_[index]] ?? arguments_[index];
      if (token === '--') break;
      if (values.has(token)) { if (arguments_[++index] === undefined) validOptions = false; continue; }
      if (optional.has(token)) { if (arguments_[index + 1] !== undefined && !arguments_[index + 1].startsWith('-')) index += 1; continue; }
      if (token === '--help' || token === '-h') { help = definition !== null && arguments_.every((argument) => ['--help', '-h'].includes(argument)); continue; }
      if (token === '--dry-run' && flags.has(token)) { dryRun = true; continue; }
      if (token.startsWith('-') && !flags.has(token)) validOptions = false;
    }
    this.readOnly = builtinHelp || definition?.readOnly === true || validOptions && (help || dryRun);
    this.definition = definition;
    this.help = help;
    this.inherited = head === 'command' && !help;
    this.flow = head === 'flow';
    this.migration = definition?.migration === true;
    Object.freeze(this);
  }
}
