import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../internal/ui/dist')
// /brand/* 由 Go 侧从 internal/ui/static 提供（embed），这里补上，才能测到同意页的应用图标。
const staticRoot = path.resolve(here, '../../internal/ui/static')
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.startsWith('/brand/')) {
      const asset = path.join(staticRoot, url.pathname)
      if (!asset.startsWith(staticRoot) || !fs.existsSync(asset)) return res.writeHead(404).end()
      res.writeHead(200, { 'Content-Type': types[path.extname(asset)] ?? 'application/octet-stream' })
      fs.createReadStream(asset).pipe(res)
      return
    }
    let file = path.join(root, url.pathname)
    if (!file.startsWith(root)) return res.writeHead(403).end()
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  .listen(4175, '127.0.0.1')
