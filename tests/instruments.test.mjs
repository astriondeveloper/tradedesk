/**
 * Instrument geometry.
 *
 * A chart that is wrong does not throw. It renders a bar of a plausible length pointing a
 * plausible direction, and the reader believes it. That is why these are pure functions
 * returning strings: the percentages can be parsed back out and checked, instead of being
 * approved by looking at a screenshot where a 4% error is invisible.
 *
 * The properties that matter: zero is where zero should be, a bar never leaves its track,
 * direction follows sign, and a shared scale really is shared.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bullet, gauge, funnel, exchange, niceBounds, scalePos } from '../app/js/instruments.js'

/** Pull the inline style percentages back out of the rendered HTML. */
const styleOf = (html, cls) => {
  const m = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*style="([^"]*)"`).exec(html)
    || new RegExp(`style="([^"]*)"[^>]*class="[^"]*\\b${cls}\\b`).exec(html)
  return m ? m[1] : null
}
const pct = (style, prop) => {
  if (!style) return null
  const m = new RegExp(`${prop}:\\s*([-\\d.]+)%`).exec(style)
  return m ? parseFloat(m[1]) : null
}

/* ------------------------------------------------------------------ scales */

test('niceBounds is symmetric and rounds to numbers a person would say', () => {
  for (const [input, expected] of [
    [[4.4], 5], [[0.3], 1], [[79], 100], [[198.7], 200], [[12], 20], [[1], 1],
  ]) {
    const b = niceBounds(input)
    assert.equal(b.max, expected, `peak ${input} -> ${b.max}`)
    // Symmetric, always. An axis from -2 to +40 would make a -2 look like a rout.
    assert.equal(b.min, -b.max)
  }
})

test('niceBounds covers every value it was given', () => {
  const vals = [-198.7, 79, 0.2, 4.4]
  const b = niceBounds(vals)
  for (const v of vals) assert.ok(v >= b.min && v <= b.max, `${v} outside [${b.min},${b.max}]`)
})

test('niceBounds survives empty, non-finite and all-zero input', () => {
  for (const input of [[], [NaN], [null], [0, 0], undefined]) {
    const b = niceBounds(input)
    assert.ok(Number.isFinite(b.min) && Number.isFinite(b.max))
    assert.ok(b.max > 0)
  }
})

test('scalePos clamps into the track rather than running off it', () => {
  assert.equal(scalePos(0, -10, 10), 0.5)
  assert.equal(scalePos(-10, -10, 10), 0)
  assert.equal(scalePos(10, -10, 10), 1)
  assert.equal(scalePos(999, -10, 10), 1, 'over-range clamps to the end')
  assert.equal(scalePos(-999, -10, 10), 0, 'under-range clamps to the start')
  assert.equal(scalePos(5, 10, 10), 0.5, 'a degenerate range does not divide by zero')
})

/* ------------------------------------------------------------------ bullet */

test('a positive bullet runs right from zero, a negative one runs left', () => {
  const pos = bullet({ label: 'x', value: 4, bounds: { min: -10, max: 10 } })
  const neg = bullet({ label: 'x', value: -4, bounds: { min: -10, max: 10 } })

  const p = styleOf(pos, 'bl-bar')
  const nglyph = styleOf(neg, 'bl-bar')
  assert.equal(pct(p, 'left'), 50, 'positive bar starts at zero')
  assert.equal(pct(p, 'width'), 20)
  assert.equal(pct(nglyph, 'left'), 30, 'negative bar starts at its value')
  assert.equal(pct(nglyph, 'width'), 20, 'and ends at zero')

  assert.ok(/bl-bar pos/.test(pos) && /class="up"|bl-v up/.test(pos))
  assert.ok(/bl-bar neg/.test(neg) && /bl-v down/.test(neg))
})

test('zero is drawn where zero is', () => {
  const h = bullet({ label: 'x', value: 3, bounds: { min: -10, max: 10 } })
  assert.equal(pct(styleOf(h, 'bl-zero'), 'left'), 50)
  // And on an asymmetric scale it moves with the data, not to the middle of the box.
  const off = bullet({ label: 'x', value: 3, bounds: { min: 0, max: 10 } })
  assert.equal(pct(styleOf(off, 'bl-zero'), 'left'), 0)
})

test('a bar never escapes its track, whatever it is handed', () => {
  const cases = [0, 1, -1, 4.4, -198.7, 1e6, -1e6, 0.0001]
  for (const v of cases) {
    const h = bullet({ label: 'x', value: v, ref: -v })
    const s = styleOf(h, 'bl-bar')
    const left = pct(s, 'left')
    const width = pct(s, 'width')
    assert.ok(left >= -0.01, `left ${left} for ${v}`)
    assert.ok(left + width <= 100.01, `left+width ${left + width} for ${v}`)
    const ref = pct(styleOf(h, 'bl-ref'), 'left')
    assert.ok(ref >= -0.01 && ref <= 100.01, `ref ${ref} for ${v}`)
  }
})

test('the comparator is drawn and named, or absent entirely', () => {
  const withRef = bullet({ label: 'x', value: 4, ref: 1, refLabel: 'name value says' })
  assert.ok(/bl-ref/.test(withRef), 'marker drawn')
  assert.ok(/name value says/.test(withRef), 'and named -- an unlabelled tick is a puzzle')

  const without = bullet({ label: 'x', value: 4 })
  assert.ok(!/bl-ref/.test(without), 'no marker when there is no comparator')
  assert.ok(!/bl-legend/.test(without), 'and no dangling legend')
})

