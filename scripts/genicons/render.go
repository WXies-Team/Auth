package main

// 图标光栅化与序列化：超椭圆底 + 白色描边字形，全渠道一种画法——**纯色 miuix 品牌蓝
// #3482FF 实底**（零渐变）+ 白色 lucide 矢量前景。品牌邮件 logo、站点 favicon 三件套、
// PWA 图标共用这套几何，区别只在画布尺寸与是否切圆角（由平台自己套蒙版的满幅方形）。
//
// 自带一个小光栅器的原因：图标要在仓库里可复现地重生（scripts/genicons 一键出全部
// 资产），不引入任何外部绘图库——Go 标准库画不了路径描边，而图标只有「超椭圆填充 +
// 折线圆头描边」两种几何，9 点超采样足够。

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"strings"
)

var (
	white = color.RGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 0xFF}
)

const (
	squircleN  = 5.0 // 超椭圆指数：|u|^n+|v|^n ≤ 1；n=5 是 iOS 连续圆角的常用近似
	subSamples = 3   // 每边 3 个子采样（每像素 9 点）——超椭圆与描边边缘的抗锯齿
)

// iconSpec 一枚图标的绘制参数。boxFrac 是字形外包盒占画布的比例（不含描边宽）。
type iconSpec struct {
	size       int
	cutCorners bool // false = 满幅方形（apple-touch-icon：iOS 自己套超椭圆蒙版）
	// inset 是超椭圆底相对画布的内缩比例（0 = 满幅）；0.08 与日记站图标一致，
	// 让蓝底四周留出呼吸位而不是顶到画布边缘。
	inset   float64
	boxFrac float64
	// viewBox > 0 时按 lucide 的 24 视口缩放进 boxFrac 居中方框（日记站口径：
	// 108 画布、64 方框、字形不按自身外包盒放大）；0 = 按字形外包盒归一化。
	viewBox float64
	paths   []string
}

// transformFor 把字形外包盒缩放居中到 size×size 画布，返回 (scale, tx, ty)。
// 按字形实际外包盒归一化（而不是按 24 的 viewBox）——火焰、收据、素盾三者的
// 有效图形大小不同，不归一化会一枚大一枚小。
func transformFor(spec iconSpec, segs []seg) (s, tx, ty float64) {
	size := float64(spec.size)
	if spec.viewBox > 0 {
		side := spec.boxFrac * size
		s = side / spec.viewBox
		return s, (size - side) / 2, (size - side) / 2
	}
	min, max := bboxOf(segs)
	w, h := max.x-min.x, max.y-min.y
	if w <= 0 || h <= 0 {
		w, h = 24, 24
	}
	d := math.Max(w, h)
	s = spec.boxFrac * size / d
	return s, (size-w*s)/2 - min.x*s, (size-h*s)/2 - min.y*s
}

// strokePx 是描边在像素空间的宽度：小尺寸要**光学加粗**——16px 下按 5% 只有 0.8px，
// 等于把素盾的细线糊成灰点。
func strokePxFor(size int) float64 {
	return math.Max(float64(size)*0.05, 1.35)
}

type pseg struct {
	a, b                   pt
	minx, miny, maxx, maxy float64
}

func toPixel(segs []seg, s, tx, ty float64) []pseg {
	out := make([]pseg, len(segs))
	for i, g := range segs {
		a := pt{g.a.x*s + tx, g.a.y*s + ty}
		b := pt{g.b.x*s + tx, g.b.y*s + ty}
		out[i] = pseg{
			a: a, b: b,
			minx: math.Min(a.x, b.x), maxx: math.Max(a.x, b.x),
			miny: math.Min(a.y, b.y), maxy: math.Max(a.y, b.y),
		}
	}
	return out
}

