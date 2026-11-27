package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/png" // 解码入库 PNG 做像素级断言
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// 生成器必须与入库的资产字节一致：任何人改了字形/配色但忘了重生，这里先红。
// （regenerate 是纯函数，PNG 编码无时间戳——同一份输入恒同一份字节。）
func TestGeneratedAssetsInSync(t *testing.T) {
	files, err := generate()
	if err != nil {
		t.Fatalf("生成资产: %v", err)
	}
	if len(files) != 20 {
		t.Fatalf("资产清单应为 20 份（5 品牌 PNG + 5 品牌 SVG + 5 站点图标 × 2 个目录），得到 %d", len(files))
	}
	for _, f := range files {
		got, err := os.ReadFile(filepath.Join("..", "..", f.rel))
		if err != nil {
			t.Errorf("缺资产 %s: %v（跑 go run ./scripts/genicons 重生）", f.rel, err)
			continue
		}
		if !bytes.Equal(got, f.data) {
			t.Errorf("%s 与生成器输出不一致（跑 go run ./scripts/genicons 重生）", f.rel)
		}
	}
}

// 品牌邮件 logo 的文件名必须与品牌注册表的 logoPath 口径一致
// （<slug>-v1.png + 矢量源 <slug>.svg）——文件名拼错会让邮件里出现裂图。
func TestBrandLogoFilenamesMatchRegistryConvention(t *testing.T) {
	want := map[string]bool{
		"CalorieDiary-v1.png": true, "ExpenseDiary-v1.png": true,
		"EPassportForMikey-v1.png": true, "Shortener-v1.png": true,
		"auth-v1.png":      true,
		"CalorieDiary.svg": true, "ExpenseDiary.svg": true,
		"EPassportForMikey.svg": true, "Shortener.svg": true,
		"auth.svg": true,
	}
	files, err := generate()
	if err != nil {
		t.Fatalf("生成资产: %v", err)
	}
	got := map[string]bool{}
	for _, f := range files {
		if dir, name := filepath.Split(f.rel); dir == "internal/ui/static/brand/" {
			got[name] = true
		}
	}
	for name := range want {
		if !got[name] {
			t.Errorf("缺品牌 logo %s", name)
		}
	}
	if len(got) != len(want) {
		t.Errorf("品牌 logo 应恰为 %v，得到 %v", want, got)
	}
}

// readAsset 读入库资产（相对仓库根）。
func readAsset(t *testing.T, rel string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", rel))
	if err != nil {
		t.Fatalf("缺资产 %s: %v（跑 go run ./scripts/genicons 重生）", rel, err)
	}
	return data
}

// px 取像素的 8bit RGBA。png.Decode 对带 alpha 的图回 *image.NRGBA，其 At().RGBA()
// 是**预乘**值——AA 边缘像素会被算成异色，所以先走非预乘的类型断言。
func px(img image.Image, x, y int) (r, g, b, a uint8) {
	switch c := img.(type) {
	case *image.NRGBA:
		v := c.NRGBAAt(x, y)
		return v.R, v.G, v.B, v.A
	case *image.RGBA:
		v := c.RGBAAt(x, y)
		return v.R, v.G, v.B, v.A
	}
	cr, cg, cb, ca := img.At(x, y).RGBA()
	if ca == 0 {
		return 0, 0, 0, 0
	}
	// 反预乘：r8 = (cr/ca) * 255（cr、ca 同为 16bit 定点，比值即 0~1）
	return uint8(uint64(cr) * 255 / uint64(ca)),
		uint8(uint64(cg) * 255 / uint64(ca)),
		uint8(uint64(cb) * 255 / uint64(ca)),
		uint8(ca >> 8)
}

