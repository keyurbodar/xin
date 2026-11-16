import type { MermaidConfig } from "mermaid"

const SECURE = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "htmlLabels",
  "flowchart",
  "themeCSS",
  "themeVariables",
  "fontFamily",
  "altFontFamily",
]

export function mermaidConfig(themeVariables: Record<string, string | boolean>): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    secure: SECURE,
  }
}
