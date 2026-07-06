export const DOM_EXTRACTION_SCRIPT = `
(() => {
  const MAX_ELEMENTS = 500;
  const elements = [];
  const interactive = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL', 'SUMMARY', 'DETAILS']);

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
  }

  function getText(el, maxLen = 200) {
    const t = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
    return t.length > maxLen ? t.slice(0, maxLen) + '...' : t;
  }

  let id = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (id >= MAX_ELEMENTS) return NodeFilter.FILTER_REJECT;
      const el = node;
      if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
      const tag = el.tagName;
      const hasText = (el.innerText || '').trim().length > 0;
      const hasAttrs = el.hasAttribute('role') || el.hasAttribute('href') || el.hasAttribute('onclick');
      const isInteractive = interactive.has(tag) || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link';
      const hasChildren = el.children.length > 0;
      if (!hasText && !hasAttrs && !isInteractive && !hasChildren) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (walker.nextNode()) {
    const el = walker.currentNode;
    id++;
    const rect = el.getBoundingClientRect();
    elements.push({
      id: 'el-' + id,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      text: getText(el, 80),
      href: el.getAttribute('href') || undefined,
      type: el.getAttribute('type') || undefined,
      name: el.getAttribute('name') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    });
    if (id >= MAX_ELEMENTS) break;
  }

  return {
    url: location.href,
    title: document.title,
    elementCount: elements.length,
    elements,
  };
})()
`

export const SCROLL_INTO_VIEW_SCRIPT = `
((elementId) => {
  // This is called via executeJavaScript with elementId as argument
  // The Electron side resolves elementId to a querySelector
  return true;
})
`

export const EXTRACT_TEXT_SCRIPT = `
(() => {
  return document.body.innerText.slice(0, 50000);
})()
`