// distToSeg 点到线段距离；零长度线段退化成点距（lucide 的圆点靠这个成形）。
func distToSeg(px, py float64, s pseg) float64 {
	dx, dy := s.b.x-s.a.x, s.b.y-s.a.y
	dd := dx*dx + dy*dy
	t := 0.0
	if dd > 0 {
		t = ((px-s.a.x)*dx + (py-s.a.y)*dy) / dd
		if t < 0 {
			t = 0
		} else if t > 1 {
			t = 1
		}
	}
	cx, cy := s.a.x+t*dx, s.a.y+t*dy
	return math.Hypot(px-cx, py-cy)
}

func onStroke(ps []pseg, px, py, hw float64) bool {
	for _, s := range ps {
		if px < s.minx-hw || px > s.maxx+hw || py < s.miny-hw || py > s.maxy+hw {
			continue
		}
		if distToSeg(px, py, s) <= hw {
			return true
		}
	}
	return false
}

// superellipseInside 判定点是否在超椭圆内（u、v 是 [-1,1] 的归一化坐标）。
func superellipseInside(u, v float64) bool {
	return math.Pow(math.Abs(u), squircleN)+math.Pow(math.Abs(v), squircleN) <= 1
}

func lerpColor(a, b color.RGBA, t float64) color.RGBA {
	return color.RGBA{
		R: uint8(float64(a.R) + (float64(b.R)-float64(a.R))*t + 0.5),
		G: uint8(float64(a.G) + (float64(b.G)-float64(a.G))*t + 0.5),
		B: uint8(float64(a.B) + (float64(b.B)-float64(a.B))*t + 0.5),
		A: 255,
	}
}

// miuixBlue 是站点 favicon 的描边色（页面主色，与按钮 / theme-color 同值）。
var miuixBlue = color.RGBA{R: 0x34, G: 0x82, B: 0xFF, A: 0xFF}

// renderIcon 画一枚图标：超椭圆**纯色 #3482FF 实底** + 白描边字形，A=覆盖率
// （切角处完全透明，满幅方形时整幅不透明）。站点图标与品牌邮件 logo 同一种画法。
//
// 画布用 *image.NRGBA（**非预乘**）：我们要的是「色不变、只有 alpha 随覆盖率变」，
// 而 image.RGBA 是预乘语义——把非预乘值塞进去会被 png.Encode 当预乘反算一遍，
// 抗锯齿边缘的蓝会被吹成薰衣草色。NRGBA 直存直出，编解码零换算。
func renderIcon(spec iconSpec) (*image.NRGBA, error) {
	var all []seg
	for _, d := range spec.paths {
		got, err := flatten(d)
		if err != nil {
			return nil, err
		}
		all = append(all, got...)
	}
	if len(all) == 0 {
		return nil, fmt.Errorf("字形路径为空")
	}
	s, tx, ty := transformFor(spec, all)
	ps := toPixel(all, s, tx, ty)
	hw := strokePxFor(spec.size) / 2

	img := image.NewNRGBA(image.Rect(0, 0, spec.size, spec.size))
	half := float64(spec.size) / 2
	step := 1.0 / subSamples
	for y := 0; y < spec.size; y++ {
		for x := 0; x < spec.size; x++ {
			var inside, stroke int
			for sy := 0; sy < subSamples; sy++ {
				oy := (float64(sy) + step) / subSamples
				for sx := 0; sx < subSamples; sx++ {
					ox := (float64(sx) + step) / subSamples
					px := float64(x) + ox
					py := float64(y) + oy
					r := half - spec.inset*float64(spec.size)
					if r <= 0 {
						r = half
					}
					if spec.cutCorners && !superellipseInside((px-half)/r, (py-half)/r) {
						continue
					}
					inside++
					if onStroke(ps, px, py, hw) {
						stroke++
					}
				}
			}
			if inside == 0 {
				continue
			}
			samples := subSamples * subSamples
			// 纯色 #3482FF 实底（不做任何渐变），字形描边向白色混（AA）
			base := miuixBlue
			c := base
			if stroke > 0 {
				c = lerpColor(base, white, float64(stroke)/float64(inside))
			}
			c.A = uint8(float64(inside)/float64(samples)*255 + 0.5)
			img.SetNRGBA(x, y, color.NRGBA{R: c.R, G: c.G, B: c.B, A: c.A})
		}
	}
	return img, nil
}

