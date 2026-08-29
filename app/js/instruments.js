/**
 * Measured components: bullet charts, gauges, funnels.
 *
 * Pure functions from numbers to HTML. No DOM, no globals, no reading of application
 * state -- which is what lets the geometry be unit-tested instead of eyeballed in a
 * screenshot. Every bug this file could have is an arithmetic bug in a percentage, and
 * arithmetic bugs are exactly what a test catches and a designer does not.
 *
 * On the choice of a bullet chart. The obvious control for "this trade is worth +4.1 a
 * week" is a bar, and a bar is wrong here, because the number is meaningless without the
 * thing it is being compared against. Every bullet in this app carries a REFERENCE MARKER
 * showing what a naive reading of the same trade says -- point-summing, or what the other
 * manager perceives from name value. The distance between the bar and the marker is the
 * claim this whole application makes, drawn to scale instead of argued in a paragraph.
 *
 * On zero. Every diverging mark is anchored to a real zero position on a symmetric scale,
 * so "worse" is physically left of the line and "better" is physically right of it before
 * any colour is applied. Direction therefore survives a colourblind reader, a greyscale
 * print, and a one-second glance. Colour is the second channel, never the only one.
 */

const isNum = (x) => Number.isFinite(x)
const num = (x, d = 0) => (isNum(x) ? x : d)
const clamp01 = (x) => Math.max(0, Math.min(1, x))

const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const f1 = (n) => (isNum(n) ? n.toFixed(1) : '—')
const sign = (n) => (isNum(n) && n > 0 ? '+' : '')
const pctText = (x) => `${Math.round(clamp01(x) * 100)}%`

/**
 * A symmetric, human-readable bound for a diverging scale.
 *
 * Symmetric because an asymmetric one lies: if the axis ran from -2 to +40, a -2 would
 * look like a rout. Rounded up to 1/2/5 x 10^n so the axis labels are numbers a person
 * would say out loud.
 */
export function niceBounds(values, floor = 1) {
  const mags = (values || []).map((v) => Math.abs(num(v, 0))).filter(isNum)
  const peak = Math.max(floor, ...(mags.length ? mags : [floor]))
  const mag = 10 ** Math.floor(Math.log10(peak))
  const norm = peak / mag
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  const bound = step * mag
  return { min: -bound, max: bound }
}

/** Where a value sits on [min,max], as a 0..1 fraction, clamped into the track. */
export function scalePos(v, min, max) {
  if (!(max > min)) return 0.5
  return clamp01((num(v, 0) - min) / (max - min))
}

/**
 * A bullet chart: one measure, one comparator, on a zero-anchored diverging scale.
 *
 * @param {object} o
 * @param {string} o.label     what is being measured
 * @param {number} o.value     the measure
 * @param {number} [o.ref]     the comparator -- what a naive read would say
 * @param {string} [o.refLabel] what the comparator is, named in words
 * @param {string} [o.unit]    appended to the readout
 * @param {string} [o.sub]     one line under the readout
 * @param {object} [o.bounds]  {min,max}; derived symmetrically when absent
 */
export function bullet(o = {}) {
  const value = num(o.value, 0)
  const hasRef = isNum(o.ref)
  const b = o.bounds || niceBounds([value, hasRef ? o.ref : 0])

  const zero = scalePos(0, b.min, b.max)
  const val = scalePos(value, b.min, b.max)
  const left = Math.min(zero, val)
  const width = Math.abs(val - zero)

  const dir = value > 0.05 ? 'pos' : value < -0.05 ? 'neg' : ''
  const ink = value > 0.05 ? 'up' : value < -0.05 ? 'down' : 'flat'

  const refMark = hasRef
    ? `<i class="bl-ref" style="left:${(scalePos(o.ref, b.min, b.max) * 100).toFixed(2)}%"></i>`
    : ''

  // The comparator is named, not just drawn. An unlabelled tick on a chart is a puzzle.
  const legend = hasRef
    ? `<div class="bl-legend"><i></i>${esc(o.refLabel || 'comparison')}
         <span class="num">${sign(o.ref)}${f1(o.ref)}</span></div>`
    : ''

  return `<div class="bullet">
    <div class="bl-head">
      <span class="bl-k">${esc(o.label || '')}</span>
      <span class="bl-v ${ink}">${sign(value)}${f1(value)}${o.unit ? `<span class="dim" style="font-size:10px"> ${esc(o.unit)}</span>` : ''}</span>
    </div>
    ${o.sub ? `<div class="bl-sub">${esc(o.sub)}</div>` : ''}
    <div class="bl-track">
      <i class="bl-zero" style="left:${(zero * 100).toFixed(2)}%"></i>
      <i class="bl-bar ${dir}" style="left:${(left * 100).toFixed(2)}%;width:${(width * 100).toFixed(2)}%"></i>
      ${refMark}
    </div>
    <div class="bl-scale"><span>${f1(b.min)}</span><span>0</span><span>+${f1(b.max)}</span></div>
    ${legend}
  </div>`
}

