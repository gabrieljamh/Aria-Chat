import Convert from "ansi-to-html"

const convert = new Convert({
  fg: "#d4d4d4",
  bg: "#1e1e1e",
  colors: {
    0: "#000000",
    1: "#cd3131",
    2: "#0dbc79",
    3: "#e5e510",
    4: "#2472c8",
    5: "#bc3fbc",
    6: "#11a8cd",
    7: "#e5e5e5",
    8: "#666666",
    9: "#f14c4c",
    10: "#23d18b",
    11: "#f5f543",
    12: "#3b8eea",
    13: "#d670d6",
    14: "#29b8db",
    15: "#e5e5e5",
  },
  escapeXML: true,
  newline: true,
})

export function ansiToHtml(text: string): string {
  return convert.toHtml(text)
}