// 站点图标（2026-11-27 作者拍板）：与邮件里的 Auth logo 完全一致的
// **纯色 #3482FF 实底 + 白色盾形**；favicon 保留超椭圆切角，apple-touch 与
// PWA 图标满幅实底（交给自己套蒙版的平台）。任何一处退回透明底/描边画法，这里先红。
func TestSiteIconsShareBrandBackground(t *testing.T) {
	// ---- favicon.svg：蓝底 + 白盾 ----
	svg := string(readAsset(t, "internal/ui/static/favicon.svg"))
	for _, want := range []string{
		`viewBox="0 0 108 108"`,            // 日记站口径：108 视口
		`translate(22 22) scale(2.666667)`, // 64×64 居中字形方框
		`stroke-width="2"`,
		`fill="#3482FF"`, `stroke="#FFFFFF"`, shieldPaths[0], `<title>Auth</title>`,
	} {
		if !strings.Contains(svg, want) {
			t.Errorf("favicon.svg 缺 %q", want)
		}
	}
	for _, bad := range []string{"linearGradient", "url(#"} {
		if strings.Contains(svg, bad) {
			t.Errorf("favicon.svg 不该带渐变，却含 %q", bad)
		}
	}
	// 站点 favicon 与品牌位的画法一致：同样的蓝底 + 白盾（尺寸不同，数值不同）
	brandSVG := string(readAsset(t, "internal/ui/static/brand/auth.svg"))
	for _, want := range []string{`fill="#3482FF"`, `stroke="#FFFFFF"`, shieldPaths[0]} {
		if !strings.Contains(brandSVG, want) {
			t.Errorf("brand/auth.svg 缺 %q", want)
		}
	}

	// ---- apple-touch-icon / PWA 图标：满幅不透明蓝底 + 白盾 ----
	for _, c := range []struct {
		file string
		size int
	}{
		{"apple-touch-icon.png", 180},
		{"icon-192.png", 192},
		{"icon-512.png", 512},
	} {
		img, err := png.Decode(bytes.NewReader(readAsset(t, "internal/ui/static/"+c.file)))
		if err != nil {
			t.Fatalf("解码 %s: %v", c.file, err)
		}
		if got := img.Bounds().Dx(); got != c.size {
			t.Errorf("%s 应为 %dpx，得到 %d", c.file, c.size, got)
		}
		// 四角必须是不透明实底：满幅图标给 iOS/Android 自己套蒙版，透明角会露黑边
		for _, p := range [][2]int{{0, 0}, {c.size - 1, 0}, {0, c.size - 1}, {c.size - 1, c.size - 1}} {
			r, g, b, a := px(img, p[0], p[1])
			if a != 255 || r != 0x34 || g != 0x82 || b != 0xFF {
				t.Errorf("%s 角 (%d,%d) 应为不透明 #3482FF，得到 rgba(%d,%d,%d,%d)", c.file, p[0], p[1], r, g, b, a)
			}
		}
		var white int
		for y := 0; y < c.size; y++ {
			for x := 0; x < c.size; x++ {
				r, g, b, a := px(img, x, y)
				if a == 255 && r > 240 && g > 240 && b > 240 {
					white++
				}
			}
		}
		if white == 0 {
			t.Errorf("%s 缺白色盾形前景", c.file)
		}
	}

	// ---- favicon.ico：16/32/48 三条 32bpp 条目；超椭圆切角外 alpha=0 且 AND 掩码置位 ----
	ico := readAsset(t, "internal/ui/static/favicon.ico")
	if len(ico) < 6 || binary.LittleEndian.Uint16(ico[2:4]) != 1 {
		t.Fatalf("favicon.ico 头不对: %x", ico[:min(6, len(ico))])
	}
	count := int(binary.LittleEndian.Uint16(ico[4:6]))
	if count != 3 {
		t.Fatalf("favicon.ico 应有 3 档，得到 %d", count)
	}
	sizes := map[int]bool{}
	for i := 0; i < count; i++ {
		ent := ico[6+16*i : 6+16*(i+1)]
		w, h := int(ent[0]), int(ent[1])
		if w == 0 {
			w = 256
		}
		if h == 0 {
			h = 256
		}
		sizes[w] = true
		if bpp := binary.LittleEndian.Uint16(ent[6:8]); bpp != 32 {
			t.Errorf("%dpx 条目应为 32bpp，得到 %d", w, bpp)
		}
		size := int(binary.LittleEndian.Uint32(ent[8:12]))
		off := int(binary.LittleEndian.Uint32(ent[12:16]))
		if off+size > len(ico) {
			t.Fatalf("%dpx 条目越界", w)
		}
		bmp := ico[off : off+size]
		// 位图像素：40 字节头后第一行 = 图像最底行，角落是超椭圆切角 → alpha 必须 0
		if a := bmp[40+3]; a != 0 {
			t.Errorf("%dpx 条目角落 alpha 应为 0（切角外透明），得到 %d", w, a)
		}
		// AND 掩码紧随像素区，位=1 表示透明：只看掩码的老客户端也得读出切角
		mask := 40 + w*h*4
		if mask >= len(bmp) || bmp[mask]&0x80 == 0 {
			t.Errorf("%dpx 条目的 AND 掩码未把切角置为透明", w)
		}
	}
	for _, want := range []int{16, 32, 48} {
		if !sizes[want] {
			t.Errorf("favicon.ico 缺 %dpx 档", want)
		}
	}

	// ---- 品牌 logo（含 Auth 邮件位）：纯色 #3482FF 实底（**零渐变**）+ 白矢量 + 超椭圆切角 ----
	for _, name := range []string{"CalorieDiary", "ExpenseDiary", "EPassportForMikey", "Shortener", "auth"} {
		img, err := png.Decode(bytes.NewReader(readAsset(t, "internal/ui/static/brand/"+name+"-v1.png")))
		if err != nil {
			t.Fatalf("解码 %s-v1.png: %v", name, err)
		}
		if img.Bounds().Dx() != 128 || img.Bounds().Dy() != 128 {
			t.Errorf("%s-v1.png 应为 128px（64@2x），得到 %v", name, img.Bounds())
		}
		// ① 四角是超椭圆切角（透明）
		for _, c := range [][2]int{{0, 0}, {127, 0}, {0, 127}, {127, 127}} {
			if a := pxAtAlpha(img, c[0], c[1]); a != 0 {
				t.Errorf("%s logo 角 (%d,%d) 应透明（超椭圆切角），得到 alpha=%d", name, c[0], c[1], a)
			}
		}
		// ② 采样点逐点断言：上/下/左/右四边中点都在字形外包盒之外，必须是
		//    **不透明的 #3482FF 实底**——顶底同色即证明没有任何竖直渐变
		for _, p := range [][2]int{{64, 8}, {64, 120}, {8, 64}, {120, 64}} {
			r, g, b, a := px(img, p[0], p[1])
			if a != 255 || r != 0x34 || g != 0x82 || b != 0xFF {
				t.Errorf("%s logo (%d,%d) 应为纯色 #3482FF 实底，得到 rgba(%d,%d,%d,%d)",
					name, p[0], p[1], r, g, b, a)
			}
		}
		// ③ 全图逐像素：底与字形都只能是「蓝或白」——两个端点的 B 通道都是 0xFF，
		//    任何渐变色（品红 b=149、渐变蓝底 b=232）都会在这里露馅
		var solid, whiteGlyph, bad int
		var badSample string
		for y := 0; y < img.Bounds().Dy(); y++ {
			for x := 0; x < img.Bounds().Dx(); x++ {
				r, g, b, a := px(img, x, y)
				if a == 0 {
					continue
				}
				if b != 0xFF || r < 0x34 || g < 0x82 {
					bad++
					if badSample == "" {
						badSample = fmt.Sprintf("(%d,%d) rgba(%d,%d,%d,%d)", x, y, r, g, b, a)
					}
					continue
				}
				if a == 255 && r == 0x34 && g == 0x82 {
					solid++
				}
				if a == 255 && r > 245 && g > 245 {
					whiteGlyph++
				}
			}
		}
		if bad != 0 {
			t.Errorf("%s 有 %d 个非「纯蓝/白」像素（首例 %s）——底必须是纯色 #3482FF 实底，不许渐变",
				name, bad, badSample)
		}
		if solid == 0 {
			t.Errorf("%s 缺不透明实底像素", name)
		}
		if whiteGlyph == 0 {
			t.Errorf("%s 缺白色矢量前景", name)
		}
		// ④ 矢量源：同款蓝底白字形、无渐变，alt/title 文案在
		svg := string(readAsset(t, "internal/ui/static/brand/"+name+".svg"))
		for _, want := range []string{`fill="#3482FF"`, `stroke="#FFFFFF"`, brandLabels[name]} {
			if !strings.Contains(svg, want) {
				t.Errorf("%s.svg 缺 %q", name, want)
			}
		}
		for _, bad := range []string{"linearGradient", "url(#"} {
			if strings.Contains(svg, bad) {
				t.Errorf("%s.svg 不该带渐变，却含 %q", name, bad)
			}
		}
	}
}

