// 本地 Files API：Anthropic Files 兼容端点 + 请求体 file 引用还原。
//
// 为什么需要：llm-deepseek 适配器对每个带图请求都会先尝试 Files 上传，失败才回退
// 内联 base64。ai-proxy 的 wb 上游只有 Chat 协议、没有 Files 端点，于是每次带图
// 请求都先白撞一次 400。这里提供本地实现，并在转发前把 file_id 还原成内联
// base64 —— 上游（Chat 桥或官方 Messages）都不认识本地生成的 id。
//
// 存储是进程内内存：代理重启后旧 id 失效，此时 /v1/messages 返回 file_not_found，
// llm-deepseek 的 stale-id 恢复路径（request-files.ts providerRejectedFileId）会
// 识别该文本、作废本地映射并重新上传，用户请求不会失败。

const crypto = require('crypto')

/** 单个上传文件的上限，与 llm-deepseek 的 MAX_FILE_UPLOAD_BYTES 一致。 */
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024

/** Anthropic Files 路径前缀。 */
const FILES_PREFIX = '/v1/files'

/** 未声明 expires_after 时的兜底寿命，与 llm-deepseek 默认一致（7 天）。 */
const DEFAULT_EXPIRY_SECONDS = 7 * 24 * 60 * 60

/** 进程内文件表：id -> { id, data, mimeType, filename, createdAt, expiresAt }。 */
const store = new Map()

/**
 * 最近一次分配的创建时间（毫秒）。
 * 必须严格单调递增：同一毫秒内的多次上传若共享时间戳，列表的倒序就退化成
 * 未定义顺序，`after_id` 分页会漏项或重复。
 */
let lastCreatedAt = 0

/** 分配严格递增的创建时间。 */
function nextCreatedAt() {
  lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1)
  return lastCreatedAt
}

function newFileId() {
  return 'file_' + crypto.randomBytes(12).toString('hex')
}

/**
 * 本代理生成的 id 形态（file_ + 24 位十六进制）。
 * 只有这一形态的未知 id 才算「本代理的失效引用」；其它形态（如官方
 * `file-api-<uuid>`）必须原样透传，因为上游可能认识它们。
 */
const OWN_ID_PATTERN = /^file_[0-9a-f]{24}$/

/** 该 id 是否由本代理签发。 */
function isOwnFileId(id) {
  return typeof id === 'string' && OWN_ID_PATTERN.test(id)
}

/** 删除已过期条目；每次请求惰性触发，避免常驻定时器。 */
function sweep(now) {
  for (const [id, file] of store) {
    if (file.expiresAt <= now) store.delete(id)
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function errorBody(code, message) {
  return { type: 'error', error: { type: 'invalid_request_error', code, message } }
}

/** 响应里的文件对象；created_at 必须是 ISO 字符串（客户端用 Date.parse 解析）。 */
function fileObject(file) {
  return {
    id: file.id,
    type: 'file',
    mime_type: file.mimeType,
    size_bytes: file.data.length,
    created_at: new Date(file.createdAt).toISOString(),
    filename: file.filename,
  }
}

/**
 * 从 Content-Type 里取 boundary 参数。
 * 只认参数位置上的 `boundary=`（前面是 `;` 或行首），避免正文/其它参数里的同名
 * 子串被误当参数；引号形式允许内部含分号。
 * @param contentType - 请求头值。
 * @returns boundary 字符串，或 null。
 */
function boundaryOf(contentType) {
  const value = String(contentType || '')
  const quoted = /(?:^|;)\s*boundary\s*=\s*"([^"]*)"/i.exec(value)
  if (quoted) return quoted[1]
  const bare = /(?:^|;)\s*boundary\s*=\s*([^;\s]+)/i.exec(value)
  return bare ? bare[1] : null
}

/**
 * 取一个 header 行的值（大小写不敏感，支持折行）。
 * @param headers - part 的 header 区文本。
 * @param name - header 名。
 * @returns 该 header 的值，或 null。
 */
function headerLine(headers, name) {
  const pattern = new RegExp('^' + name + '\\s*:\\s*([\\s\\S]*?)(?=\\r?\\n[^\\s]|$)', 'im')
  const match = pattern.exec(headers)
  return match ? match[1].replace(/\r?\n[ \t]+/g, ' ').trim() : null
}

/**
 * 解析 multipart/form-data 请求体。
 * 只实现本代理需要的最小语义：字段名、可选文件名、可选内容类型。
 * @param buffer - 完整请求体。
 * @param boundary - Content-Type 里的 boundary 值。
 * @returns { name, filename, contentType, body } 列表。
 */
/**
 * 按 RFC 2046 查找一个「行首分隔符」。
 * 分隔符必须位于行首（正文起点或紧跟 CRLF/LF 之后），且其后必须是 CRLF、LF 或结束
 * 标记 `--`。二进制正文（PNG/JPEG 等）可能恰好包含 `--<boundary>` 字节序列，
 * 只有行首判定才能把它与真正的分隔符区分开——否则正文会被截断。
 * @param buffer - 完整请求体。
 * @param delimiter - `--<boundary>` 字节序列。
 * @param from - 起始搜索位置。
 * @returns 分隔符起始下标，或 -1。
 */
