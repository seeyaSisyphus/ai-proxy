// 本地 Files API 回归（node --test）。
//
// 契约来自 llm-deepseek 的 Files 客户端（packages/llm/llm-deepseek/src/files-api.ts）：
//   · 响应对象必需 id / type='file' / mime_type / size_bytes / created_at / filename，
//     且 created_at 必须能被 Date.parse 解析成非负整数秒；
//   · delete 要求响应 id 与请求 id 完全相等、type === 'file_deleted'；
//   · size_bytes 必须精确等于上传字节数（file-store.ts 会校验）。
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const filesApi = require('./files-api')

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function request(port, method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** 按 llm-deepseek 的真实形态构造 multipart 上传体。 */
function uploadBody(boundary, bytes, filename = 'image.png', mimeType = 'image/png') {
  const CRLF = '\r\n'
  const head = Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="expires_after[anchor]"${CRLF}${CRLF}created_at${CRLF}`
    + `--${boundary}${CRLF}Content-Disposition: form-data; name="expires_after[seconds]"${CRLF}${CRLF}604800${CRLF}`
    + `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}`
    + `Content-Type: ${mimeType}${CRLF}${CRLF}`,
  )
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`)
  return Buffer.concat([head, bytes, tail])
}

async function withServer(run) {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => filesApi.handle(req, res, Buffer.concat(chunks)))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(server.address().port)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('上传：响应满足 llm-deepseek 的全部必需字段，size_bytes 精确等于字节数', async () => {
  await withServer(async port => {
    const boundary = '----probe' + Date.now()
    const body = uploadBody(boundary, PNG)
    const res = await request(port, 'POST', '/v1/files', body, {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-api-key': 'probe',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'files-api-2025-04-14',
    })
    assert.equal(res.status, 200)
    const file = JSON.parse(res.text)
    assert.equal(typeof file.id, 'string')
    assert.ok(file.id.length > 0)
    assert.equal(file.type, 'file')
    assert.equal(file.mime_type, 'image/png')
    assert.equal(file.size_bytes, PNG.length, 'size_bytes 必须精确等于上传字节数')
    assert.equal(file.filename, 'image.png')
    // created_at 必须能解析成非负整数秒（files-api.ts parseFileObject 的约束）
    const seconds = Math.floor(Date.parse(file.created_at) / 1000)
    assert.ok(Number.isSafeInteger(seconds) && seconds >= 0, 'created_at 必须可解析')
  })
})

test('取回 / 删除：delete 返回同 id 与 file_deleted，删除后取回 404', async () => {
  await withServer(async port => {
    const boundary = '----probe' + Date.now()
    const uploaded = JSON.parse((await request(port, 'POST', '/v1/files', uploadBody(boundary, PNG), {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    })).text)
    const got = await request(port, 'GET', `/v1/files/${uploaded.id}`)
    assert.equal(got.status, 200)
    assert.equal(JSON.parse(got.text).id, uploaded.id)

    const deleted = await request(port, 'DELETE', `/v1/files/${uploaded.id}`)
    assert.equal(deleted.status, 200)
    const wire = JSON.parse(deleted.text)
    assert.equal(wire.id, uploaded.id, 'delete 响应 id 必须与请求 id 完全相等')
    assert.equal(wire.type, 'file_deleted')

    assert.equal((await request(port, 'GET', `/v1/files/${uploaded.id}`)).status, 404)
  })
})

test('列表：分页无重复无遗漏地覆盖全部文件，且按创建时间倒序', async () => {
  await withServer(async port => {
    const boundary = '----probe' + Date.now()
    const tag = 'page-' + Date.now()
    const uploaded = []
    for (let i = 0; i < 3; i++) {
      const res = await request(port, 'POST', '/v1/files', uploadBody(boundary, PNG, `${tag}-${i}.png`), {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      })
      uploaded.push(JSON.parse(res.text).id)
    }
    // 逐页推进（reclaimOldestOwned 依赖这条路径遍历全部分页）
    const seen = []
    let after
    let pages = 0
    for (;;) {
      const query = after === undefined ? '?limit=2' : `?limit=2&after_id=${after}`
      const page = JSON.parse((await request(port, 'GET', '/v1/files' + query)).text)
      assert.ok(Array.isArray(page.data))
      assert.equal(typeof page.has_more, 'boolean')
      for (const file of page.data) seen.push(file)
      pages += 1
      assert.ok(pages < 50, '分页必须终止')
      if (!page.has_more) break
      assert.equal(typeof page.last_id, 'string', 'has_more 时必须给出 last_id')
      assert.notEqual(page.last_id, after, 'last_id 必须推进，否则分页死循环')
      after = page.last_id
    }
    const ids = seen.map(file => file.id)
    assert.equal(new Set(ids).size, ids.length, '分页不得重复返回同一文件')
    for (const id of uploaded) assert.ok(ids.includes(id), '分页必须覆盖本次上传的 ' + id)
    // 倒序：创建时间单调不增
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i - 1].created_at >= seen[i].created_at, '列表必须按创建时间倒序')
    }
  })
})

