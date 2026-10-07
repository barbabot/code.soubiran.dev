import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Use the unwrapped Cloudflare plugin: Nuxt must serve document requests before
// its catch-all middleware, while non-document MCP requests reach workerd.
const origin = 'http://localhost:3000'
const server = spawn('pnpm', ['exec', 'nuxt', 'dev', '--host', 'localhost', '--port', '3000'], {
  stdio: 'inherit',
  detached: true,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
})
let sessionId

async function rpc(message) {
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(15000),
  })
  assert.equal(response.status, 200)
  sessionId = response.headers.get('mcp-session-id') ?? sessionId
  const body = await response.text()
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = body.split('\n').find(line => line.startsWith('data:'))
    assert.ok(data, 'Expected MCP event-stream data')
    return JSON.parse(data.slice(5).trim())
  }
  return JSON.parse(body)
}

try {
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    assert.equal(server.exitCode, null, 'Nuxt exited before becoming ready')
    try {
      ready = (await fetch(origin, {
        headers: { accept: 'text/html' },
        signal: AbortSignal.timeout(1000),
      })).ok
    }
    catch {}
    if (ready)
      break
    await delay(1000)
  }
  assert.ok(ready, 'Nuxt did not serve the SPA within 120 attempts')

  for (const path of ['/', '/?code=aGVsbG8%3D', '/client-only-route']) {
    const response = await fetch(`${origin}${path}`, { headers: { accept: 'text/html' } })
    assert.equal(response.status, 200, `Navigation ${path}`)
    assert.match(await response.text(), /id="__nuxt"/)
  }
  const navigation = await fetch(origin, { headers: { 'sec-fetch-mode': 'navigate' } })
  assert.equal(navigation.status, 200)
  assert.match(await navigation.text(), /id="__nuxt"/)
  const head = await fetch(origin, { method: 'HEAD', headers: { accept: 'text/html' } })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  const viteClient = await fetch(`${origin}/_nuxt/@vite/client`)
  assert.equal(viteClient.status, 200)
  assert.match(viteClient.headers.get('content-type'), /javascript/)

  const initialized = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ci-dev-smoke-test', version: '1.0.0' } },
  })
  assert.equal(initialized.result.serverInfo.name, 'code.soubiran.dev')
  const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['generate_code_image'])
  const forbidden = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'Origin': 'https://untrusted.example', 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
  })
  assert.equal(forbidden.status, 403)

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(/umami\.soubiran\.dev|fonts\.googleapis\.com|fonts\.gstatic\.com/, route => route.abort())
    const response = await page.goto(`${origin}/?code=Y29uc3QgYW5zd2VyID0gNDI%3D&language=typescript`)
    assert.equal(response.status(), 200)
    const card = page.locator('[data-code-image]')
    await card.locator('pre.shiki').waitFor({ state: 'visible' })
    assert.match(await card.locator('pre.shiki').textContent(), /const answer = 42/)
    await card.locator('textarea').fill('const updated = 123')
    await page.waitForFunction(() => new URL(location.href).searchParams.get('code') === btoa('const updated = 123'))
    assert.deepEqual(errors, [], 'Dev editor should boot without browser exceptions')
  }
  finally {
    await browser.close()
  }
  console.log('Verified unwrapped Cloudflare plugin: SPA navigation, Vite assets, browser boot, MCP discovery, and origin restrictions in development.')
}
finally {
  // Stop the whole Nuxt/pnpm/workerd process group, including child processes.
  if (server.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM')
    }
    catch (error) {
      if (error.code !== 'ESRCH')
        throw error
    }
  }
}
