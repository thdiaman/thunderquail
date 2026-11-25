import { marked } from "./vendor/marked.mjs";

const elements = new Set([
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul"
]);
const htmlNamespace = "http://www.w3.org/1999/xhtml";

function appendSafeChildren(source, destination, document) {
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      destination.append(document.createTextNode(child.data));
    } else if (child.namespaceURI === htmlNamespace && elements.has(child.localName)) {
      const element = document.createElement(child.localName);
      if (child.localName === "a") {
        const href = child.getAttribute("href");
        if (/^https?:\/\//i.test(href ?? "")) {
          element.href = href;
          element.target = "_blank";
          element.rel = "noopener noreferrer";
        }
      }
      if (child.localName === "ol" && /^\d+$/.test(child.getAttribute("start") ?? "")) {
        element.setAttribute("start", child.getAttribute("start"));
      }
      appendSafeChildren(child, element, document);
      destination.append(element);
    }
  }
}

export function renderMarkdown(destination, markdown) {
  const document = destination.ownerDocument;
  const template = document.createElement("template");
  const fragment = document.createDocumentFragment();
  try {
    // The template is inert. Only freshly created allowlisted nodes enter the overlay.
    template.innerHTML = marked.parse(markdown, { gfm: true, breaks: true });
    appendSafeChildren(template.content, fragment, document);
    destination.replaceChildren(fragment);
  } catch {
    destination.textContent = markdown;
  }
}
