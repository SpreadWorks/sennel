class PromptBuilder {
  constructor() {
    this._role = null;
    this._rules = null;
    this._jsonSchema = null;
    this._fmtFallback = null;
    this._systemSections = [];
    this._userSections = [];
  }

  setRole(text) {
    this._role = text;
    return this;
  }

  setRules(text) {
    this._rules = text;
    return this;
  }

  setJsonSchema(schema) {
    this._jsonSchema = schema;
    return this;
  }

  setFmtFallback(text) {
    this._fmtFallback = text;
    return this;
  }

  addSystemPrompt(header, content) {
    this._systemSections.push({ header, content });
    return this;
  }

  addUserPrompt(header, content) {
    this._userSections.push({ header, content, raw: false });
    return this;
  }

  addUserRaw(markdown) {
    this._userSections.push({ content: markdown, raw: true });
    return this;
  }

  build() {
    const systemParts = [];
    if (this._role) systemParts.push(this._role);
    if (this._rules) systemParts.push(this._rules);
    for (const { header, content } of this._systemSections) {
      systemParts.push(`${header}\n${content}`);
    }
    const systemPrompt = systemParts.length > 0 ? systemParts.join("\n\n") : null;

    const userParts = [];
    for (const { header, content, raw } of this._userSections) {
      if (raw) {
        userParts.push(content);
      } else {
        userParts.push(`${header}\n${content}`);
      }
    }
    const userPrompt = userParts.join("\n\n");

    return {
      systemPrompt,
      userPrompt,
      jsonSchema: this._jsonSchema ?? null,
      fmtFallback: this._fmtFallback ?? null,
    };
  }
}

export { PromptBuilder };