test('a shared bounds really is shared', () => {
  const bounds = niceBounds([79, -198.7])
  const a = bullet({ label: 'a', value: 79, bounds })
  const b = bullet({ label: 'b', value: -198.7, bounds })
  // Same scale means the ratio of bar lengths equals the ratio of the values.
  const wa = pct(styleOf(a, 'bl-bar'), 'width')
  const wb = pct(styleOf(b, 'bl-bar'), 'width')
  assert.ok(Math.abs((wb / wa) - (198.7 / 79)) < 0.02,
    `lengths ${wa} and ${wb} do not carry the value ratio`)
})

test('a bullet renders a sign glyph, so direction never depends on colour alone', () => {
  assert.ok(/\+4\.0/.test(bullet({ label: 'x', value: 4 })))
  assert.ok(/-4\.0/.test(bullet({ label: 'x', value: -4 })))
})

test('non-finite input degrades to zero rather than NaN%', () => {
  for (const v of [NaN, undefined, null, 'nonsense']) {
    const h = bullet({ label: 'x', value: v })
    assert.ok(!/NaN/.test(h), `NaN leaked for ${String(v)}`)
    assert.equal(pct(styleOf(h, 'bl-bar'), 'width'), 0)
  }
})

/* ------------------------------------------------------------------ gauge */

test('gauge width tracks the fraction and clamps at both ends', () => {
  assert.equal(pct(styleOf(gauge({ value: 0.53 }), 'g-fill'), 'width'), 53)
  assert.equal(pct(styleOf(gauge({ value: 0 }), 'g-fill'), 'width'), 0)
  assert.equal(pct(styleOf(gauge({ value: 1 }), 'g-fill'), 'width'), 100)
  assert.equal(pct(styleOf(gauge({ value: 4 }), 'g-fill'), 'width'), 100, 'over 1 clamps')
  assert.equal(pct(styleOf(gauge({ value: -2 }), 'g-fill'), 'width'), 0, 'under 0 clamps')
})

test('gauge bands change at the documented thresholds', () => {
  assert.ok(/gauge lo/.test(gauge({ value: 0.44 })))
  assert.ok(/gauge mid/.test(gauge({ value: 0.45 })))
  assert.ok(/gauge mid/.test(gauge({ value: 0.64 })))
  assert.ok(/gauge hi/.test(gauge({ value: 0.65 })))
})

test('the threshold tick is drawn only when given', () => {
  assert.equal(pct(styleOf(gauge({ value: 0.6, tick: 0.5 }), 'g-tick'), 'left'), 50)
  assert.ok(!/g-tick/.test(gauge({ value: 0.6 })))
})

/* ------------------------------------------------------------------ funnel */

test('funnel widths follow a square-root scale on a shared top', () => {
  const h = funnel([
    { label: 'screened', n: 4000 },
    { label: 'exact', n: 40, exact: true },
    { label: 'sending', n: 4 },
  ])
  const widths = [...h.matchAll(/width:([\d.]+)%/g)].map((m) => parseFloat(m[1]))
  assert.equal(widths.length, 3)
  assert.equal(widths[0], 100, 'the largest step fills the track')
  // sqrt(40/4000) = 0.1 -> 10%. Linear would be 1%, an invisible hairline.
  assert.ok(Math.abs(widths[1] - 10) < 0.1, `got ${widths[1]}`)
  assert.ok(widths[0] > widths[1] && widths[1] > widths[2], 'and it narrows')
})

test('funnel keeps the smallest step visible', () => {
  const h = funnel([{ label: 'a', n: 1e6 }, { label: 'b', n: 1 }])
  const widths = [...h.matchAll(/width:([\d.]+)%/g)].map((m) => parseFloat(m[1]))
  assert.ok(widths[1] >= 1.5, `a one-in-a-million step still renders: ${widths[1]}`)
})

test('funnel ignores junk rows and renders nothing when empty', () => {
  assert.equal(funnel([]), '')
  assert.equal(funnel(), '')
  const h = funnel([{ label: 'ok', n: 5 }, { label: 'bad', n: NaN }, null])
  assert.equal((h.match(/fn-step/g) || []).length, 1)
})

/* ------------------------------------------------------------------ escaping */

test('every instrument escapes the text it is handed', () => {
  const evil = '<img src=x onerror=alert(1)>'
  for (const h of [
    bullet({ label: evil, value: 1, refLabel: evil, ref: 0, sub: evil, unit: evil }),
    gauge({ label: evil, value: 0.5, sub: evil }),
    funnel([{ label: evil, n: 3 }]),
    exchange([{ name: evil, pos: evil }], [{ name: evil, pos: evil }]),
  ]) {
    assert.ok(!/<img/.test(h), 'raw tag survived escaping')
    assert.ok(/&lt;img/.test(h), 'and it is present, escaped')
  }
})

test('the exchange matrix frames both halves even when one is empty', () => {
  const h = exchange([{ name: 'A', pos: 'RB' }], [])
  assert.ok(/ex-side send/.test(h) && /ex-side get/.test(h))
  assert.ok(/nothing/.test(h), 'an empty half says so rather than collapsing')
})
