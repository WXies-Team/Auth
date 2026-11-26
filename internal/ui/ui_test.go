package ui

import (
	"os"
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

// 前端下拉的项目清单必须与后端 knownApps 同值：漏一个项目，邀请/筛选就会
// 发一个后端白名单外的 slug（400）。
func TestKnownAppsMatchFrontend(t *testing.T) {
	raw, err := os.ReadFile("../../web/src/lib/apps.ts")
	if err != nil {
		t.Fatalf("读前端项目清单: %v", err)
	}
	src := string(raw)
	for _, a := range knownApps {
		if !strings.Contains(src, a.key) || !strings.Contains(src, a.label) {
			t.Errorf("前端 apps.ts 缺 %s/%s", a.key, a.label)
		}
	}
}
