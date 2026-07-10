export const DOM_EXTRACTION_SCRIPT = `
(() => {
  const MAX_ELEMENTS = 500
  const elements = []
  const all = document.querySelectorAll('*')
  let id = 0
  for (const el of all) {
    if (id >= MAX_ELEMENTS) break
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue

    el.setAttribute('data-webagent-id', 'el-' + id)

    const attrs = {}
    for (const attr of el.attributes) {
      if (['data-webagent-id', 'style'].includes(attr.name)) continue
      attrs[attr.name] = attr.value.length > 100 ? attr.value.slice(0, 100) + '...' : attr.value
    }

    const vw = window.innerWidth || document.documentElement.clientWidth
    const vh = window.innerHeight || document.documentElement.clientHeight
    const inViewport = rect.width > 0 && rect.height > 0
      && rect.bottom > 0 && rect.top < vh
      && rect.right > 0 && rect.left < vw

    elements.push({
      id: 'el-' + id,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      text: (el.innerText || '').trim().slice(0, 200),
      placeholder: el.getAttribute('placeholder'),
      value: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? (el.value || '').slice(0, 100) : undefined,
      href: el.getAttribute('href'),
      src: el.getAttribute('src'),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      inViewport,
      attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
    })
    id++
  }
  return {
    url: location.href,
    title: document.title,
    elementCount: elements.length,
    elements,
  }
})()
`

export const SCROLL_INTO_VIEW_SCRIPT = `
(id) => {
  const els = document.querySelectorAll('[data-webagent-id]');
  for (const el of els) {
    if (el.getAttribute('data-webagent-id') === id) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    }
  }
  return false;
}
`

export const EXTRACT_TEXT = `
(id) => {
  const els = document.querySelectorAll('[data-webagent-id]');
  for (const el of els) {
    if (el.getAttribute('data-webagent-id') === id) {
      return el.innerText || el.textContent || '';
    }
  }
  return '';
}
`