// encodePNG 渲染并编码。
func encodePNG(spec iconSpec) ([]byte, error) {
	img, err := renderIcon(spec)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// siteIconSVG 生成站点 favicon.svg：几何与 diary.horatio.cn 的 App 图标完全同口径
// （2026-11-27 作者拍板）——108×108 视口、超椭圆底内缩 8%（8.64）、字形放在居中的
// 64×64 lucide 方框（translate(22 22) scale(64/24)）、描边宽 2（24 视口内）。
// 颜色仍是 Auth 的纯色品牌蓝 #3482FF + 白盾，不带渐变。
func siteIconSVG(label string, paths []string) (string, error) {
	const size = 108.0
	const inset = 0.08
	const box = 64.0
	half := size / 2
	r := half - inset*size

	var sq strings.Builder
	const pts = 128
	for i := 0; i < pts; i++ {
		theta := 2 * math.Pi * float64(i) / pts
		u := math.Copysign(math.Pow(math.Abs(math.Cos(theta)), 2/squircleN), math.Cos(theta))
		v := math.Copysign(math.Pow(math.Abs(math.Sin(theta)), 2/squircleN), math.Sin(theta))
		if i > 0 {
			sq.WriteString("L")
		}
		fmt.Fprintf(&sq, "%.3f %.3f ", half+u*r, half+v*r)
	}
	sq.WriteString("Z")

	scale := box / 24.0
	off := (size - box) / 2
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %g %g" width="%g" height="%g" role="img" aria-label="%s">
<title>%s</title>
<path d="M%s" fill="#3482FF"/>
<g transform="translate(%g %g) scale(%.6f)" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
`, size, size, size, size, label, label, strings.TrimSpace(sq.String()), off, off, scale)
	for _, d := range paths {
		fmt.Fprintf(&b, "<path d=\"%s\"/>\n", d)
	}
	b.WriteString("</g>\n</svg>\n")
	return b.String(), nil
}

// brandSVG 生成品牌邮件 logo 的矢量源：**纯色 #3482FF 超椭圆实底 + 白描边字形**，
// 与 encodePNG 的品牌画法同款（squircle 用 128 点采样折线逼近——SVG 里没有
// 超椭圆原语，折线在 64px 设计尺寸下看不出棱角）。
func brandSVG(size float64, label string, paths []string) (string, error) {
	var all []seg
	for _, d := range paths {
		got, err := flatten(d)
		if err != nil {
			return "", err
		}
		all = append(all, got...)
	}
	if len(all) == 0 {
		return "", fmt.Errorf("字形路径为空")
	}
	half := size / 2
	var sq strings.Builder
	const pts = 128
	for i := 0; i < pts; i++ {
		theta := 2 * math.Pi * float64(i) / pts
		u := math.Copysign(math.Pow(math.Abs(math.Cos(theta)), 2/squircleN), math.Cos(theta))
		v := math.Copysign(math.Pow(math.Abs(math.Sin(theta)), 2/squircleN), math.Sin(theta))
		if i > 0 {
			sq.WriteString("L")
		}
		fmt.Fprintf(&sq, "%.3f %.3f ", half+u*half, half+v*half)
	}
	sq.WriteString("Z")

	s, tx, ty := transformFor(iconSpec{size: int(size), boxFrac: 0.76}, all)
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %g %g" width="%g" height="%g" role="img" aria-label="%s">
<title>%s</title>
<path d="M%s" fill="#3482FF"/>
<g transform="translate(%.3f %.3f) scale(%.5f)" fill="none" stroke="#FFFFFF" stroke-width="%.3f" stroke-linecap="round" stroke-linejoin="round">
`, size, size, size, size, label, label, strings.TrimSpace(sq.String()), tx, ty, s, strokePxFor(int(size))/s)
	for _, d := range paths {
		fmt.Fprintf(&b, "<path d=\"%s\"/>\n", d)
	}
	b.WriteString("</g>\n</svg>\n")
	return b.String(), nil
}