// glyphMask 把字形（白或蓝）的全不透明像素拍成位图，用于跨画法比对几何。
func glyphMask(img image.Image, white bool) []bool {
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	m := make([]bool, w*h)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			r, g, b, a := px(img, x, y)
			hit := white && a == 255 && r > 245 && g > 245 && b > 245
			if !white {
				hit = a == 255 && r == 0x34 && g == 0x82 && b == 0xFF
			}
			if hit {
				m[y*w+x] = true
			}
		}
	}
	return m
}

// 字形口径（全渠道统一）：auth = **shield 素盾**（2026-10-21 换装，favicon 三件套与
// 品牌邮件 logo 同出一份 path data），flame/receipt 只属于两个日记品牌。
// 比对方式：品牌 logo（品牌画法）与同一套路径现渲染的站点画法，**字形掩码必须逐像素
// 一致**——映射被改错立刻红。
func TestBrandLogoGlyphMapping(t *testing.T) {
	cases := []struct {
		file  string
		paths []string
	}{
		{"CalorieDiary", flamePaths},
		{"ExpenseDiary", receiptPaths},
		{"EPassportForMikey", stampPaths},
		{"Shortener", linkPaths},
		{"auth", shieldPaths},
	}
	for _, c := range cases {
		img, err := png.Decode(bytes.NewReader(readAsset(t, "internal/ui/static/brand/"+c.file+"-v1.png")))
		if err != nil {
			t.Fatalf("解码 %s-v1.png: %v", c.file, err)
		}
		ref, err := renderIcon(iconSpec{size: 128, cutCorners: true, boxFrac: 0.76, paths: c.paths})
		if err != nil {
			t.Fatalf("渲染参照字形: %v", err)
		}
		got, want := glyphMask(img, true), glyphMask(ref, true)
		if len(got) != len(want) {
			t.Fatalf("%s 尺寸与参照不一致", c.file)
		}
		diff := 0
		for i := range got {
			if got[i] != want[i] {
				diff++
			}
		}
		if diff != 0 {
			t.Errorf("%s-v1.png 的字形与参照路径不一致（%d 像素差）——品牌→字形映射被改错了", c.file, diff)
		}
	}
}

