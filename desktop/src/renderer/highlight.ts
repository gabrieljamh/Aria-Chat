import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import c from "highlight.js/lib/languages/c"
import css from "highlight.js/lib/languages/css"
import go from "highlight.js/lib/languages/go"
import xml from "highlight.js/lib/languages/xml"
import java from "highlight.js/lib/languages/java"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import markdown from "highlight.js/lib/languages/markdown"
import python from "highlight.js/lib/languages/python"
import rust from "highlight.js/lib/languages/rust"
import sql from "highlight.js/lib/languages/sql"
import typescript from "highlight.js/lib/languages/typescript"
import yaml from "highlight.js/lib/languages/yaml"
import csharp from "highlight.js/lib/languages/csharp"
import ruby from "highlight.js/lib/languages/ruby"
import swift from "highlight.js/lib/languages/swift"
import kotlin from "highlight.js/lib/languages/kotlin"
import scala from "highlight.js/lib/languages/scala"
import ini from "highlight.js/lib/languages/ini"
import dockerfile from "highlight.js/lib/languages/dockerfile"
import lua from "highlight.js/lib/languages/lua"
import r from "highlight.js/lib/languages/r"
import php from "highlight.js/lib/languages/php"

hljs.registerLanguage("bash", bash)
hljs.registerLanguage("c", c)
hljs.registerLanguage("css", css)
hljs.registerLanguage("go", go)
hljs.registerLanguage("html", xml)
hljs.registerLanguage("xml", xml)
hljs.registerLanguage("java", java)
hljs.registerLanguage("javascript", javascript)
hljs.registerLanguage("json", json)
hljs.registerLanguage("markdown", markdown)
hljs.registerLanguage("python", python)
hljs.registerLanguage("rust", rust)
hljs.registerLanguage("sql", sql)
hljs.registerLanguage("typescript", typescript)
hljs.registerLanguage("yaml", yaml)
hljs.registerLanguage("csharp", csharp)
hljs.registerLanguage("ruby", ruby)
hljs.registerLanguage("swift", swift)
hljs.registerLanguage("kotlin", kotlin)
hljs.registerLanguage("scala", scala)
hljs.registerLanguage("ini", ini)
hljs.registerLanguage("dockerfile", dockerfile)
hljs.registerLanguage("lua", lua)
hljs.registerLanguage("r", r)
hljs.registerLanguage("php", php)

export default hljs