test('file 引用还原：source.type=file 变成内联 base64', () => {
  const boundary = '----probe' + Date.now()
  // 直接驱动模块：先上传拿 id，再构造 messages 引用
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => filesApi.handle(req, res, Buffer.concat(chunks)))
  })
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      try {
        const port = server.address().port
        const uploaded = JSON.parse((await request(port, 'POST', '/v1/files', uploadBody(boundary, PNG), {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        })).text)
        const body = Buffer.from(JSON.stringify({
          model: 'wb/deepseek-flash',
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'file', file_id: uploaded.id } },
            { type: 'text', text: 'hi' },
          ] }],
        }))
        const resolved = filesApi.resolveFileReferences(body)
        assert.equal(resolved.missing.length, 0)
        assert.equal(resolved.changed, true)
        const parsed = JSON.parse(resolved.buffer.toString())
        const source = parsed.messages[0].content[0].source
        assert.equal(source.type, 'base64')
        assert.equal(source.media_type, 'image/png')
        assert.equal(source.data, PNG.toString('base64'))
        resolve()
      } catch (error) {
        reject(error)
      } finally {
        server.close()
      }
    })
  })
})

test('外来 file_id（官方形态）：原样透传，不误报失效', () => {
  // 官方 DeepSeek 的 id 形如 file-api-<uuid>；直连路由下客户端可能自带这种 id，
  // 上游认识它，本代理必须原样放行而不是当作自己的失效引用。
  const foreign = 'file-api-d3b3b0b1-d3ea-4a6f-9f26-14c9a5cdf103'
  const body = Buffer.from(JSON.stringify({
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: foreign } }] }],
  }))
  const resolved = filesApi.resolveFileReferences(body)
  assert.deepEqual(resolved.missing, [], '外来 id 不得触发失效路径')
  assert.equal(resolved.changed, false)
  assert.equal(resolved.buffer, body, 'body 必须逐字节不变')
})

test('本代理签发但已失效的 id：报 missing（触发重传）', () => {
  const mine = 'file_' + 'a'.repeat(24)
  const body = Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: mine } }] }],
  }))
  const resolved = filesApi.resolveFileReferences(body)
  assert.deepEqual(resolved.missing, [mine])
  assert.equal(resolved.changed, false)
})

test('isOwnFileId：只认本代理形态，拒绝官方与畸形输入', () => {
  assert.equal(filesApi.isOwnFileId('file_' + '0'.repeat(24)), true)
  assert.equal(filesApi.isOwnFileId('file_' + 'f'.repeat(24)), true)
  assert.equal(filesApi.isOwnFileId('file-api-d3b3b0b1-d3ea-4a6f-9f26-14c9a5cdf103'), false)
  assert.equal(filesApi.isOwnFileId('file_' + 'a'.repeat(23)), false, '长度不足不得匹配')
  assert.equal(filesApi.isOwnFileId('file_' + 'z'.repeat(24)), false, '非十六进制不得匹配')
  assert.equal(filesApi.isOwnFileId('file_' + 'A'.repeat(24)), false, '大写不得匹配（生成器只产小写）')
  assert.equal(filesApi.isOwnFileId(''), false)
  assert.equal(filesApi.isOwnFileId(undefined), false)
  assert.equal(filesApi.isOwnFileId(42), false)
})
test('本代理签发但未知的 file_id：报 missing 且不改写 body（触发上层重传路径）', () => {
  const unknown = 'file_' + 'deadbeef'.repeat(3)
  const body = Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: unknown } }] }],
  }))
  const resolved = filesApi.resolveFileReferences(body)
  assert.deepEqual(resolved.missing, [unknown])
  assert.equal(resolved.changed, false)
  assert.equal(resolved.buffer, body)
})

test('无 file 引用时不改动 body', () => {
  const body = Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  const resolved = filesApi.resolveFileReferences(body)
  assert.equal(resolved.changed, false)
  assert.equal(resolved.buffer, body)
})