function findDelimiter(buffer, delimiter, from) {
  let at = buffer.indexOf(delimiter, from)
  while (at >= 0) {
    const atLineStart = at === 0
      || buffer[at - 1] === 0x0a
      || (at >= 2 && buffer[at - 2] === 0x0d && buffer[at - 1] === 0x0a)
    const after = at + delimiter.length
    const ends = buffer[after] === 0x2d && buffer[after + 1] === 0x2d
    const followsCrlf = buffer[after] === 0x0d && buffer[after + 1] === 0x0a
    const followsLf = buffer[after] === 0x0a
    if (atLineStart && (ends || followsCrlf || followsLf)) return at
    at = buffer.indexOf(delimiter, at + 1)
  }
  return -1
}

/**
 * 解析 multipart/form-data 请求体。
 * 只实现本代理需要的最小语义：字段名、可选文件名、可选内容类型。
 * @param buffer - 完整请求体。
 * @param boundary - Content-Type 里的 boundary 值。
 * @returns { name, filename, contentType, body } 列表。
 */
function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from('--' + boundary)
  const parts = []
  let position = findDelimiter(buffer, delimiter, 0)
  if (position < 0) return parts
  position += delimiter.length
  while (position <= buffer.length) {
    // 结束标记 `--`，或分隔符后的 CRLF
    if (buffer[position] === 0x2d && buffer[position + 1] === 0x2d) break
    if (buffer[position] === 0x0d && buffer[position + 1] === 0x0a) position += 2
    else if (buffer[position] === 0x0a) position += 1
    else break
    const next = findDelimiter(buffer, delimiter, position)
    if (next < 0) break
    let end = next
    // 去掉紧邻分隔符前的 CRLF
    if (end >= 2 && buffer[end - 2] === 0x0d && buffer[end - 1] === 0x0a) end -= 2
    else if (end >= 1 && buffer[end - 1] === 0x0a) end -= 1
    const raw = buffer.subarray(position, end)
    const headerEnd = raw.indexOf('\r\n\r\n')
    if (headerEnd >= 0) {
      const headers = raw.subarray(0, headerEnd).toString('utf8')
      // 只在 Content-Disposition / Content-Type 这两个 header 行内取值：
      // 否则无关 header（如 X-Note: name="file"）也能伪造 part 身份。
      const disposition = headerLine(headers, 'content-disposition')
      const typeLine = headerLine(headers, 'content-type')
      const name = /(?:^|;)\s*name\s*=\s*"([^"]*)"/i.exec(disposition)
      const filename = /(?:^|;)\s*filename\s*=\s*"([^"]*)"/i.exec(disposition)
      const contentType = typeLine === null ? null : (typeLine.split(';')[0] || '').trim() || null
      parts.push({
        name: name ? name[1] : '',
        filename: filename ? filename[1] : null,
        contentType,
        body: raw.subarray(headerEnd + 4),
      })
    }
    position = next + delimiter.length
  }
  return parts
}

function parseExpirySeconds(parts) {
  for (const part of parts) {
    if (part.name !== 'expires_after[seconds]') continue
    const value = Number(part.body.toString('utf8').trim())
    if (Number.isSafeInteger(value) && value > 0) return value
  }
  return DEFAULT_EXPIRY_SECONDS
}

/** 上传：POST /v1/files。 */
function handleUpload(req, res, body) {
  const contentType = String(req.headers['content-type'] || '')
  if (!/^multipart\/form-data\b/i.test(contentType.trim())) {
    json(res, 400, errorBody('invalid_request_error', 'Content-Type must be multipart/form-data'))
    return { action: 'error' }
  }
  const boundary = boundaryOf(contentType)
  if (!boundary) {
    json(res, 400, errorBody('invalid_request_error', 'multipart/form-data boundary is required'))
    return { action: 'error' }
  }
  const parts = parseMultipart(body, boundary)
  const present = parts.find(part => part.name === 'file')
  if (present === undefined) {
    json(res, 400, errorBody('invalid_request_error', 'multipart field "file" is required'))
    return { action: 'error' }
  }
  if (present.body.length === 0) {
    json(res, 400, errorBody('invalid_request_error', 'multipart field "file" is empty'))
    return { action: 'error' }
  }
  const file = present
  if (file.body.length > MAX_UPLOAD_BYTES) {
    json(res, 400, errorBody('invalid_request_error', 'file exceeds the 128 MiB upload limit'))
    return { action: 'error' }
  }
  const now = nextCreatedAt()
  sweep(now)
  const record = {
    id: newFileId(),
    data: Buffer.from(file.body),
    mimeType: file.contentType || 'application/octet-stream',
    filename: file.filename || 'upload',
    createdAt: now,
    expiresAt: now + parseExpirySeconds(parts) * 1000,
  }
  store.set(record.id, record)
  json(res, 200, fileObject(record))
  return { action: 'upload', id: record.id, bytes: record.data.length }
}

