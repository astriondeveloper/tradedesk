/**
 * Bundle Trade Desk into one self-contained file.
 *
 * Output: dist/tradedesk.html -- opens from file://, works with no server and no network.
 *
 * The app is written as ES modules because that is how it should be written and tested.
 * Browsers refuse to load ES modules over file://, so shipping requires flattening them
 * into one classic script. The module set is small, known, and acyclic, so resolving the
 * import graph here is a few lines rather than a reason to add a build toolchain.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(ROOT, 'app')
const OUT = join(ROOT, 'dist', 'tradedesk.html')
const ARTIFACT = join(ROOT, 'dist', 'tradedesk.artifact.html')

const read = (p) => readFileSync(p, 'utf8')

/* ---------------------------------------------------------------- module graph */

const IMPORT_RE = /^\s*import\s+(?:[\s\S]*?)\s+from\s+['"](\.[^'"]+)['"]\s*;?\s*$/gm
const BARE_IMPORT_RE = /^\s*import\s+['"](\.[^'"]+)['"]\s*;?\s*$/gm

function depsOf(src) {
  const out = []
  for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src)) !== null) out.push(m[1])
  }
  return out
}

/** Depth-first, post-order: a module is emitted only after everything it imports. */
function collect(entry) {
  const order = []
  const seen = new Set()
  const visiting = new Set()

  const walk = (file) => {
    const abs = resolve(file)
    if (seen.has(abs)) return
    if (visiting.has(abs)) throw new Error(`import cycle at ${abs}`)
    visiting.add(abs)
    const src = read(abs)
    for (const d of depsOf(src)) walk(resolve(dirname(abs), d))
    visiting.delete(abs)
    seen.add(abs)
    order.push({ path: abs, src })
  }
  walk(entry)
  return order
}

/** A stable JS identifier for a module's namespace object. */
const nsName = (abs) => `__td_${abs.slice(APP.length + 1).replace(/[^a-zA-Z0-9]/g, '_')}`

/** Every name a module exports. */
function exportsOf(src) {
  const names = new Set()
  const decl = /^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm
  let m
  while ((m = decl.exec(src)) !== null) names.add(m[1])
  const list = /^\s*export\s*\{([^}]*)\}/gm
  while ((m = list.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const t = part.trim()
      if (!t) continue
      names.add((t.split(/\s+as\s+/).pop() || t).trim())
    }
  }
  return [...names]
}

/**
 * Rewrite one module into a self-contained IIFE that returns its exports.
 *
 * Modules must NOT share a scope. Two of them legitimately declare a module-private
 * `LETTER_POS`, which is fine under ES module semantics and a redeclaration error once
 * flattened -- the bundler's own validator caught exactly that. Each module therefore
 * keeps its own scope and hands its exports out through a namespace object, which is what
 * the import statements are rewritten to read from.
 */
function wrapModule(abs, src) {
  const names = exportsOf(src)

  let body = src
    // import { a, b as c } from './x.js'  ->  const { a, b: c } = __td_x;
    .replace(IMPORT_RE, (full, spec) => {
      const target = nsName(resolve(dirname(abs), spec))
      const clause = full.slice(full.indexOf('import') + 6, full.lastIndexOf('from')).trim()
      if (clause.startsWith('{')) {
        const inner = clause.slice(1, clause.lastIndexOf('}'))
          .split(',').map((s) => s.trim()).filter(Boolean)
          .map((s) => (s.includes(' as ') ? s.replace(/\s+as\s+/, ': ') : s))
          .join(', ')
        return `const { ${inner} } = ${target};`
      }
      if (clause.startsWith('*')) {
        const alias = clause.split(/\s+as\s+/).pop().trim()
        return `const ${alias} = ${target};`
      }
      // default import: the app does not use one, but keep it correct.
      return `const ${clause} = ${target}.__default__;`
    })
    .replace(BARE_IMPORT_RE, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/^(\s*)export\s+default\s+/gm, '$1const __default__ = ')
    .replace(/^(\s*)export\s+(async\s+function|function|const|let|var|class)\b/gm, '$1$2')

  const leftovers = body.match(/^\s*(export|import)\s/gm)
  if (leftovers) {
    throw new Error(`${abs}: ${leftovers.length} module statement(s) survived stripping: `
      + leftovers.slice(0, 3).map((s) => s.trim()).join(', '))
  }

  const ret = names.length ? `return { ${names.join(', ')} };` : 'return {};'
  return `const ${nsName(abs)} = (function () {\n${body}\n${ret}\n})();`
}

