/**
 * Small markdown → HTML renderer for task files (after the webclient's
 * js_markdownLite). Dependency-free; covers what task files use: headings,
 * paragraphs, bold/italic, inline + fenced code, ordered/unordered lists,
 * `- [ ]` checklists, tables, blockquotes, `---` rules, links, and item ids
 * (GL-0019) as links to the item page.
 *
 * Everything is HTML-escaped first, so a task file cannot inject markup or
 * script into the page; only http(s) links become anchors.
 */

const escapeHtml = (t) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ID_RE = /\b([A-Z][A-Z0-9]*-\d{4})\b/g;

/** Inline markup on already-escaped text. Code spans are protected first. */
function inline(text) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(`<code>${c}</code>`);
    return `\uE000${codes.length - 1}\uE000`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) =>
    /^https?:\/\//i.test(href.replace(/&amp;/g, "&"))
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : `<span class="md-ref" title="${href}">${label}</span>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>");
  // item ids → links, but not inside an existing tag or attribute
  out = out.replace(/(<[^>]*>)|([^<]+)/g, (_m, tag, txt) =>
    tag ? tag : txt.replace(ID_RE, '<a class="item id" href="#/item/$1">$1</a>'),
  );
  return out.replace(/\uE000(\d+)\uE000/g, (_m, i) => codes[Number(i)]);
}

/** One line of markdown (History entries): inline formatting only, escaped. */
export function inlineMarkdown(text) {
  return inline(escapeHtml(String(text ?? "")));
}

/**
 * The `## Notes` section of a markdown file (last one, outside code
 * fences), up to the next `## ` heading. Empty string when there is none.
 */
export function notesSection(md) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  let fence = false;
  let start = -1;
  const heads = [];
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence) return;
    if (/^##\s/.test(l)) heads.push(i);
    if (/^##\s+notes\s*$/i.test(l)) start = i;
  });
  if (start === -1) return "";
  const end = heads.find((h) => h > start) ?? lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** Convert a markdown string to HTML safe for dangerouslySetInnerHTML. */
export function markdownToHtml(md) {
  if (md === null || md === undefined) return "";
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let para = [];
  let list = null; // "ul" | "ol"
  let quote = [];

  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) html.push(`<blockquote>${markdownToHtml(quote.join("\n"))}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    closeList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    // fenced code: everything verbatim until the closing fence
    const fence = line.match(/^(```|~~~)\s*([\w+-]*)/);
    if (fence) {
      flushAll();
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      const lang = fence[2] ? ` class="lang-${escapeHtml(fence[2])}"` : "";
      html.push(`<pre><code${lang}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (line === "") {
      flushAll();
      continue;
    }

    if (line.startsWith(">")) {
      flushPara();
      closeList();
      quote.push(line.replace(/^>\s?/, ""));
      continue;
    }
    flushQuote();

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeList();
      const n = heading[1].length;
      html.push(`<h${n}>${inline(escapeHtml(heading[2]))}</h${n}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushPara();
      closeList();
      html.push("<hr>");
      continue;
    }

    // table: a header row followed by a |---|---| separator
    if (line.startsWith("|") && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1].trim())) {
      flushPara();
      closeList();
      const head = splitRow(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(splitRow(lines[i]));
      i--;
      html.push(
        '<div class="md-table"><table class="table table-sm table-bordered"><thead><tr>' +
          head.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(escapeHtml(c))}</td>`).join("")}</tr>`).join("") +
          "</tbody></table></div>",
      );
      continue;
    }

    const ul = line.match(/^[-*+]\s+(.*)$/);
    const ol = line.match(/^(?:\d+)[.)]\s+(.*)$/);
    const olStart = ol ? Number(line.match(/^(\d+)/)[1]) : 1;
    if (ul || ol) {
      flushPara();
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        // keep the file's numbering when a nested bullet list interrupted it
        html.push(kind === "ol" && olStart > 1 ? `<ol start="${olStart}">` : `<${kind}>`);
        list = kind;
      }
      // nesting is shown by indent, not by nested lists — enough to read
      const indent = Math.min(Math.floor((raw.length - raw.trimStart().length) / 2), 4);
      const style = indent ? ` style="margin-left:${indent * 1.2}rem"` : "";
      let item = (ul ?? ol)[1];
      const box = item.match(/^\[([ xX])\]\s+(.*)$/);
      if (box) {
        const done = box[1] !== " ";
        item = box[2];
        html.push(
          `<li class="md-task"${style}><input type="checkbox" disabled${done ? " checked" : ""}> ${inline(escapeHtml(item))}</li>`,
        );
      } else {
        html.push(`<li${style}>${inline(escapeHtml(item))}</li>`);
      }
      continue;
    }

    // a continuation line of a list item stays with the list
    if (list && /^\s{2,}/.test(raw)) {
      html.push(`<div class="md-cont">${inline(escapeHtml(line))}</div>`);
      continue;
    }
    closeList();
    para.push(escapeHtml(line));
  }
  flushAll();
  return html.join("\n");
}
