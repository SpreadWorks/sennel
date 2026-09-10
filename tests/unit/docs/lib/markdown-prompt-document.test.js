import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MarkdownPromptDocument, MarkdownBlockTranslationResult, MarkdownTranslationPromptEnvelope } from "../../../../src/docs/lib/markdown-prompt-document.js";

describe("Markdown protected translation boundaries", () => {
  it("retains the requested Japanese writing style and natural translation instructions", () => {
    for (const [tone, expected] of [["polite", "です/ます"], ["formal", "である"], ["casual", "口語的"]]) {
      const envelope = new MarkdownTranslationPromptEnvelope({ fromLang: "en", toLang: "ja", documentStyle: { tone } });
      const request = envelope.build(new MarkdownPromptDocument({ id: tone, content: "Prose\n" }).elements, { index: 0, count: 1 });
      assert.ok(request.systemPrompt.includes(expected));
      assert.match(request.systemPrompt, /Do not translate word-by-word/);
    }
  });

  it("keeps shorter and non-closing fence lines inside their original protected block", () => {
    const code = "````md\n```js\ncontent\n```\n```` trailing text\nremaining code\n````\n";
    const document = new MarkdownPromptDocument({ id: "fence", content: `${code}\nTranslate prose\n` });
    assert.equal(document.elements[0].text, code);
    assert.equal(document.elements[0].protectedBlock, true);
    assert.equal(document.elements.at(-1).text, "Translate prose\n");
    assert.throws(() => new MarkdownBlockTranslationResult({ element: document.elements[0], text: code.replace("content", "changed") }),
      (error) => error.code === "PROMPT_RESPONSE_INVALID");
  });

  it("protects blockquote-contained code fences without blocking surrounding prose translation", () => {
    const source = [
      "Before prose.",
      "",
      "> ```js",
      "> const stable = 1;",
      "> ```",
      "",
      "After prose.",
      "",
    ].join("\n");
    const document = new MarkdownPromptDocument({ id: "blockquote-fence", content: source });
    const fence = document.elements[2];

    assert.deepEqual(document.elements.map((element) => element.blockKind), ["paragraph", "blank", "code-fence", "blank", "paragraph"]);
    assert.equal(fence.text, "> ```js\n> const stable = 1;\n> ```\n");
    assert.equal(fence.protectedBlock, true);
    assert.equal(fence.isPartitionable(), false);
    assert.throws(
      () => new MarkdownBlockTranslationResult({ element: fence, text: fence.text.replace("stable", "changed") }),
      (error) => error.code === "PROMPT_RESPONSE_INVALID",
    );
    assert.doesNotThrow(() => new MarkdownBlockTranslationResult({
      element: document.elements[0],
      text: "翻訳前の文章。\n",
    }));
  });

  it("matches nested list and blockquote fence closers without accepting shorter or trailing fences", () => {
    const code = [
      "- > ````js",
      "  > ```",
      "  > const stable = 1;",
      "  > ```` trailing text",
      "  > remaining code",
      "  > ````",
      "",
    ].join("\n");
    const document = new MarkdownPromptDocument({ id: "nested-fence", content: `${code}Translate prose.\n` });

    assert.equal(document.elements[0].blockKind, "code-fence");
    assert.equal(document.elements[0].text, code);
    assert.equal(document.elements[0].protectedBlock, true);
    assert.equal(document.elements[1].text, "Translate prose.\n");
    assert.throws(
      () => new MarkdownBlockTranslationResult({ element: document.elements[0], text: code.replace("stable", "changed") }),
      (error) => error.code === "PROMPT_RESPONSE_INVALID",
    );
  });

  it("protects list-contained fences whose closer uses list continuation indentation", () => {
    const source = "- ```js\n  const stable = 1;\n  ```\n\nTranslate prose.\n";
    const document = new MarkdownPromptDocument({ id: "list-fence", content: source });

    assert.equal(document.elements[0].blockKind, "code-fence");
    assert.equal(document.elements[0].text, "- ```js\n  const stable = 1;\n  ```\n");
    assert.equal(document.elements[0].protectedBlock, true);
    assert.equal(document.elements[2].text, "Translate prose.\n");
  });

  it("stops an unclosed blockquote fence when its quote container ends", () => {
    const source = "> ```js\n> const stable = 1;\n\nOutside prose.\n";
    const document = new MarkdownPromptDocument({ id: "quote-boundary", content: source });

    assert.deepEqual(document.elements.map((element) => element.blockKind), ["code-fence", "blank", "paragraph"]);
    assert.equal(document.elements[0].text, "> ```js\n> const stable = 1;\n");
    assert.equal(document.elements[2].text, "Outside prose.\n");
  });

  it("recognizes a fence indented as an ordered-list continuation after blank and continued item prose", () => {
    const source = "10. Item\n\n    Continued item prose.\n\n    ```js\n    const stable = 1;\n    ```\n\nTranslate prose.\n";
    const document = new MarkdownPromptDocument({ id: "ordered-list-fence", content: source });

    assert.equal(document.elements[4].blockKind, "code-fence");
    assert.equal(document.elements[4].text, "    ```js\n    const stable = 1;\n    ```\n");
    assert.equal(document.elements[4].protectedBlock, true);
    assert.equal(document.elements[6].text, "Translate prose.\n");
  });

  it("tracks ordered-list fence boundaries through quote and list container transitions", () => {
    for (const { id, source, code, outside } of [
      {
        id: "quoted-ordered-list",
        source: "> 10. Item\n>\n>     ```js\n>     const stable = 1;\n>     ```\n",
        code: ">     ```js\n>     const stable = 1;\n>     ```\n",
        outside: null,
      },
      {
        id: "list-quoted-fence-boundary",
        source: "- > ```js\n  > const stable = 1;\n> Outside prose.\n",
        code: "- > ```js\n  > const stable = 1;\n",
        outside: "> Outside prose.\n",
      },
    ]) {
      const document = new MarkdownPromptDocument({ id, content: source });
      const fence = document.elements.find((element) => element.blockKind === "code-fence");

      assert.equal(fence?.text, code);
      assert.equal(fence?.protectedBlock, true);
      if (outside) assert.equal(document.elements.at(-1).text, outside);
    }
  });

  it("matches ordered quote and list prefixes around protected fences", () => {
    for (const { id, source, code, outside } of [
      {
        id: "quote-list-quote",
        source: "> - > ```js\n>   > const stable = 1;\n>   > ```\n\nOutside prose.\n",
        code: "> - > ```js\n>   > const stable = 1;\n>   > ```\n",
        outside: "Outside prose.\n",
      },
      {
        id: "list-quote-list",
        source: "- > - ```js\n  >   const stable = 1;\n  >   ```\n> Outside prose.\n",
        code: "- > - ```js\n  >   const stable = 1;\n  >   ```\n",
        outside: "> Outside prose.\n",
      },
    ]) {
      const document = new MarkdownPromptDocument({ id, content: source });
      const fence = document.elements.find((element) => element.blockKind === "code-fence");

      assert.equal(fence?.text, code);
      assert.equal(fence?.protectedBlock, true);
      assert.throws(
        () => new MarkdownBlockTranslationResult({ element: fence, text: code.replace("stable", "changed") }),
        (error) => error.code === "PROMPT_RESPONSE_INVALID",
      );
      assert.equal(document.elements.at(-1).text, outside);
    }
  });

  it("uses Markdown continuation indentation for fence closers and tab-indented list bodies", () => {
    for (const { id, source, code } of [
      {
        id: "overindented-closing",
        source: "- ```js\n      ```\n  const stable = 1;\n  ```\n\nOutside prose.\n",
        code: "- ```js\n      ```\n  const stable = 1;\n  ```\n",
      },
      {
        id: "tab-list-continuation",
        source: "-\t```js\n\tconst stable = 1;\n\t```\n\nOutside prose.\n",
        code: "-\t```js\n\tconst stable = 1;\n\t```\n",
      },
    ]) {
      const document = new MarkdownPromptDocument({ id, content: source });
      const fence = document.elements.find((element) => element.blockKind === "code-fence");

      assert.equal(fence?.text, code);
      assert.equal(fence?.protectedBlock, true);
      assert.equal(document.elements.at(-1).text, "Outside prose.\n");
    }
  });

  it("retains virtual tab indentation beyond a list continuation before matching fence boundaries", () => {
    for (const { id, source, code } of [
      {
        id: "tab-overshoots-list-indent",
        source: "- ```js\n\tconst stable = 1;\n  ```\n\nOutside prose.\n",
        code: "- ```js\n\tconst stable = 1;\n  ```\n",
      },
      {
        id: "tab-relative-overindented-closing",
        source: "- ```js\n\t  ```\n  const stable = 1;\n  ```\n\nOutside prose.\n",
        code: "- ```js\n\t  ```\n  const stable = 1;\n  ```\n",
      },
    ]) {
      const document = new MarkdownPromptDocument({ id, content: source });
      const fence = document.elements.find((element) => element.blockKind === "code-fence");

      assert.equal(fence?.text, code);
      assert.equal(fence?.protectedBlock, true);
      assert.equal(document.elements.at(-1).text, "Outside prose.\n");
    }
  });

  it("treats tab indentation consistently for root and quote-list fence boundaries", () => {
    for (const { id, source, code } of [
      {
        id: "root-tab-closing",
        source: "```js\n\t```\nconst stable = 1;\n```\n\nOutside prose.\n",
        code: "```js\n\t```\nconst stable = 1;\n```\n",
      },
      {
        id: "quote-list-tab-continuation",
        source: "> -\t```js\n> \tconst stable = 1;\n> \t```\n\nOutside prose.\n",
        code: "> -\t```js\n> \tconst stable = 1;\n> \t```\n",
      },
    ]) {
      const document = new MarkdownPromptDocument({ id, content: source });
      const fence = document.elements.find((element) => element.blockKind === "code-fence");

      assert.equal(fence?.text, code);
      assert.equal(fence?.protectedBlock, true);
      assert.equal(document.elements.at(-1).text, "Outside prose.\n");
    }
  });

  it("stops unclosed list fences at their continuation indentation for short and long markers", () => {
    for (const { id, source, code } of [
      {
        id: "unordered-list",
        source: "- Item\n\n  ```js\n  const stable = 1;\nOutside prose.\n",
        code: "  ```js\n  const stable = 1;\n",
      },
      {
        id: "ordered-list",
        source: "10. Item\n\n    ```js\n    const stable = 1;\nOutside prose.\n",
        code: "    ```js\n    const stable = 1;\n",
      },
    ]) {
      const document = new MarkdownPromptDocument({ id, content: source });
      const fence = document.elements.find((element) => element.blockKind === "code-fence");

      assert.equal(fence?.text, code);
      assert.equal(fence?.protectedBlock, true);
      assert.equal(document.elements.at(-1).text, "Outside prose.\n");
    }
  });

  it("keeps list fence context through contained structural blocks and clears it after an outdented heading", () => {
    for (const { id, structural } of [
      { id: "heading", structural: "  ## Heading\n" },
      { id: "table", structural: "  | Name |\n  | --- |\n  | Value |\n" },
      { id: "directive", structural: "  <!-- {{data(\"project.name\")}} -->\n" },
    ]) {
      const source = `- Item\n\n${structural}\n    \`\`\`js\n    const stable = 1;\n    \`\`\`\n`;
      const document = new MarkdownPromptDocument({ id, content: source });
      const fence = document.elements.find((element) => element.blockKind === "code-fence");

      assert.equal(fence?.text, "    ```js\n    const stable = 1;\n    ```\n");
      assert.equal(fence?.protectedBlock, true);
    }

    const outside = new MarkdownPromptDocument({
      id: "outside-heading",
      content: "- Item\n\n## Outside heading\n\n  ```js\n  const stable = 1;\nOutside prose.\n",
    });
    assert.equal(outside.elements.at(-1).blockKind, "code-fence");
    assert.equal(outside.elements.at(-1).text, "  ```js\n  const stable = 1;\nOutside prose.\n");
  });

  it("protects complete multiline directive comments using the canonical comment parser", () => {
    for (const directive of [
      '<!-- {{text({\n  prompt: "Keep directive prompt",\n  id: "summary"\n})}} -->\n',
      '<!--\n{{data("project.name")}}\n-->\n',
    ]) {
      const document = new MarkdownPromptDocument({ id: "directive", content: `${directive}Translate generated content\n` });
      assert.equal(document.elements[0].text, directive);
      assert.equal(document.elements[0].protectedBlock, true);
      assert.equal(document.elements[1].text, "Translate generated content\n");
      assert.throws(() => new MarkdownBlockTranslationResult({ element: document.elements[0], text: "changed directive" }),
        (error) => error.code === "PROMPT_RESPONSE_INVALID");
    }
  });

  it("allows only prompt and data-label translation inside template directives", () => {
    const source = [
      '<!-- {{text({prompt: "Write an overview.", mode: "deep"})}} -->',
      '<!-- {{data("base.project.scripts", {labels: "Script|Command", ignoreError: true})}} -->',
      "",
    ].join("\n");
    const document = new MarkdownPromptDocument({ id: "template", content: source, template: true });
    assert.deepEqual(document.elements.map((element) => element.blockKind), ["template-directive", "template-directive"]);
    assert.doesNotThrow(() => new MarkdownBlockTranslationResult({
      element: document.elements[0],
      text: '<!-- {{text({prompt: "概要を記述してください。", mode: "deep"})}} -->\n',
    }));
    assert.doesNotThrow(() => new MarkdownBlockTranslationResult({
      element: document.elements[1],
      text: '<!-- {{data("base.project.scripts", {labels: "スクリプト|コマンド", ignoreError: true})}} -->\n',
    }));
    assert.throws(() => new MarkdownBlockTranslationResult({
      element: document.elements[0],
      text: '<!-- {{text({prompt: "概要を記述してください。", mode: "light"})}} -->\n',
    }), (error) => error.code === "PROMPT_RESPONSE_INVALID");
    assert.throws(() => new MarkdownBlockTranslationResult({
      element: document.elements[1],
      text: '<!-- {{data("other.project.scripts", {labels: "スクリプト|コマンド", ignoreError: true})}} -->\n',
    }), (error) => error.code === "PROMPT_RESPONSE_INVALID");
  });

  it("translates mermaid labels while preserving fence and diagram syntax", () => {
    const source = "```mermaid\nflowchart TD\n  A[Start] -->|success| B[Finished]\n```\n";
    const document = new MarkdownPromptDocument({ id: "mermaid", content: source });
    const translated = "```mermaid\nflowchart TD\n  A[開始] -->|成功| B[完了]\n```\n";
    assert.equal(document.elements[0].blockKind, "mermaid-fence");
    assert.equal(document.elements[0].protectedBlock, false);
    assert.doesNotThrow(() => new MarkdownBlockTranslationResult({ element: document.elements[0], text: translated }));
    assert.throws(() => new MarkdownBlockTranslationResult({
      element: document.elements[0],
      text: translated.replace("-->", "---"),
    }), (error) => error.code === "PROMPT_RESPONSE_INVALID");
  });

  it("keeps inline directives byte-identical in otherwise translatable blocks", () => {
    const source = '# <!-- {{data("base.project.name")}} -->Project<!-- {{/data}} -->\n';
    const element = new MarkdownPromptDocument({ id: "inline", content: source }).elements[0];
    assert.doesNotThrow(() => new MarkdownBlockTranslationResult({
      element,
      text: '# <!-- {{data("base.project.name")}} -->プロジェクト<!-- {{/data}} -->\n',
    }));
    assert.throws(() => new MarkdownBlockTranslationResult({
      element,
      text: '# <!-- {{data("other.project.name")}} -->プロジェクト<!-- {{/data}} -->\n',
    }), (error) => error.code === "PROMPT_RESPONSE_INVALID");
  });

  it("rejects blank output for a nonempty translatable block", () => {
    const element = new MarkdownPromptDocument({ id: "blank-output", content: "Translate this paragraph.\n" }).elements[0];
    assert.throws(
      () => new MarkdownBlockTranslationResult({ element, text: "  \n" }),
      (error) => error.code === "PROMPT_RESPONSE_INVALID",
    );
  });

  it("rejects a translated table that changes its separator or alignment syntax", () => {
    const source = "| Name | Role |\n| :--- | ---: |\n| Client | Requests |\n";
    const element = new MarkdownPromptDocument({ id: "table", content: source }).elements[0];
    assert.doesNotThrow(() => new MarkdownBlockTranslationResult({
      element,
      text: "| 名前 | 役割 |\n| :--- | ---: |\n| クライアント | リクエスト |\n",
    }));
    assert.throws(
      () => new MarkdownBlockTranslationResult({
        element,
        text: "| 名前 | 役割 |\n| ---: | :--- |\n| クライアント | リクエスト |\n",
      }),
      (error) => error.code === "PROMPT_RESPONSE_INVALID",
    );
  });
});