/* ---------------------------------------------------------------- build */

function build() {
  const html = read(join(APP, 'index.html'))
  const css = read(join(APP, 'css', 'app.css'))
  const pack = read(join(APP, 'data', 'pack.js'))
  const leaguePath = join(APP, 'data', 'league.js')
  const league = existsSync(leaguePath) ? read(leaguePath) : ''

  const modules = collect(join(APP, 'js', 'main.js'))
  const code = modules
    .map((m) => `/* ==== ${m.path.slice(APP.length + 1)} ==== */\n${wrapModule(m.path, m.src)}`)
    .join('\n')

  const body = html
    .replace(/<link rel="stylesheet" href="css\/app\.css">/, `<style>\n${css}\n</style>`)
    .replace(/<script src="data\/pack\.js"><\/script>/, '<!-- data pack inlined below -->')
    .replace(/<script src="data\/league\.js"><\/script>/, '')
    .replace(/<script type="module" src="js\/main\.js"><\/script>/,
      `<script>\n${pack}\n${league}\n</script>\n<script>\n"use strict";\n(function(){\n${code}\n})();\n</script>`)

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, body)

  // A second output for artifact publishing, which supplies its own document shell. The
  // outer doctype/html/head/body must come off or they nest inside the host's, so this
  // keeps the title, the styles and everything in the body, and nothing else.
  const title = (body.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || 'Trade Desk'
  const style = (body.match(/<style>[\s\S]*?<\/style>/) || [''])[0]
  const inner = (body.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || ''
  const fragment = `<title>${title}</title>\n${style}\n${inner.trim()}\n`
  writeFileSync(ARTIFACT, fragment)

  return { body, fragment, modules }
}

/* ---------------------------------------------------------------- verify */

/** Extract every inline script and confirm each one actually parses. */
function validate(body) {
  const scripts = [...body.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.trim())
  let checked = 0
  for (const s of scripts) {
    // eslint-disable-next-line no-new-func
    new Function(s)   // throws on a syntax error, which is the whole point
    checked++
  }
  if (/<script[^>]*\bsrc=/.test(body)) {
    throw new Error('an external <script src> survived bundling; the file would need a server')
  }
  if (/<link[^>]*stylesheet/.test(body)) {
    throw new Error('an external stylesheet survived bundling')
  }
  return { scripts: checked }
}

const { body, fragment, modules } = build()
const v = validate(body)
const bytes = Buffer.byteLength(body)

console.log(`bundled ${modules.length} modules -> ${OUT}`)
for (const m of modules) console.log(`   ${m.path.slice(APP.length + 1)}`)
console.log(`\n${(bytes / 1048576).toFixed(2)} MB, ${v.scripts} inline scripts, all parse cleanly`)
// Word-boundaried on purpose: a naive /<head/ also matches the page's own <header>,
// which is not a document tag and is exactly what tripped this check first time.
if (/<!DOCTYPE\b|<\/?(?:html|head|body)(?:\s|>)/i.test(fragment)) {
  throw new Error('the artifact fragment still carries document tags; it would nest inside the host shell')
}
console.log(`artifact fragment -> ${ARTIFACT} (${(Buffer.byteLength(fragment) / 1048576).toFixed(2)} MB)`)
if (bytes > 15 * 1048576) console.log('WARNING: approaching the 16MB artifact limit')