// encodeICO 打一个 32bpp BMP 条目式 ICO（16/32/48 三档）。位图条目比 PNG-in-ICO
// 兼容面大（老 Windows 的缩略图与某些浏览器只认位图条目）。蓝底超椭圆之外仍是透明：
// 32bpp 的 alpha 通道（Vista+ 采纳）+ AND 掩码按 alpha 置位——只看掩码的老客户端
// 也能把圆角外读成透明，而不是垫一块黑。
func encodeICO(sizes []int, base iconSpec) ([]byte, error) {
	type entry struct {
		size int
		bmp  []byte
	}
	var entries []entry
	for _, sz := range sizes {
		spec := base
		spec.size = sz
		img, err := renderIcon(spec)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry{sz, bmpEntry(img)})
	}
	var buf bytes.Buffer
	binary.Write(&buf, binary.LittleEndian, uint16(0)) // reserved
	binary.Write(&buf, binary.LittleEndian, uint16(1)) // type: icon
	binary.Write(&buf, binary.LittleEndian, uint16(len(entries)))
	offset := 6 + 16*len(entries)
	for _, e := range entries {
		w := uint8(e.size)
		if e.size >= 256 {
			w = 0
		}
		buf.WriteByte(w)
		buf.WriteByte(w)                                    // 宽高：0 表示 256
		buf.WriteByte(0)                                    // 调色板色数
		buf.WriteByte(0)                                    // 保留
		binary.Write(&buf, binary.LittleEndian, uint16(1))  // planes
		binary.Write(&buf, binary.LittleEndian, uint16(32)) // bitcount
		binary.Write(&buf, binary.LittleEndian, uint32(len(e.bmp)))
		binary.Write(&buf, binary.LittleEndian, uint32(offset))
		offset += len(e.bmp)
	}
	for _, e := range entries {
		buf.Write(e.bmp)
	}
	return buf.Bytes(), nil
}

// bmpEntry 把图像编成 ICO 的位图条目：40 字节 BITMAPINFOHEADER（高度 ×2 因为
// XOR 与 AND 两张图叠放）+ BGRA 自下而上像素行 + 按 alpha 置位的 AND 掩码。
func bmpEntry(img *image.NRGBA) []byte {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	andStride := ((w + 31) / 32) * 4
	data := make([]byte, 40+w*h*4+andStride*h)
	binary.LittleEndian.PutUint32(data[0:], 40)
	binary.LittleEndian.PutUint32(data[4:], uint32(w))
	binary.LittleEndian.PutUint32(data[8:], uint32(h*2))
	binary.LittleEndian.PutUint16(data[12:], 1)  // planes
	binary.LittleEndian.PutUint16(data[14:], 32) // bitcount
	binary.LittleEndian.PutUint32(data[16:], 0)  // BI_RGB
	binary.LittleEndian.PutUint32(data[20:], uint32(w*h*4+andStride*h))
	i := 40
	for y := h - 1; y >= 0; y-- { // 自下而上
		for x := 0; x < w; x++ {
			c := img.NRGBAAt(x, y)
			data[i] = c.B
			data[i+1] = c.G
			data[i+2] = c.R
			data[i+3] = c.A
			i += 4
		}
	}
	// AND 掩码：位=1 表示透明。超椭圆切角必须置位——只读掩码的老客户端
	//（缩略图、某些浏览器）不看 alpha，掩码全 0 会把切角画成一块黑。
	and := i                      // i 已指向像素区末尾 = 掩码起点
	for y := h - 1; y >= 0; y-- { // 自下而上，与像素行同序
		for x := 0; x < w; x++ {
			if img.NRGBAAt(x, y).A < 128 {
				data[and+x/8] |= 0x80 >> uint(x%8)
			}
		}
		and += andStride
	}
	return data
}
