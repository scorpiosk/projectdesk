// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
/** Minimal, dependency-free Markdown renderer.
 *
 * Safety model: ALL input HTML is escaped first, then only our own tag
 * construction re-introduces markup. Link hrefs are validated against an
 * allowlist scheme (http, https, mailto, relative). No raw `<` survives
 * except our generated tags.
 */

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESC[c]);
}

function safeHref(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^\/(?!\/)/.test(u) || !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) return u; // relative or protocol-relative-ish
  return null;
}

function inline(s: string): string {
  let out = escapeHtml(s);
  // code spans first (protect from emphasis)
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // images ![alt](url)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => {
    const h = safeHref(url);
    return h ? `<img src="${h}" alt="${alt}" />` : "";
  });
  // links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
    const h = safeHref(url);
    return h ? `<a href="${h}" target="_blank" rel="noopener noreferrer">${text}</a>` : "";
  });
  // bold
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // italic (single *)
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // underline-styled ~~strike~~
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // restore code spans
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)]);
  return out;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  let listType: "ul" | "ol" | null = null;
  let para: string[] = [];

  const closeList = () => { if (listType) { html.push(`</${listType}>`); listType = null; } };
  const flushPara = () => { if (para.length) { html.push(`<p>${para.join(" ")}</p>`); para = []; } };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { flushPara(); closeList(); i++; continue; }

    // fenced code block
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      flushPara(); closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // skip closing fence
      html.push(`<pre><code class="lang-${escapeHtml(fence[1] || "text")}">${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); closeList(); const lv = h[1].length; html.push(`<h${lv}>${inline(h[2])}</h${lv}>`); i++; continue; }

    // hr
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { flushPara(); closeList(); html.push("<hr />"); i++; continue; }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      flushPara(); closeList();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, "")); i++;
      }
      html.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    // task list item  - [ ] / - [x]
    const task = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
    if (task) {
      flushPara();
      if (listType !== "ul") { closeList(); html.push("<ul class=\"md-task-list\">"); listType = "ul"; }
      const done = task[1].toLowerCase() === "x";
      html.push(`<li class="md-task${done ? " done" : ""}"><input type="checkbox" disabled${done ? " checked" : ""} /> <span>${inline(task[2])}</span></li>`);
      i++; continue;
    }

    // unordered list
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (listType !== "ul") { closeList(); html.push("<ul>"); listType = "ul"; }
      html.push(`<li>${inline(ul[1])}</li>`); i++; continue;
    }

    // ordered list
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (listType !== "ol") { closeList(); html.push("<ol>"); listType = "ol"; }
      html.push(`<li>${inline(ol[1])}</li>`); i++; continue;
    }

    // paragraph text
    para.push(inline(line));
    i++;
  }
  flushPara(); closeList();
  return html.join("\n");
}