/** 列表：GET /v1/files?after_id=&limit=，按创建时间倒序。 */
function handleList(res, query) {
  const now = Date.now()
  sweep(now)
  const all = [...store.values()].sort((left, right) => right.createdAt - left.createdAt)
  const afterId = query.get('after_id')
  let start = 0
  if (afterId) {
    const index = all.findIndex(file => file.id === afterId)
    start = index >= 0 ? index + 1 : 0
  }
  const requested = Number(query.get('limit'))
  const limit = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 1000) : 100
  const page = all.slice(start, start + limit)
  const body = { data: page.map(fileObject), has_more: start + limit < all.length }
  if (page.length > 0) {
    body.first_id = page[0].id
    body.last_id = page[page.length - 1].id
  }
  json(res, 200, body)
  return { action: 'list', count: page.length }
}

/** 单个文件：GET /v1/files/{id}。 */
function handleRetrieve(res, id) {
  const now = Date.now()
  sweep(now)
  const file = store.get(id)
  if (file === undefined) {
    json(res, 404, errorBody('not_found_error', 'file not found'))
    return { action: 'error', id }
  }
  json(res, 200, fileObject(file))
  return { action: 'retrieve', id }
}

/** 删除：DELETE /v1/files/{id}。 */
function handleDelete(res, id) {
  const now = Date.now()
  sweep(now)
  if (!store.has(id)) {
    json(res, 404, errorBody('not_found_error', 'file not found'))
    return { action: 'error', id }
  }
  store.delete(id)
  json(res, 200, { id, type: 'file_deleted' })
  return { action: 'delete', id }
}

/** 该请求是否属于本地 Files API。 */
function matchesFilesRoute(req) {
  const path = String(req.url || '').split('?')[0]
  return path === FILES_PREFIX || path.startsWith(FILES_PREFIX + '/')
}

/**
 * 处理一个 Files API 请求。
 * @param req - 入站请求。
 * @param res - 出站响应。
 * @param body - 已读取的请求体（GET/DELETE 传空缓冲）。
 * @returns 已处理的操作摘要，供调用方打日志。
 */
function handle(req, res, body) {
  const [rawPath, rawQuery] = String(req.url || '').split('?')
  const id = rawPath.startsWith(FILES_PREFIX + '/')
    ? decodeURIComponent(rawPath.slice(FILES_PREFIX.length + 1))
    : null
  if (req.method === 'POST' && id === null) return handleUpload(req, res, body)
  if (req.method === 'GET' && id === null) return handleList(res, new URLSearchParams(rawQuery || ''))
  if (req.method === 'GET' && id !== null) return handleRetrieve(res, id)
  if (req.method === 'DELETE' && id !== null) return handleDelete(res, id)
  json(res, 405, errorBody('invalid_request_error', 'method not allowed for the Files API'))
  return { action: 'error' }
}

/**
 * 把 messages 里的 `source.type === 'file'` 图片块还原成内联 base64。
 * 上游（Chat 桥或官方 Messages）都不认识本地生成的 file_id。
 * @param body - 原始 JSON 请求体。
 * @returns { buffer, changed, missing }；missing 非空表示有 id 未知或已过期。
 */
function resolveFileReferences(body) {
  if (body.length === 0) return { buffer: body, changed: false, missing: [] }
  let parsed
  try {
    parsed = JSON.parse(body.toString())
  } catch (_) {
    return { buffer: body, changed: false, missing: [] }
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) {
    return { buffer: body, changed: false, missing: [] }
  }
  const now = Date.now()
  sweep(now)
  const missing = []
  let changed = false
  const walk = value => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (!value || typeof value !== 'object') return
    const source = value.source
    if (value.type === 'image' && source && typeof source === 'object' && source.type === 'file') {
      const file = typeof source.file_id === 'string' ? store.get(source.file_id) : undefined
      if (file === undefined) {
        // 外来 id（官方 file-api-<uuid> 等）上游可能认识，原样放行；
        // 只有本代理签发却已失效的 id 才需要触发客户端的重传路径。
        if (isOwnFileId(source.file_id) && !missing.includes(source.file_id)) missing.push(source.file_id)
      } else {
        value.source = { type: 'base64', media_type: file.mimeType, data: file.data.toString('base64') }
        changed = true
      }
    }
    for (const key of Object.keys(value)) walk(value[key])
  }
  walk(parsed.messages)
  if (missing.length > 0) return { buffer: body, changed: false, missing }
  return changed
    ? { buffer: Buffer.from(JSON.stringify(parsed)), changed: true, missing: [] }
    : { buffer: body, changed: false, missing: [] }
}

module.exports = {
  MAX_UPLOAD_BYTES,
  DEFAULT_EXPIRY_SECONDS,
  FILES_PREFIX,
  isOwnFileId,
  matchesFilesRoute,
  handle,
  resolveFileReferences,
  parseMultipart,
}