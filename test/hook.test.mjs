import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'

// A payload the compressor really adopts: 35 uniform JSON records, 2992 bytes,
// which buildCandidate shrinks losslessly to 611 bytes. The native-mode test
// below is the positive control that keeps the two no-op tests honest.
function payload () {
  var rows = []
  for (var i = 0; i < 35; i++) rows.push({ id: i, name: 'item-' + i, status: 'ok', latencyMs: 10 + (i % 7) })
  return JSON.stringify(rows, null, 2)
}

function harness (config) {
  var handlers = {}
  var spills = []
  var registered = []
  var ctx = {
    on: function (event, fn) { (handlers[event] = handlers[event] || []).push(fn) },
    get: function (name) {
      if (name !== 'spillStore') return undefined
      return {
        saveText: function (input) {
          spills.push(input)
          return Promise.resolve({ locator: '/spill/' + spills.length + '.txt', retrievalHint: 'read it' })
        }
      }
    },
    tools: { register: function (tool) { registered.push(tool) } },
    effect: function (fn) { fn() },
    webServer: { register: function () { return function () {} } }
  }
  apply(ctx, config || {})
  return { post: handlers['tools/post-execute'][0], spills: spills, registered: registered }
}

// The real exec carries the owning agent's session; compression is skipped
// without one (no spill owner), so the harness supplies the same shape.
function toolCall (name) {
  return { name: name, arguments: {}, callId: 'call-1', agent: { session: { header: { id: 'session-hook-test' } } } }
}

function settle (text) {
  var decision = { kind: 'accept', content: [{ type: 'text', text: text }] }
  return { decision: decision, next: async function () { return decision } }
}

// The host runs with DSH_TOOLS_MODE=ptc, and a test that inherited it would
// pass every no-op case for the wrong reason, so each test states the mode.
async function withMode (mode, fn) {
  var prev = process.env.DSH_TOOLS_MODE
  if (mode === undefined) delete process.env.DSH_TOOLS_MODE
  else process.env.DSH_TOOLS_MODE = mode
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.DSH_TOOLS_MODE
    else process.env.DSH_TOOLS_MODE = prev
  }
}

test('hook: strict PTC returns the run_code result untouched', async () => {
  var h = harness({})
  var text = payload()
  var s = settle(text)
  await withMode('ptc', async () => {
    var out = await h.post(toolCall('run_code'), { content: [{ type: 'text', text: text }] }, s.next)
    assert.equal(out, s.decision, 'the decision object must come back by identity')
    assert.equal(h.spills.length, 0, 'nothing may be spilled when the plugin is inert')
  })
})

test('hook: a configured exempt tool keeps its full result in native mode', async () => {
  var h = harness({ exemptTools: ['hindsight_recall'] })
  var text = payload()
  var s = settle(text)
  await withMode(undefined, async () => {
    var out = await h.post(toolCall('hindsight_recall'), { content: [{ type: 'text', text: text }] }, s.next)
    assert.equal(out, s.decision, 'an exempt tool must come back by identity')
    assert.equal(h.spills.length, 0)
  })
})

test('hook: native mode still compresses the same result for a non-exempt tool', async () => {
  var h = harness({ exemptTools: ['hindsight_recall'] })
  var text = payload()
  var s = settle(text)
  await withMode(undefined, async () => {
    var out = await h.post(toolCall('bash'), { content: [{ type: 'text', text: text }] }, s.next)
    assert.notEqual(out, s.decision)
    var got = out.content[0].text
    assert.ok(got.length < text.length, 'the adopted notice must be shorter than the original')
    assert.match(got, /\[save-token #[a-z0-9]+ /)
    assert.equal(h.spills.length, 1, 'reversible compression spills the original first')
  })
})
