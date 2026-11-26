// Package ui 承载 Web 控制台的构建产物：Vite + React 的 dist 目录用 go:embed
// 打进单二进制，Go 只负责按路径回字节与安全/缓存头。页面路由、鉴权与 JSON
// 端点都在 cmd/server，本包不渲染 HTML（index.html 是构建产物）。
package ui

import (
	"bytes"
	"compress/gzip"
	"embed"
	"fmt"
	"io/fs"
	"mime"
	"path"
	"strings"
)

//go:embed all:dist
var distFS embed.FS

//go:embed static/brand/*
var brandFS embed.FS

var (
	files     = map[string][]byte{}
	gzipped   = map[string][]byte{}
	fileTypes = map[string]string{}
	indexHTML []byte
	brand     = map[string][]byte{}
)

func init() {
	if err := fs.WalkDir(distFS, "dist", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		data, err := distFS.ReadFile(p)
		if err != nil {
			return err
		}
		name := strings.TrimPrefix(p, "dist/")
		files[name] = data
		ft := contentType(name)
		fileTypes[name] = ft
		if strings.HasPrefix(ft, "text/") || strings.Contains(ft, "json") || strings.Contains(ft, "svg") {
			var buf bytes.Buffer
			zw := gzip.NewWriter(&buf)
			if _, err := zw.Write(data); err == nil && zw.Close() == nil {
				gzipped[name] = buf.Bytes()
			}
		}
		return nil
	}); err != nil {
		panic(fmt.Errorf("ui: 读取前端产物: %w", err))
	}
	indexHTML = files["index.html"]
	if len(indexHTML) == 0 {
		panic("ui: dist/index.html 缺失——先跑 (cd web && npm run build)")
	}

	entries, err := fs.ReadDir(brandFS, "static/brand")
	if err != nil {
		panic(fmt.Errorf("ui: 读取品牌资产: %w", err))
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, err := brandFS.ReadFile("static/brand/" + e.Name())
		if err != nil {
			panic(fmt.Errorf("ui: 读取品牌资产 %s: %w", e.Name(), err))
		}
		brand[e.Name()] = data
	}
	if len(brand) == 0 {
		panic("ui: static/brand/ 下没有品牌 logo——先跑 go run ./scripts/genicons")
	}
}

func contentType(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".svg":
		return "image/svg+xml; charset=utf-8"
	case ".ico":
		return "image/x-icon"
	case ".png":
		return "image/png"
	case ".woff2":
		return "font/woff2"
	case ".json":
		return "application/json; charset=utf-8"
	case ".webmanifest":
		return "application/manifest+json; charset=utf-8"
	case ".map":
		return "application/json; charset=utf-8"
	}
	if t := mime.TypeByExtension(path.Ext(name)); t != "" {
		return t
	}
	return "application/octet-stream"
}

// Index 返回 SPA 入口 HTML。
func Index() []byte { return indexHTML }

// Asset 按 dist 内相对路径取静态文件（assets/xxx.js、theme.js、favicon.svg…）。
func Asset(name string) ([]byte, string, bool) {
	clean := path.Clean("/" + name)
	clean = strings.TrimPrefix(clean, "/")
	if clean == "" || strings.Contains(clean, "..") {
		return nil, "", false
	}
	data, ok := files[clean]
	if !ok {
		return nil, "", false
	}
	return data, fileTypes[clean], true
}

// Gzip 返回预压缩字节（静态资产在 init 时压一次，运行时零 CPU）。
func Gzip(name string) ([]byte, bool) {
	data, ok := gzipped[path.Clean("/" + name)[1:]]
	return data, ok
}

// BrandStatic 返回 /brand/<name> 的品牌 logo（邮件使用，长缓存）。
func BrandStatic(name string) ([]byte, string, bool) {
	data, ok := brand[name]
	if !ok {
		return nil, "", false
	}
	switch {
	case strings.HasSuffix(name, ".png"):
		return data, "image/png", true
	case strings.HasSuffix(name, ".svg"):
		return data, "image/svg+xml; charset=utf-8", true
	}
	return data, "application/octet-stream", true
}

// Apps 是项目注册表（与 auth.allowedApps 同源）：SPA 的 slug→展示名唯一来源。
type RegistryApp struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

var knownApps = []struct{ key, label string }{
	{"CalorieDiary", "热量日记"},
	{"ExpenseDiary", "开支日记"},
	{"EPassportForMikey", "奇奇岛护照"},
	{"Shortener", "屑涵短链"},
}

func Registry() []RegistryApp {
	out := make([]RegistryApp, 0, len(knownApps))
	for _, a := range knownApps {
		out = append(out, RegistryApp{Key: a.key, Label: a.label})
	}
	return out
}

func AppLabel(key string) string {
	for _, a := range knownApps {
		if a.key == key {
			return a.label
		}
	}
	return key
}
