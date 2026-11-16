const BLOCKED = new Set(["img", "image", "foreignobject", "iframe", "object", "embed", "script", "link", "audio", "video"])
const LINKS = new Set(["src", "href", "xlink:href", "srcset", "action", "formaction", "background"])
const OUTSIDE_URL = /url\(\s*(?!['"]?\s*#)|image-set/i
const UNSAFE_CSS = /url\(\s*(?!['"]?\s*#)|image-set|@import|\\/i

function local(value: string): boolean {
  return value.trim().startsWith("#")
}

export function cleanSvg(markup: string): SVGSVGElement | undefined {
  const svg = new DOMParser().parseFromString(markup, "text/html").querySelector("svg")
  if (!(svg instanceof SVGSVGElement)) return undefined
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    const name = element.localName.toLowerCase()
    if (BLOCKED.has(name)) {
      element.remove()
      continue
    }
    if (name === "use" && [...element.attributes].some((attribute) => attribute.name.endsWith("href") && !local(attribute.value))) {
      element.remove()
      continue
    }
    if (name === "style" && UNSAFE_CSS.test(element.textContent ?? "")) {
      element.remove()
      continue
    }
    for (const attribute of [...element.attributes]) {
      const key = attribute.name.toLowerCase()
      const unsafe =
        key.startsWith("on") ||
        (LINKS.has(key) && !local(attribute.value)) ||
        (key === "style" ? UNSAFE_CSS : OUTSIDE_URL).test(attribute.value)
      if (unsafe) element.removeAttribute(attribute.name)
    }
    if (name === "a") element.replaceWith(...element.childNodes)
  }
  return document.importNode(svg, true)
}
