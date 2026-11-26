package ui

import (
	"regexp"
	"strings"
	"testing"
)

// SPA 入口引用的每个本地资产都必须在 embed 里取得到——漏一个就是线上白屏。
func TestIndexReferencesExistingAssets(t *testing.T) {
	idx := string(Index())
	if !strings.Contains(idx, `id="root"`) {
		t.Fatal("index.html 缺 SPA 挂载点")
	}
	refs := regexp.MustCompile(`(?:src|href)="(/[^"]+)"`).FindAllStringSubmatch(idx, -1)
	if len(refs) < 3 {
		t.Fatalf("入口引用的资产太少: %d", len(refs))
	}
	for _, m := range refs {
		name := strings.TrimPrefix(m[1], "/")
		if strings.HasPrefix(name, "http") {
			continue
		}
		if _, _, ok := Asset(name); !ok {
			t.Errorf("入口引用了不存在的资产 %q", m[1])
		}
	}
}

func TestTextAssetsHaveGzip(t *testing.T) {
	idx := string(Index())
	for _, name := range []string{"theme.js"} {
		if !strings.Contains(idx, name) {
			continue
		}
		if _, ok := Gzip(name); !ok {
			t.Errorf("%s 应有预压缩版本", name)
		}
	}
}