func pxAtAlpha(img image.Image, x, y int) uint8 {
	_, _, _, a := px(img, x, y)
	return a
}

// officialShield 是 lucide 官方 icons/shield.svg 的 path data 逐字副本
// （https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/shield.svg，
// 与 v0.462.0 同串）——钉住生成器里的 shieldPaths，字形被改一眼红。
const officialShield = "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"

// 全渠道一个图形（2026-10-21 拍板）：Auth 品牌字形只有素盾这一份——
// ① shieldPaths 必须与 lucide 官方 shield 逐字一致；
// ② favicon.svg 的字形路径 == brand/auth.svg 的前景字形 == shieldPaths（同源单出）。
// 任何一处被单独改字形（比如只换了 favicon 或只换了邮件 logo），这里立刻红。
func TestAuthGlyphSingleSourceShield(t *testing.T) {
	if len(shieldPaths) != 1 || shieldPaths[0] != officialShield {
		t.Errorf("shieldPaths 与 lucide 官方 icons/shield.svg 不符（字形被改了？）:\n%v", shieldPaths)
	}
	re := regexp.MustCompile(`d="([^"]*)"`)
	pathDs := func(rel string) []string {
		var out []string
		for _, m := range re.FindAllStringSubmatch(string(readAsset(t, rel)), -1) {
			out = append(out, m[1])
		}
		return out
	}
	// ② favicon.svg / brand/auth.svg：第 1 条是超椭圆底（M...Z 折线），其后才是字形
	for _, rel := range []string{"internal/ui/static/favicon.svg", "internal/ui/static/brand/auth.svg"} {
		ds := pathDs(rel)
		if len(ds) != len(shieldPaths)+1 {
			t.Fatalf("%s 应为 1 条超椭圆底 + %d 条字形，得到 %d 条", rel, len(shieldPaths), len(ds))
		}
		for i, d := range shieldPaths {
			if ds[i+1] != d {
				t.Errorf("%s 字形[%d] 与 shieldPaths 不一致——站点/品牌位脱离了同源:\n got %s\nwant %s", rel, i, ds[i+1], d)
			}
		}
	}
}
