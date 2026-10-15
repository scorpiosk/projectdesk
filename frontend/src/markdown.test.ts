// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown safety", () => {
  it("escapes raw HTML so it cannot inject script tags", () => {
    const out = renderMarkdown('<script>alert("x")</script>');
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("escapes attributes and text", () => {
    const out = renderMarkdown("a < b & c > d");
    expect(out).toContain("a &lt; b &amp; c &gt; d");
    expect(out).not.toContain("< b");
  });

  it("allows http(s) links and blocks javascript: hrefs", () => {
    const out = renderMarkdown("[ok](https://example.com) [bad](javascript:alert(1)) [rel](/tasks)");
    expect(out).toContain('href="https://example.com"');
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="/tasks"');
  });

  it("renders headings, bold, italic, code and lists", () => {
    const out = renderMarkdown("# T\n\n**b** *i* `c`\n\n- one\n- two\n\n1. first");
    expect(out).toContain("<h1>T</h1>");
    expect(out).toContain("<strong>b</strong>");
    expect(out).toContain("<em>i</em>");
    expect(out).toContain("<code>c</code>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<ol>");
  });

  it("renders fenced code blocks with escaping", () => {
    const out = renderMarkdown("```bash\nx < 1 && y > 2\n```");
    expect(out).toContain("<pre><code");
    expect(out).toContain("x &lt; 1 &amp;&amp; y &gt; 2");
  });

  it("renders task list checkboxes (read-only)", () => {
    const out = renderMarkdown("- [x] done\n- [ ] open");
    expect(out).toContain('checked');
    expect(out).toContain('disabled');
  });

  it("handles empty input without crashing", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
