package main

// Command genicons 生成本仓全部图形资产（一次性画、可随时重生）。全渠道同一种画法：
// **纯色 miuix 品牌蓝 #3482FF 实底 + 白色矢量，squircle 外形**（2026-11-27 作者拍板：
// 站点图标也带底，与邮件里的 Auth logo 完全一致）。
//
//	internal/ui/static/brand/<slug>-v1.png  品牌 logo（128px = 64@2x，单版本；
//	                                        邮件以 https://auth.horatio.cn/brand/ 引用）
//	internal/ui/static/brand/<slug>.svg     同款矢量源（squircle 用采样折线逼近）
//	internal/ui/static/favicon.svg          108 视口 / 8% 留白 / 64 字形方框（与日记站图标同几何）
//	internal/ui/static/favicon.ico          16/32/48 三档，蓝底 squircle
//	internal/ui/static/apple-touch-icon.png 180px 满幅蓝底（iOS 自己套圆角）
//	internal/ui/static/icon-192.png         PWA 图标（满幅，maskable 安全区）
//	internal/ui/static/icon-512.png         同上 512px
//
// 站点图标同时写一份到 web/public/（Vite 构建的公开目录），两处字节一致，
// 由 TestGeneratedAssetsInSync 钉死，避免手工复制漂移。
//
// 用法（仓库根目录）：
//
//	go run ./scripts/genicons          # 写文件
//	go run ./scripts/genicons -check   # 只校验磁盘与本程序输出一致（CI/测试用）
//
// 字形取自 lucide-static v0.462.0（ISC）：热量日记 = flame、开支日记 = receipt、
// Auth = shield 素盾（2026-10-21 全渠道统一：favicon 三件套与品牌邮件 logo 同出一份
// shield path data——旧 hexagon（站点位）与 users（品牌位）一并让位）。

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// flame / receipt / shield 取自 lucide-static v0.462.0（ISC 许可，图标沿用仓库
// 「零 CDN、矢量内联」口径），path data 与 lucide 官方源逐字一致。
var (
	flamePaths = []string{
		"M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z",
	}
	receiptPaths = []string{
		"M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z",
		"M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8",
		"M12 17.5v-11",
	}
	// shieldPaths 是 Auth 的**唯一品牌字形**（素盾）：favicon.svg / favicon.ico /
	// apple-touch-icon.png 与品牌邮件 logo（brand/auth）全部共用这一份。path data 与
	// lucide 官方 icons/shield.svg 逐字一致（= internal/ui/icons.go "shield-check"
	// 的盾体 path，功能位盾形与品牌位同源）。
	shieldPaths = []string{
		"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
	}
	// stamp / link 同取自 lucide-static v0.462.0（奇奇岛护照 = 护照章、屑涵短链 =
	// 链接），path data 与官方源逐字一致。
	stampPaths = []string{
		"M5 22h14",
		"M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-.66-.26-1.3-.73-1.77Z",
		"M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-3-3c-1.66 0-3 1-3 3s1 2 1 3.5V13",
	}
	linkPaths = []string{
		"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
		"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
	}
)

// brandGlyphs 是品牌 logo 的字形（键 = 文件名 slug）。auth = shield 素盾，与站点
// favicon 三件套**同一份 path data**——全渠道一个图形（gen_test 有同源断言钉死）。
var brandGlyphs = map[string][]string{
	"CalorieDiary":      flamePaths,
	"ExpenseDiary":      receiptPaths,
	"EPassportForMikey": stampPaths,
	"Shortener":         linkPaths,
	"auth":              shieldPaths,
}

// brandLabels 是 logo 的 alt/title 文案（与 auth 品牌注册表的 name 同值）。
var brandLabels = map[string]string{
	"CalorieDiary":      "热量日记",
	"ExpenseDiary":      "开支日记",
	"EPassportForMikey": "奇奇岛护照",
	"Shortener":         "屑涵短链",
	"auth":              "Auth",
}

// fileOut 是一份待写资产：rel 相对仓库根。
type fileOut struct {
	rel  string
	data []byte
}