/**
 * A gauge: one fraction on a fixed 0-100 track.
 *
 * A dial would be worse. A percentage has a natural linear track and no natural angle,
 * and a dial spends four times the pixels to say the same thing less precisely.
 *
 * @param {object} o
 * @param {number} o.value  0..1
 * @param {number} [o.tick] 0..1 -- a threshold worth marking, e.g. where "worth sending" starts
 */
export function gauge(o = {}) {
  const v = clamp01(num(o.value, 0))
  const band = v >= 0.65 ? 'hi' : v >= 0.45 ? 'mid' : 'lo'
  const tick = isNum(o.tick)
    ? `<i class="g-tick" style="left:${(clamp01(o.tick) * 100).toFixed(2)}%"></i>`
    : ''
  return `<div class="gauge ${band}">
    <div class="g-head">
      <span class="g-k">${esc(o.label || '')}</span>
      <span class="g-v">${pctText(v)}</span>
    </div>
    <div class="g-track">
      <i class="g-fill" style="width:${(v * 100).toFixed(2)}%"></i>
      ${tick}
    </div>
    ${o.sub ? `<div class="g-sub">${esc(o.sub)}</div>` : ''}
  </div>`
}

/**
 * A funnel: how a large candidate set became a small one.
 *
 * Bars are proportional to the counts on a shared scale, so the collapse from tens of
 * thousands of screened packages to a few dozen exactly-evaluated ones is a shape rather
 * than a sentence. Widths use a square-root scale, because on a linear one the final step
 * is a single pixel and on a log one the first step stops meaning anything.
 *
 * @param {Array} steps [{label, n, exact?}]
 */
export function funnel(steps = []) {
  const rows = (steps || []).filter((s) => s && isNum(s.n))
  if (!rows.length) return ''
  const top = Math.max(...rows.map((s) => s.n), 1)

  return `<div class="funnel">${rows.map((s) => {
    const w = Math.max(1.5, Math.sqrt(s.n / top) * 100)
    // The label sits in its own column rather than on the bar. Overlaid, it lands on the
    // fill for a wide step and on the empty track for a narrow one, so no single text
    // colour is legible in both -- white on the amber fill measured about 1.9:1.
    return `<div class="fn-step">
      <div class="fn-lab">${esc(s.label)}</div>
      <div class="fn-bar${s.exact ? ' exact' : ''}"><i style="width:${w.toFixed(2)}%"></i></div>
      <div class="fn-n">${s.n.toLocaleString()}</div>
    </div>`
  }).join('')}</div>`
}

/**
 * The exchange matrix: what leaves, what arrives, framed as one instrument.
 *
 * @param {Array} give  [{name,pos}]
 * @param {Array} get   [{name,pos}]
 */
export function exchange(give = [], get = []) {
  const side = (list, kind, label) => `<div class="ex-side ${kind}">
    <div class="ex-k">${esc(label)}</div>
    ${(list || []).map((p) => `<div class="ex-p">
      <span class="pos" data-p="${esc(p.pos)}">${esc(p.pos)}</span>
      <span class="nm">${esc(p.name)}</span>
    </div>`).join('') || '<div class="dim" style="font-size:12px">nothing</div>'}
  </div>`

  return `<div class="exchange">
    ${side(give, 'send', 'You send')}
    <div class="ex-mid">⇄</div>
    ${side(get, 'get', 'You get')}
  </div>`
}