test('multipart 解析：真实 undici FormData 的 wire 形态可被完整解析', async () => {
  // 回归真实客户端：DSH 用 undici 的 FormData 上传，Content-Type 形如
  // `multipart/form-data; boundary=----formdata-undici-<digits>`，boundary 无引号、无分号。
  const form = new FormData()
  form.set('expires_after[anchor]', 'created_at')
  form.set('expires_after[seconds]', '604800')
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  form.set('file', new Blob([payload], { type: 'image/png' }), 'dsh-0123456789abcdef-deadbeef.png')
  const request = new Request('http://localhost/v1/files', { method: 'POST', body: form })
  const wire = Buffer.from(await request.arrayBuffer())
  const contentType = request.headers.get('content-type')
  const boundary = /boundary=(.+)$/i.exec(contentType)[1]
  const parts = filesApi.parseMultipart(wire, boundary)
  assert.deepEqual(parts.map(part => part.name), ['expires_after[anchor]', 'expires_after[seconds]', 'file'])
  const file = parts.find(part => part.name === 'file')
  assert.equal(file.filename, 'dsh-0123456789abcdef-deadbeef.png', 'filename 必须原样保留（配额回收依赖 dsh- 前缀）')
  assert.equal(file.contentType, 'image/png')
  assert.deepEqual(file.body, payload, '正文必须逐字节相等')
})

test('header 取值限定在具名 header 行内：无关 header 不能伪造 part 身份', () => {
  const boundary = '----forge'
  const CRLF = '\r\n'
  const body = Buffer.concat([
    Buffer.from(`--${boundary}${CRLF}`
      + `Content-Disposition: form-data; name="file"; filename="real.png"${CRLF}`
      + `Content-Type: image/png${CRLF}`
      + `X-Note: name="evil"${CRLF}${CRLF}`),
    Buffer.from([1, 2, 3]),
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
  ])
  const file = filesApi.parseMultipart(body, boundary).find(part => part.name === 'file')
  assert.ok(file !== undefined, '真实字段名必须被识别')
  assert.notEqual(file.name, 'evil', '无关 header 不得覆盖字段名')
  assert.equal(file.filename, 'real.png')
})
test('multipart 解析：正文包含 --boundary 字节序列时不得截断（RFC 2046 行首判定）', () => {
  // 二进制图片（PNG/JPEG）可能恰好包含 `--<boundary>` 字节。分隔符只有出现在
  // 行首（正文起点或 CRLF 之后）且后随 CRLF 或 `--` 时才是真正的分隔符。
  const boundary = '----regression-boundary'
  const CRLF = '\r\n'
  const payload = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from('--' + boundary),          // 正文中间，不在行首
    Buffer.from([0x00, 0x01, 0x02]),
  ])
  const head = Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="x.png"${CRLF}`
    + `Content-Type: image/png${CRLF}${CRLF}`,
  )
  const body = Buffer.concat([head, payload, Buffer.from(`${CRLF}--${boundary}--${CRLF}`)])
  const file = filesApi.parseMultipart(body, boundary).find(part => part.name === 'file')
  assert.ok(file !== undefined, '必须解析出 file part')
  assert.equal(file.body.length, payload.length, '正文长度必须完整，不得被 --boundary 截断')
  assert.deepEqual(file.body, payload, '正文必须逐字节相等')
})

test('multipart 解析：多 part 且正文含 boundary 前缀时不吞掉后续 part', () => {
  const boundary = '----regression-multi'
  const CRLF = '\r\n'
  const payload = Buffer.concat([Buffer.from('head'), Buffer.from('--' + boundary), Buffer.from('tail')])
  const build = (name, data, filename) => Buffer.concat([
    Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"`
      + (filename === undefined ? '' : `; filename="${filename}"`) + `${CRLF}`
      + (filename === undefined ? '' : `Content-Type: image/png${CRLF}`) + `${CRLF}`),
    data,
    Buffer.from(CRLF),
  ])
  const body = Buffer.concat([
    build('file', payload, 'a.png'),
    build('expires_after[seconds]', Buffer.from('604800')),
    Buffer.from(`--${boundary}--${CRLF}`),
  ])
  const parts = filesApi.parseMultipart(body, boundary)
  assert.deepEqual(parts.map(part => part.name), ['file', 'expires_after[seconds]'])
  assert.equal(parts[0].body.length, payload.length, 'file 正文完整')
  assert.equal(parts[1].body.toString(), '604800', '后续 part 不得被吞掉')
})
test('multipart 解析：字段名、文件名、内容类型与正文切分正确', () => {
  const boundary = '----probeX'
  const body = uploadBody(boundary, PNG)
  const parts = filesApi.parseMultipart(body, boundary)
  const names = parts.map(p => p.name)
  assert.ok(names.includes('file'))
  assert.ok(names.includes('expires_after[anchor]'))
  assert.ok(names.includes('expires_after[seconds]'))
  const file = parts.find(p => p.name === 'file')
  assert.equal(file.filename, 'image.png')
  assert.equal(file.contentType, 'image/png')
  assert.deepEqual(file.body, PNG, '正文必须逐字节相等')
  assert.equal(parts.find(p => p.name === 'expires_after[seconds]').body.toString(), '604800')
})