// generate 产出全部资产（纯函数：给 -check 与测试比对用）。
func generate() ([]fileOut, error) {
	var out []fileOut

	// 品牌邮件 logo：64px 设计尺寸 @2x = 128px，超椭圆切角 + 纯色 #3482FF 实底 +
	// 白字形（字形外包盒占 76% ≈ 四周 12% 内边距）。矢量源同款（squircle 用采样折线逼近）。
	for _, name := range []string{"CalorieDiary", "ExpenseDiary", "EPassportForMikey", "Shortener", "auth"} {
		png, err := encodePNG(iconSpec{size: 128, cutCorners: true, boxFrac: 0.76, paths: brandGlyphs[name]})
		if err != nil {
			return nil, fmt.Errorf("画 %s 品牌 logo: %w", name, err)
		}
		out = append(out, fileOut{"internal/ui/static/brand/" + name + "-v1.png", png})
		svg, err := brandSVG(64, brandLabels[name], brandGlyphs[name])
		if err != nil {
			return nil, fmt.Errorf("画 %s 品牌 logo 矢量源: %w", name, err)
		}
		out = append(out, fileOut{"internal/ui/static/brand/" + name + ".svg", []byte(svg)})
	}

	// 站点图标：与品牌邮件 logo 同一画法（蓝底 + 白盾）。favicon 保留超椭圆切角；
	// apple-touch / PWA 图标满幅不切角——iOS 与 Android 启动器自己套蒙版，
	// 满幅实底才不会在蒙版外露黑边。字形统一 70% 外包盒，落在 maskable 安全区内。
	type namedFile struct {
		name string
		data []byte
	}
	var icons []namedFile

	svg, err := siteIconSVG("Auth", shieldPaths)
	if err != nil {
		return nil, fmt.Errorf("画 favicon.svg: %w", err)
	}
	icons = append(icons, namedFile{"favicon.svg", []byte(svg)})

	// favicon 与 favicon.svg 同一套日记站几何：108 视口 / 8% 留白 / 64 字形方框。
	ico, err := encodeICO([]int{16, 32, 48}, iconSpec{
		cutCorners: true,
		inset:      0.08,
		boxFrac:    64.0 / 108.0,
		viewBox:    24,
		paths:      shieldPaths,
	})
	if err != nil {
		return nil, fmt.Errorf("画 favicon.ico: %w", err)
	}
	icons = append(icons, namedFile{"favicon.ico", ico})

	for _, size := range []int{180, 192, 512} {
		png, err := encodePNG(iconSpec{size: size, boxFrac: 0.7, paths: shieldPaths})
		if err != nil {
			return nil, fmt.Errorf("画 %dpx 站点图标: %w", size, err)
		}
		name := "apple-touch-icon.png"
		if size != 180 {
			name = fmt.Sprintf("icon-%d.png", size)
		}
		icons = append(icons, namedFile{name, png})
	}

	for _, icon := range icons {
		out = append(out, fileOut{"internal/ui/static/" + icon.name, icon.data})
		out = append(out, fileOut{"web/public/" + icon.name, icon.data})
	}

	return out, nil
}

func main() {
	dir := flag.String("dir", ".", "仓库根目录")
	check := flag.Bool("check", false, "只校验磁盘文件与生成结果一致，不写文件")
	flag.Parse()

	files, err := generate()
	if err != nil {
		fmt.Fprintf(os.Stderr, "genicons: %v\n", err)
		os.Exit(1)
	}
	var stale []string
	for _, f := range files {
		path := filepath.Join(*dir, f.rel)
		if *check {
			got, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(got, f.data) {
				stale = append(stale, f.rel)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "genicons: 建目录: %v\n", err)
			os.Exit(1)
		}
		if err := os.WriteFile(path, f.data, 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "genicons: 写 %s: %v\n", path, err)
			os.Exit(1)
		}
		fmt.Println("写入", f.rel)
	}
	if *check && len(stale) > 0 {
		fmt.Fprintf(os.Stderr, "genicons: 以下资产与生成器输出不一致（跑 go run ./scripts/genicons 重生）:\n  %s\n", strings.Join(stale, "\n  "))
		os.Exit(1)
	}
}
