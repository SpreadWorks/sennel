/** One registered Step's shared execution decision and its two consumers. */
export class StepExecutionContract {
  #select;
  #project;
  #execute;

  constructor({ select, project, execute }) {
    for (const [name, implementation] of [["select", select], ["project", project], ["execute", execute]]) {
      if (typeof implementation !== "function" || !implementation.name || implementation.name.startsWith("bound ")) {
        throw new TypeError(`StepExecutionContract requires a named ${name} function`);
      }
    }
    this.#select = select;
    this.#project = project;
    this.#execute = execute;
    Object.freeze(this);
  }

  select(input) { return this.#select(input); }
  project(selection, input) { return this.#project(selection, input); }
  execute(selection, input) { return this.#execute(selection, input); }
  get selectorName() { return this.#select.name; }
  get projectorName() { return this.#project.name; }
  get executorName() { return this.#execute.name; }
}
