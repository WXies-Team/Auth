package auth

import (
	"html"
	"log/slog"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// 邮件模板（2026-11 完全重写）：**结构一套、品牌按 app 换**。本服务统一为两个日记
// 签发验证码与安全通知，收件人看到的应是自己在用的那个 App 的名字——主题前缀、
// 眉题、警示句、落款、发件人显示名与托管 logo 都取自下面的品牌注册表；缺省或空 app
// 用中性品牌 Auth（统一账号服务不借任何 App 的名头，也是 web 账号台的默认品牌）。
//
// # 架构：语义内容块 → 两种渲染
//
// 模板不再手写两份平行字符串，而是组装 [mailBody]（内容块 + 顺序），由 render
// 产出 multipart/alternative 的两个部件：HTML 与 text/plain。两形态**同源**，纯文本
// 是结构化降级而不是抄写；注入面收敛到唯一渲染点（html.EscapeString），模板散文
// 一律存原始串（邮箱、设备名、邀请人不再逐处手工转义，也就不需要 stripTags 反解）。
// 块只有四种：段落（正文/警示/次文三语气）、验证码卡、明细卡、主按钮。
//
// # 发件人（与 support@horatio.cn 的组合）
//
// 显示名 = 品牌名本身（热量日记 / 开支日记 / Auth），**不加用途后缀**：
//   - 交易类邮件的业界主流就是纯品牌署名（Benchmark 2026、WP Mail SMTP：密码重置
//     等交易信应来自公司名而非个人）；Gmail 2025 年的显示名指南明确要求显示名只用于
//     标识发件人，禁止把主题/用途/表情塞进显示名，且要保持一致（iContact 摘要
//     support.google.com/a/answer/81126）；
//   - 移动端显示名约 20–25 字符截断（Brevo / Bento），品牌名 4–5 字远在安全线内；
//   - 发件地址 support@horatio.cn 是**可回信地址**而非 no-reply（业界反例清单：
//     no-reply 伤送达率与信任，Mailjet/Userpilot），页脚再声明「此邮件不可回复」。
//   - From 域 horatio.cn 与阿里 SMTP 账户同域 → SPF/DKIM/DMARC 对齐天然成立
//     （Gmail sender guidelines：DMARC 要求 From 域与 SPF 或 DKIM 域对齐）。
//
// # 主题行（≤50 字符、移动端 ~43 字符截断，Zoho/Shopify/BentoNow 口径）
//
//   - 统一带【品牌】前缀：中文收件箱的分类惯例（【】是行内惯例），且让「按品牌
//     过滤/搜索」一步成立；
//   - 验证码信 = 前缀 + 用途 + 「验证码」，**不把码放进主题**：主题会显示在锁屏与
//     通知预览里，带外凭据不应在未解锁设备上露出（NIST SP 800-63B 的锁屏口径，
//     SMTPGrid OTP 指南同结论）；preheader 也只写用途与时效，不写码；
//   - 安全警报/回执 = 前缀 + 事件的平实陈述（过去时、零感叹号、零 URGENT——
//     急迫词是钓鱼信号，BentoNow 反例清单），与 h1 同一句话，收件箱与正文对得上。
//
// # 正文结构（逐封块序即结构）
//
//   - preheader：与主题互补（补时效/下一步），隐藏 div + 零宽填充；
//   - 验证码信：**码卡第一屏**（标题之后直接给码，SMTPGrid「lead with the code」）→
//     一句用法 → 垃圾箱/重发指引（具体可执行：搜哪个发件人、60 秒冷却，对齐
//     docs/ui-research-2026-10 A-6 与 CZL Connect 重发口径）→ 「不是你」降噪句 →
//     红警示句 → 反钓鱼声明；**零链接零 CTA**（见下）；
//   - 安全信页脚前恒有反钓鱼声明 antiPhish（各信同句，Microsoft/Google/ReportCyber
//     口径：同一句固定声明比每封新写更有识别度）；
//   - 页脚：落款 + 此邮件不可回复 + ©。交易信无需退订链接（Gmail/Yahoo 对交易类
//     豁免 one-click unsubscribe），正文不放营销位。
//
// # CTA 与链接（行为面）
//
//   - 验证码信**零链接**：OTP 信带登录链接等于教用户在安全邮件里点链接
//     （oqumail OTP 指南「Do not include links in an OTP email」；Mailflow 排除项：
//     营销链接、多 CTA）。要「去哪填码」的引导由 App 内完成；
//   - 纯安全警报（改绑旧邮箱 / 管理员改邮旧邮箱 / 注销完成）**零可点链接**——
//     警报信再挂按钮只给钓鱼信递刀；下一步用文字说清（Artor 口径）；
//   - 真正要点击的动作（设置新密码 / 撤销注销 / 邀请 / 审查设备）才用 bulletproof
//     按钮：底色与指标落在 <td>（部分中文客户端剥 <a> 内联样式），VML [if mso] 兜底，
//     高 48px ≥ HIG 44pt 触控目标；正文次要动作用内联下划线文字链（不靠颜色单独
//     表意，Mailchimp 暗色清单）；
//   - 每个 HTML 里的 href 在 text 部件都有对应脚注行（label：URL），纯文本客户端
//     与图片屏蔽场景不丢出路；
//   - **token 不进统计参数**：不加 UTM、不挂重定向跟踪域——安全信开点击跟踪会
//     被网关预点、烧掉一次性链接（unspam 2026），还会破坏「悬停核对 URL」的反钓鱼
//     训练（UW IT）。正文链接就是带 token 的原生 https 落点。
//
// # 排版与样式（HIG / Apple typography + miuix 分组落地到邮件）
//
//   - 600px 单列、表格布局；**关键样式全部内联**（Gmail/Outlook 对 <style> 支持不
//     一致，内联是唯一可靠载体），<style> 只放一段媒体查询做渐进增强（≤620px 收
//     边距、码字距收紧）——被剥掉也不影响版面；
//   - 字阶固定四档：眉题/元信息 13、正文 16、h1 22、验证码 36（<13 不用）；
//     层级靠**字重 + 字距 + 行高**成套给：h1 600 字重、-0.01em 收字距（大字收、
//     小字放——Apple「tracking 是分尺寸的」），正文行高 1.7（中文长句需要松行），
//     13px 元信息 +0.02em 放字距；
//   - 色板全程避开纯白底/纯黑字（画布 #F1F4F9、卡片 #FAFBFD、主文 #1F2430）：
//     深色模式策略是**声明 light + 抗反转配色**，不追 prefers-color-scheme——
//     Gmail 移动端/Outlook 会对纯色做整卡反转，而 off-palette 配色在两种模式下都
//     可读（Microsoft Learn、Sendlayer 深色指南）；Apple Mail 需要 color-scheme
//     opt-in 才不自行半反转，故两个 meta 都给（Courier 2026 客户端矩阵）；
//   - 文字对比度全部 ≥4.5:1（主文 13+、次文 4.5+、警示红 #C93A2A 压卡 4.92、
//     CTA 白字压 #1363D6 5.55）；logo 带 alt + 显式宽高（图片屏蔽与可访问性），
//     所有布局表 role="presentation"。
//
// 文案四段式：首句发生了什么 → 细节（时间/设备等，有则列）→「不是我」/ 行动入口
// → 页脚。第二人称短句、零感叹号、零营销语、事件用名词化过去时陈述。

// siteBase 是托管资产与控制台链接的域名常量。邮件里的 https 链接全部由它拼出
// ——模板不接用户输入的 URL。
const siteBase = "https://auth.horatio.cn"

// accountURL 是模板里唯一的自助落点：账号台（自助台），未登录会 302 到登录页。
const accountURL = siteBase + "/web/console/account"

// brand 是一个品牌的全部可换串：外壳共用，换品牌就是换这几个字段。
type brand struct {
	name   string // 品牌名：眉题、警示句、发件人显示名（热量日记 / 开支日记 / Auth）
	latin  string // 落款第二段：App 拉丁名或域名（CalorieDiary / ExpenseDiary / auth.horatio.cn）
	footer string // 落款整串，形如「<name> <latin>」
	prefix string // 主题前缀，如 「【热量日记】」
	// account 是改绑通知里的属格串。中文品牌直接相接（热量日记账号）；中性品牌按
	// 作者定案用「账户」且拉丁名前留一个空格（" Auth 账户"）——中英混排的空格只在这里
	// 与 join 出现，模板不再逐处手写。
	account string
	// primaryHex 是品牌主色在邮件里**承载文字的形态**（CTA 按钮白字底、正文文字
	// 链接）：#3482FF 压白字 3.63:1、压卡 3.51:1 都不到 AA，取同色相压深的
	// #1363D6（白字 5.55 / 压卡 5.36 / 压画布 5.03）。品牌面的 #3482FF 只留在
	// logo 资产里（scripts/genicons 画、gen_test 断言钉死）——两者不同值是有意的。
	primaryHex string
	// logoPath 是托管 logo 的站内路径（/brand/<slug>-v1.png，internal/ui 静态路由，
	// scripts/genicons 生成）。品牌表按此口径引用，brand_test 逐个断言非空。
	logoPath string
}

// logoURL 返回邮件里 <img src> 的绝对地址（托管图，非 cid）。
func (b brand) logoURL() string { return siteBase + b.logoPath }

// brands 品牌注册表：键与 JWT aud 白名单（allowedApps）同集，两处一起加。
var brands = map[string]brand{
	"CalorieDiary": {
		name: "热量日记", latin: "CalorieDiary", footer: "热量日记 CalorieDiary",
		prefix: "【热量日记】", account: "热量日记账号",
		primaryHex: "#1363D6", logoPath: "/brand/CalorieDiary-v1.png",
	},
	"ExpenseDiary": {
		name: "开支日记", latin: "ExpenseDiary", footer: "开支日记 ExpenseDiary",
		prefix: "【开支日记】", account: "开支日记账号",
		primaryHex: "#1363D6", logoPath: "/brand/ExpenseDiary-v1.png",
	},
	// 两个外部项目（2026-11 接入 OAuth）：展示名按各自 README/站内名
	//（奇奇岛护照 README 标题是「奇奇岛电子护照」，站内页头与后台标题用「奇奇岛护照」）。
	"EPassportForMikey": {
		name: "奇奇岛护照", latin: "EPassportForMikey", footer: "奇奇岛护照 EPassportForMikey",
		prefix: "【奇奇岛护照】", account: "奇奇岛护照账号",
		primaryHex: "#1363D6", logoPath: "/brand/EPassportForMikey-v1.png",
	},
	"PersonalShortener": {
		name: "屑涵短链", latin: "PersonalShortener", footer: "屑涵短链 PersonalShortener",
		prefix: "【屑涵短链】", account: "屑涵短链账号",
		primaryHex: "#1363D6", logoPath: "/brand/PersonalShortener-v1.png",
	},
}

// neutralBrand 是缺省品牌 Auth：SendCodeRequest.app 没给（web 账号台口径）与所有
// 拿不到 app 的发信场合都用它。
var neutralBrand = brand{
	name: "Auth", latin: "auth.horatio.cn", footer: "Auth auth.horatio.cn",
	prefix: "【Auth】", account: " Auth 账户",
	primaryHex: "#1363D6", logoPath: "/brand/auth-v1.png",
}

// brandFor 按 app 取品牌，空与未知都回 Auth：非法 app 在上游已被 validateApp 挡成
// 400（或来自 JWT aud 白名单），这里不重复报错，兜底中性品牌最稳。
func brandFor(app string) brand {
	if b, ok := brands[app]; ok {
		return b
	}
	return neutralBrand
}

// join 把品牌名与后接的中文连起来：拉丁名（Auth）补一个空格，中文名不补。
// 中英混排的空格规则集中在这里，模板不逐处手写。
func (b brand) join(zh string) string {
	if b.name != "" && b.name[0] < utf8.RuneSelf {
		return b.name + " " + zh
	}
	return b.name + zh
}

// ---- 外壳组件（全站唯一一套）----

// emailFont 是邮件正文的字体栈：Apple 起手，中文字体依次 PingFang / HarmonyOS Sans /
// MiSans，回落 system-ui / Arial。邮件不能嵌字体，栈是客户端自选的。
// 字体名用**单引号**：style 是双引号属性，栈里再出现双引号会把属性在第一个引号处
// 截断（style 只剩 font-family:-apple-system,，后面的字号颜色全丢）——2026-11 重写
// 修掉的存量 bug，TestStyleAttributesAreWellFormed 逐封钉住。
const emailFont = `font-family:-apple-system,'PingFang SC','HarmonyOS Sans','MiSans',system-ui,Arial,sans-serif;`

// 外壳色板（抗反转口径：不出现 #FFFFFF 大底与 #000000 正文；文字色均 ≥4.5:1）。
const (
	mailCanvas  = "#F1F4F9" // 画布
	mailCard    = "#FAFBFD" // 主卡片
	mailInk     = "#1F2430" // 主文（压卡 13+:1）
	mailSub     = "#646B7A" // 次文（压卡 5.6:1）
	mailDim     = "#5F6785" // 页脚（压卡 5.39:1，同 style.css --section-title）
	mailHair    = "#E7EAEF" // 分隔线/卡片描边
	mailCodeBox = "#E8F0FE" // 验证码卡底（品牌主色的淡版）
	mailTipBox  = "#F0F2F5" // 明细卡底
	mailWarn    = "#C93A2A" // 「不是我」警示红（压卡 4.92:1，同 style.css --danger-ink）
)

// ---- 内容块模型：模板只填内容，渲染只此一处 ----

// seg 是正文里的一段文字；href 非空时是内联链接。HTML 版渲染成下划线锚点，
// 纯文本版把句子拼完整后另起一行落「标签：URL」脚注（降级 URL 的家）。
type seg struct{ text, href string }

func plain(s string) seg            { return seg{text: s} }
func linked(label, href string) seg { return seg{text: label, href: href} }

// paraKind 决定段落语气：正文（墨色 16）/ 警示（红 16）/ 次文（灰 13）。
type paraKind int

const (
	pBody paraKind = iota
	pWarn
	pMeta
)

// para 是一段话。segs 顺序即句子顺序，链接嵌在句中。
type para struct {
	kind paraKind
	segs []seg
}

func (p para) renderHTML(b brand) string {
	var style string
	switch p.kind {
	case pWarn:
		style = `margin:0 0 16px;font-size:16px;font-weight:400;line-height:1.7;color:` + mailWarn + `;`
	case pMeta:
		style = `margin:0 0 16px;font-size:13px;font-weight:400;line-height:1.6;letter-spacing:0.02em;color:` + mailSub + `;`
	default:
		style = `margin:0 0 16px;font-size:16px;font-weight:400;line-height:1.7;color:` + mailInk + `;`
	}
	var sb strings.Builder
	sb.WriteString(`            <p style="` + emailFont + style + `">`)
	for _, s := range p.segs {
		if s.href == "" {
			sb.WriteString(html.EscapeString(s.text))
			continue
		}
		sb.WriteString(`<a href="` + html.EscapeString(s.href) + `" style="color:` + b.primaryHex + `;text-decoration:underline;">` +
			html.EscapeString(s.text) + `</a>`)
	}
	sb.WriteString("</p>\n")
	return sb.String()
}

func (p para) renderText() string {
	var sb strings.Builder
	for _, s := range p.segs {
		sb.WriteString(s.text)
	}
	for _, s := range p.segs {
		if s.href != "" {
			sb.WriteString("\n" + s.text + "：" + s.href)
		}
	}
	return sb.String()
}

// codeCard 是验证码卡：大字号 + 字距分组（跨房间可读），下方元信息给时效。
// 码只会是数字，仍过转义（渲染点统一兜底）。
type codeCard struct{ code, expiry string }

func (c codeCard) renderHTML(b brand) string {
	return `            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="` + mailCodeBox + `" style="width:100%;background-color:` + mailCodeBox + `;border:1px solid ` + b.primaryHex + `;border-radius:16px;margin:0 0 16px;">
              <tr>
                <td align="center" style="padding:26px 12px 22px;">
                  <div class="code" style="` + emailFont + `margin:0;font-size:36px;font-weight:600;line-height:1.2;letter-spacing:12px;text-indent:12px;text-align:center;color:` + mailInk + `;">` + html.EscapeString(c.code) + `</div>
                  <p style="` + emailFont + `margin:12px 0 0;font-size:13px;font-weight:400;line-height:1.6;letter-spacing:0.02em;color:` + mailSub + `;">` + html.EscapeString(c.expiry) + `</p>
                </td>
              </tr>
            </table>
`
}

func (c codeCard) renderText() string { return c.code + "\n" + c.expiry }

// row 是明细卡里的一行：label 非空渲染成「灰标签 + 墨色值」（设备/项目/时间），
// label 为空是纯文本行（注销范围清单）。纯文本版统一「标签：值」。
type row struct{ label, value string }

// panel 是明细/清单卡（miuix 分组：相关项聚进同一底色块，不靠分隔线切碎正文）。
type panel struct{ rows []row }

func (p panel) renderHTML(_ brand) string {
	var sb strings.Builder
	sb.WriteString(`            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="` + mailTipBox + `" style="width:100%;background-color:` + mailTipBox + `;border-radius:12px;margin:0 0 16px;">
              <tr>
                <td style="padding:16px 18px;">`)
	for i, r := range p.rows {
		margin := `margin:0 0 6px;`
		if i == len(p.rows)-1 {
			margin = `margin:0;`
		}
		line := `font-size:16px;font-weight:400;line-height:1.7;`
		sb.WriteString("\n                  <p style=\"" + emailFont + margin + line)
		if r.label == "" {
			sb.WriteString(`color:` + mailSub + `;">` + html.EscapeString(r.value) + `</p>`)
		} else {
			sb.WriteString(`color:` + mailInk + `;"><span style="color:` + mailSub + `;">` +
				html.EscapeString(r.label) + `：</span>` + html.EscapeString(r.value) + `</p>`)
		}
	}
	sb.WriteString(`
                </td>
              </tr>
            </table>
`)
	return sb.String()
}

func (p panel) renderText() string {
	lines := make([]string, 0, len(p.rows))
	for _, r := range p.rows {
		if r.label == "" {
			lines = append(lines, r.value)
		} else {
			lines = append(lines, r.label+"："+r.value)
		}
	}
	return strings.Join(lines, "\n")
}

// cta 是主按钮（bulletproof 形态）：药丸的底色/内边距/高度/白字全落在 <td> 上
// （部分中文邮箱客户端会剥 <a> 内联样式），<a> 只留同款声明作渐进增强 + VML [if mso]
// 兜底。高 48px ≥ HIG 44pt 触控目标；一个 CTA 只配一个动作，按钮下不挂裸链接
// （降级 URL 归 text 部件的 label 行）。
type cta struct{ label, href string }

func (c cta) renderHTML(b brand) string {
	label, href := html.EscapeString(c.label), html.EscapeString(c.href)
	// VML 宽度按标签字数估（Outlook 只认这条路径，宁可偏宽也别截字）
	width := 56 + 17*utf8.RuneCountInString(c.label)
	return `            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
              <tr>
                <td align="center" bgcolor="` + b.primaryHex + `" style="background-color:` + b.primaryHex + `;border-radius:16px;padding:0 28px;height:48px;color:#FFFFFF;">
                  <!--[if mso]>
                  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="` + href + `" style="height:48px;v-text-anchor:middle;width:` + strconv.Itoa(width) + `px;" arcsize="34%" stroke="f" fillcolor="` + b.primaryHex + `">
                    <w:anchorlock/>
                    <center style="color:#FFFFFF;font-family:Arial,sans-serif;font-size:16px;">` + label + `</center>
                  </v:roundrect>
                  <![endif]-->
                  <a href="` + href + `" style="` + emailFont + `display:inline-block;line-height:48px;font-size:16px;font-weight:500;color:#FFFFFF;text-decoration:none;border-radius:16px;">` + label + `</a>
                </td>
              </tr>
            </table>
`
}

func (c cta) renderText() string { return c.label + "\n" + c.href }

// block 是正文里的一个可渲染单元：同一份数据出 HTML 与纯文本两形态。
type block interface {
	renderHTML(b brand) string
	renderText() string
}

// mailBody 是模板与外壳之间的唯一契约：模板只描述「这封信有什么」（原始未转义的
// 字符串 + 块顺序），render 统一产出 multipart/alternative 的两个部件。
type mailBody struct {
	scene     string // 眉题场景段（品牌名由外壳统一给）
	title     string // 主标题（h1；主题行按模板各自的定案另给）
	preheader string // 收件箱预览行：与主题互补，**不放验证码**
	blocks    []block
}

// render 产出 HTML 与纯文本。转义只发生在这里：动态串（邮箱、设备名、邀请人、码）
// 在模板里是原始值，进 HTML 前统一 html.EscapeString；纯文本用原始值。
func (m mailBody) render(b brand) (htmlBody, text string) {
	var inner strings.Builder
	// 眉题：品牌名 · 场景（13px 次文，字距微放——小字加字距是 Apple 的分尺寸口径）
	inner.WriteString(`            <p style="` + emailFont + `margin:0 0 8px;font-size:13px;font-weight:400;line-height:1.6;letter-spacing:0.02em;color:` + mailSub + `;">` +
		html.EscapeString(b.name) + ` &middot; ` + html.EscapeString(m.scene) + `</p>
`)
	// h1：22px / 600 字重 / -0.01em（大字收字距）——层级靠字重+字距+行高成套
	inner.WriteString(`            <h1 style="` + emailFont + `margin:0 0 14px;font-size:22px;font-weight:600;line-height:1.35;letter-spacing:-0.01em;color:` + mailInk + `;">` +
		html.EscapeString(m.title) + `</h1>
`)
	for _, blk := range m.blocks {
		inner.WriteString(blk.renderHTML(b))
	}
	inner.WriteString(antiPhishHTML())

	htmlBody = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>` + html.EscapeString(m.title) + `</title>
<style type="text/css">
@media only screen and (max-width:620px){
.wrap{padding:16px 8px!important;}
.card-pad{padding:24px 18px!important;}
.code{letter-spacing:8px!important;text-indent:8px!important;}
}
</style>
</head>
<body style="margin:0;padding:0;background-color:` + mailCanvas + `;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">` +
		html.EscapeString(m.preheader) + `&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="` + mailCanvas + `" style="background-color:` + mailCanvas + `;">
  <tr>
    <td align="center" class="wrap" style="padding:32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="` + mailCard + `" style="width:100%;max-width:600px;background-color:` + mailCard + `;border:1px solid ` + mailHair + `;border-radius:20px;">
        <tr>
          <td class="card-pad" style="padding:26px 32px 30px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
              <tr>
                <td style="padding:0;vertical-align:middle;"><img src="` + b.logoURL() + `" width="48" height="48" alt="` + html.EscapeString(b.name) + `" border="0" style="display:block;width:48px;height:48px;border:0;"></td>
                <td style="padding:0 12px;vertical-align:middle;"><span style="` + emailFont + `font-size:17px;font-weight:600;line-height:1.3;color:` + mailInk + `;">` + html.EscapeString(b.name) + `</span></td>
              </tr>
              <tr>
                <td colspan="2" style="padding:16px 0 0;"><div style="height:3px;width:36px;border-radius:2px;background-color:` + b.primaryHex + `;"></div></td>
              </tr>
            </table>
` + inner.String() + `
            <hr style="border:0;border-top:1px solid ` + mailHair + `;margin:26px 0 14px;">
            <p style="` + emailFont + `margin:0 0 4px;font-size:13px;line-height:1.6;color:` + mailDim + `;">` + html.EscapeString(b.footer) + `</p>
            <p style="` + emailFont + `margin:0 0 4px;font-size:13px;line-height:1.6;color:` + mailDim + `;">此邮件不可回复。</p>
            <p style="` + emailFont + `margin:0;font-size:13px;line-height:1.6;color:` + mailDim + `;">© 2026·屑涵</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`

	// 纯文本：眉题 → 标题 → 块（空行分隔）→ 反钓鱼声明 → 分隔线与落款。
	// 链接在句中保留标签、句后另起一行给完整 URL。
	text = b.name + " · " + m.scene + "\n\n" + m.title
	for _, blk := range m.blocks {
		text += "\n\n" + blk.renderText()
	}
	text += "\n\n" + antiPhish + "\n\n——\n" + footText(b)
	return htmlBody, text
}

// footText 是纯文本版页脚的落款段（render 拼在正文之后）。
func footText(b brand) string {
	return b.footer + "\n此邮件不可回复\n© 2026·屑涵"
}

// antiPhish 是所有安全信页脚前的固定反钓鱼声明：明示本服务不会索要密码、验证码
// 与转账（Microsoft/Google/ReportCyber 口径）。中性一句话，不随品牌、场景变；
// 每封信同一句，收件人能凭这一句认信。
const antiPhish = "我们不会向你索要密码、验证码或转账。"

// antiPhishHTML 把声明排成正文最后一段（页脚分隔线之前）：13px 次文，平静陈述句
// ——它不是红色警示，是「本服务行为边界」的自证。
func antiPhishHTML() string {
	return `            <p style="` + emailFont + `margin:4px 0 0;font-size:13px;line-height:1.6;letter-spacing:0.02em;color:` + mailSub + `;">` + antiPhish + `</p>`
}

// mailLog 发信失败要留排障线索：客户端只看到白话，根因（SMTP 会话错误、
// 服务器拒绝码与响应）只在服务端日志。邮箱过 maskEmail 脱敏——日志会进排障链路与备份，
// 全文邮箱是 PII。
func mailLog(err error, purpose, email string) {
	slog.Error("发送邮件失败", "purpose", purpose, "email", maskEmail(email), "err", err)
}

// safeTime 是通知信里时间戳的统一形态（本地时区，分钟精度够用户对时）。
func safeTime(t time.Time) string { return t.Format("2006-01-02 15:04") }

// codeEmail 拼验证码信（注册 / 找回密码 / 修改密码 / 登录 / 登录两步验证 / 注销账号 /
// 修改邮箱 七类共用）。结构按 OTP 业界口径定序：码卡第一屏 → 一句用法 → 垃圾箱/重发
// 指引 → 「不是你」降噪句 → 红警示句 → 反钓鱼声明。
//
// **零链接零 CTA**：OTP 信带链接等于教用户在安全邮件里点链接（oqumail、Mailflow
// 双口径），要「去哪填码」的引导由 App 内完成；text 部件同样一个 URL 都没有。
//
// action 只会是七个字面量之一（由 purpose 分流，不来自用户输入），code 只含数字
// ——两处都没有 HTML 注入面；渲染点仍统一转义。
func codeEmail(b brand, action, code string) (subject, htmlBody, text string) {
	subject = b.prefix + action + "验证码"
	// 勿分享警示按 Latitude/ReportCyber 口径强化：把「平台工作人员」点名排除在
	// 可信索码方之外，并把「有人要 → 诈骗 → 举报」说成一句短话。preheader 与正文
	// 必须同源，否则收件箱预览和邮件正文会出现两种口径。品牌句仍走 b.join。
	warn := b.join("不会向你要验证码") + "，平台工作人员也不会。有人要，就是诈骗，请立刻举报。"
	m := mailBody{
		scene:     "邮箱验证",
		title:     action + "验证码",
		preheader: action + "验证码 5 分钟内有效；没收到请检查垃圾邮件。",
		blocks: []block{
			codeCard{code: code, expiry: "5 分钟内有效"},
			para{segs: []seg{plain("在应用里填入这 6 位验证码，继续" + action + "。")}},
			// 重发指引要具体可执行（搜哪个发件人、多久能重发）：60 秒是 otpStore 的
			// 冷却口径，发件人显示名与信头 From 同源——用户在垃圾箱里搜得到。
			para{kind: pMeta, segs: []seg{plain("没收到？在垃圾箱里搜索「" + b.name + "」；60 秒后可重新发送。")}},
			panel{rows: []row{{value: "不是你操作？忽略这封邮件即可，账号不会有任何变化。"}}},
			para{kind: pWarn, segs: []seg{plain(warn)}},
		},
	}
	htmlBody, text = m.render(b)
	return subject, htmlBody, text
}

// changeEmailNoticeEmail 改绑邮箱后的通知信（旧、新邮箱各一封）：说清「哪个邮箱变成了
// 什么」，再给非本人操作时的下一步——两句一事。
//
// 旧邮箱那封是**安全警报**（Artor 口径）：正文**零可点链接**——改绑本身已由验证码把关，
// 警报信再挂按钮只会给钓鱼信递刀；下一步只用文字说清（修改密码 / 联系管理员 /
// 「找回密码」自助重置）。新邮箱那封是使用指引：新邮箱值 + 生效时间 + 下次登录用新
// 邮箱，保留账号台按钮。时间由模板自取发信时刻（业务调用方不携带时间戳，发信即生效，
// 两者同一时刻）。
//
// 邮箱以**原始值**进内容块，渲染点统一 html.EscapeString：validateEmail 的正则不拦
// `<>&`，不转义就是注入面。
func changeEmailNoticeEmail(b brand, toNew bool, oldEmail, newEmail string) (subject, htmlBody, text string) {
	if toNew {
		subject = b.prefix + "新邮箱已绑定"
		lead := newEmail + " 已成为" + b.account + "的绑定邮箱（原绑定邮箱 " + oldEmail + "），自 " + safeTime(time.Now()) + " 起生效，该账号的验证码会发到这里。"
		const guidance, warn = "下次登录请使用新邮箱。", "不是你本人知情的操作？请立即联系管理员。"
		m := mailBody{
			scene:     "账号安全",
			title:     "新邮箱已绑定",
			preheader: "新邮箱已绑定，下次登录请使用新邮箱。",
			blocks: []block{
				para{segs: []seg{plain(lead)}},
				para{segs: []seg{plain(guidance)}},
				para{kind: pWarn, segs: []seg{plain(warn)}},
				cta{label: "管理账号", href: accountURL},
			},
		}
		htmlBody, text = m.render(b)
		return subject, htmlBody, text
	}
	subject = b.prefix + "绑定邮箱已更换"
	// 警报信给到分钟级时间戳：安全通知的时间上下文帮用户对号（OWASP 失败登录通知
	// 同口径），也让「什么时候被改的」在收件箱里一眼可查。
	lead := "你的账号绑定邮箱已于 " + safeTime(time.Now()) + " 由 " + oldEmail + " 改为 " + newEmail + "。"
	warn := "若非本人操作，请立即修改密码并联系管理员；也可用「找回密码」自助重置。"
	m := mailBody{
		scene:     "账号安全",
		title:     "绑定邮箱已更换",
		preheader: "你的绑定邮箱已更换。若非本人操作，请立即修改密码并联系管理员。",
		blocks: []block{
			para{segs: []seg{plain(lead)}},
			para{kind: pWarn, segs: []seg{plain(warn)}},
		},
	}
	htmlBody, text = m.render(b)
	return subject, htmlBody, text
}

// ---- 账号生命周期五封信（密码重置 / 改密确认 / 注销确认 / 注销撤销 / 注销完成）----
//
// 五封都是**账号级**通知（与具体 App 无关），品牌走 brandFor("") = 中性 Auth
//（subject 前缀【Auth】，契约钉死）——auth 是统一账号服务，不借任何 App 的名头
// 说「你的热量日记账号被注销了」这类话（AGENTS §7：auth 的文案永远是通用口径）。

// passwordResetNoticeEmail 管理员重置密码的通知信（W1，notify=true 时发）：
// 主题与 h1 同为事件陈述「密码已被重置」（主题行与正文一句话，收件箱对得上）；
// 场景 + 重置时间 + 临时密码本体 + 「尽快登录并立即改密」的按钮 + 非本人操作找
// 管理员——正文最小化，不带 uid、角色、操作者等任何额外账号信息。重置时间由模板
// 自取发信时刻（发信紧跟重置，同一时刻）。
func passwordResetNoticeEmail(b brand, setupURL string) (subject, htmlBody, text string) {
	subject = b.prefix + "密码已被重置"
	lead := "管理员已于 " + safeTime(time.Now()) + " 重置了你的密码。请用下面的链接设置新密码。"
	m := mailBody{
		scene:     "账号安全",
		title:     "你的密码已被重置",
		preheader: "你的密码已被管理员重置，请在 1 小时内设置新密码。",
		blocks: []block{
			para{segs: []seg{plain(lead)}},
			para{kind: pMeta, segs: []seg{plain("链接 1 小时内有效，只能用一次。")}},
			cta{label: "设置新密码", href: setupURL},
			para{kind: pWarn, segs: []seg{plain("不是你本人操作？请联系管理员。")}},
		},
	}
	htmlBody, text = m.render(b)
	return subject, htmlBody, text
}

// passwordChangedNoticeEmail 自助改密成功后的确认信（Okta 口径：时间 + 入口，
// **不含任何密码字段**）——用户没主动改却收到这封信，就是账号出事的信号。
// 结构：事件主句 → 降噪先手句 → 会话范围说明（改密在 setPasswordAndRevoke 里
// **全吊销、不保活任何一行**，当前设备靠 reissueToken 换发续用——文案与之一字对应）
// → 分层「不是我」：改密入口（security 页）与设备审查入口（sessions 页）各挂一枚
// 正文内联文字链 → 反钓鱼声明。
func passwordChangedNoticeEmail(b brand, at time.Time) (subject, htmlBody, text string) {
	const securityURL, sessionsURL = siteBase + "/web/console/security", siteBase + "/web/console/sessions"
	subject = b.prefix + "密码已修改"
	lead := "你的账号密码已于 " + safeTime(at) + " 修改成功。"
	const reassure, scopeLine = "如果是你本人操作，无需任何行动。", "其它设备上的登录已全部退出，当前设备保持登录。"
	warn := []seg{
		plain("若非本人操作，请立即"),
		linked("修改密码", securityURL),
		plain("并"),
		linked("审查登录设备", sessionsURL),
		plain("。"),
	}
	m := mailBody{
		scene:     "账号安全",
		title:     "密码已修改",
		preheader: lead + reassure,
		blocks: []block{
			para{segs: []seg{plain(lead)}},
			para{segs: []seg{plain(reassure)}},
			para{segs: []seg{plain(scopeLine)}},
			para{kind: pWarn, segs: warn},
			cta{label: "管理账号", href: accountURL},
		},
	}
	htmlBody, text = m.render(b)
	return subject, htmlBody, text
}

// deleteRequestEmail 注销申请的确认信（W3）：删除内容清单（Atlassian 模式）+ 到期
// 执行时间 + 撤销入口。主题把**已排期**说进主题里（「将于 <日期时刻> 执行」）——
// scheduled 与「注销已完成」在收件箱里一眼分信别，不会被当成事后通知划走。
// cancelURL 是完整撤销链接（token 已内嵌，服务端拼好；模板不接用户输入）。
// recoveryCodesChangedEmail 是恢复码重生成通知：旧码整组作废，必须让用户知道。
func recoveryCodesChangedEmail(b brand, at time.Time) (subject, htmlBody, text string) {
	subject = b.prefix + "恢复码已重新生成"
	lead := "你的两步验证恢复码已于 " + safeTime(at) + " 重新生成，旧的一组已全部作废。"
	m := mailBody{
		scene:     "账号安全",
		title:     "恢复码已重新生成",
		preheader: lead,
		blocks: []block{
			para{segs: []seg{plain(lead)}},
			para{kind: pWarn, segs: []seg{plain("若不是你本人操作，请立即修改密码并检查登录设备。")}},
			cta{label: "安全设置", href: siteBase + "/web/console/security"},
		},
	}
	htmlBody, text = m.render(b)
	return subject, htmlBody, text
}

// mfaDisabledNoticeEmail 是用户自助关闭两步验证后的确认信：关闭是削弱保护的
// 动作，必须留痕到可信渠道。
func mfaDisabledNoticeEmail(b brand, at time.Time) (subject, htmlBody, text string) {
	subject = b.prefix + "两步验证已关闭"
	lead := "你的账号于 " + safeTime(at) + " 关闭了两步验证。"
	m := mailBody{
		scene:     "账号安全",
		title:     "两步验证已关闭",
		preheader: lead,
		blocks: []block{
			para{segs: []seg{plain(lead)}},
			para{kind: pWarn, segs: []seg{plain("账号现在只剩密码一道防线。若不是你本人操作，请立即修改密码并重新开启两步验证。")}},
			cta{label: "安全设置", href: siteBase + "/web/console/security"},
		},
	}
	htmlBody, text = m.render(b)
	return subject, htmlBody, text
}

// passkeyChangedNoticeEmail 是 Passkey 增删后的安全通知：OWASP 要求凭证变更
// 走已有可信渠道告知用户；只报名称与时间，不带凭证 ID。
func passkeyChangedNoticeEmail(b brand, added bool, name string, at time.Time) (subject, htmlBody, text string) {
	action := "添加"
	if !added {
		action = "删除"
	}
	subject = b.prefix + "Passkey 已" + action
	lead := "你的账号于 " + safeTime(at) + " " + action + "了一把 Passkey（" + name + "）。"
	m := mailBody{
		scene:     "账号安全",
		title:     "Passkey 已" + action,
		preheader: lead,
		blocks: []block{
			para{segs: []seg{plain(lead)}},
			para{kind: pWarn, segs: []seg{plain("不是你本人操作？请立即修改密码并联系管理员。")}},
			cta{label: "管理 Passkey", href: siteBase + "/web/console/passkeys"},
		},
	}
	htmlBody, text = m.render(b)
	return subject, htmlBody, text
}

// smtpTestEmail 是配置中心「发送测试邮件」用的最小邮件：只验证 SMTP 链路。
func smtpTestEmail(b brand) (subject, htmlBody, text string) {
	subject = b.prefix + "SMTP 测试"
	now := safeTime(time.Now())
	m := mailBody{
		scene:     "系统通知",
		title:     "SMTP 配置可用",
		preheader: "收到这封信说明 Auth 的 SMTP 发信链路正常。",
		blocks: []block{
			para{segs: []seg{plain("这是一封测试邮件，发送时间 " + now + "。")}},
			para{segs: []seg{plain("收到它说明发信凭据与网络均正常；无需回复。")}},
		},
	}
	htmlBody, text = m.render(b)
	return subject, htmlBody, text
}

// mfaResetNoticeEmail 是管理员重置 MFA 后的通知信：账号级、中性品牌，只报
// 事实与下一步（重新绑定），不带操作者/uid/临时凭据。
func mfaResetNoticeEmail(b brand, at time.Time) (subject, htmlBody, text string) {
	subject = b.prefix + "两步验证已被重置"
	lead := "管理员已于 " + safeTime(at) + " 重置了你的两步验证与 Passkey。"
	m := mailBody{
		scene:     "账号安全",
		title:     "两步验证已被重置",
		preheader: lead,
		blocks: []block{
			para{segs: []seg{plain(lead)}},
			para{kind: pWarn, segs: []seg{plain("你的账号现在只剩密码一道防线。请尽快重新绑定两步验证或 Passkey。")}},
			cta{label: "重新绑定", href: siteBase + "/web/console/security"},
			para{kind: pWarn, segs: []seg{plain("不是你本人操作？请立即联系管理员并修改密码。")}},
		},
	}
	htmlBody, text = m.render(b)
	return subject, htmlBody, text
}

func deleteRequestEmail(b brand, cancelURL string, dueAt time.Time) (subject, htmlBody, text string) {
	due := safeTime(dueAt)
	subject = b.prefix + "注销申请已提交，将于 " + due + " 执行"
	m := mailBody{
		scene:     "账号注销",
		title:     "注销申请已提交",
		preheader: "注销将于 " + due + " 执行，点击链接可撤销。",
		blocks: []block{
			para{segs: []seg{plain("我们已收到你注销账号的申请，将于 " + due + " 执行。")}},
			panel{rows: []row{
				{value: "注销后将执行："},
				{value: "· 注销你在本服务下接入的全部项目"},
				{value: "· 清空所有项目的数据（不可恢复）"},
			}},
			cta{label: "撤销注销", href: cancelURL},
			para{kind: pWarn, segs: []seg{plain("不是你本人操作？请立刻点击上方按钮撤销，并联系管理员。")}},
		},
	}
	htmlBody, text = m.render(b)
	return subject, htmlBody, text
}

// deleteCancelledEmail 注销已撤销的通知信：事实 + 安心句（账号与数据一切照常）+
// 「不是本人怎么办」；账号已回到正常态，保留账号台入口与反钓鱼声明。
func deleteCancelledEmail(b brand) (subject, htmlBody, text string) {
	subject = b.prefix + "注销已撤销"
	const reassure = "你的账号和数据是安全的，一切照常。"
	const warn = "不是你本人操作？请立刻修改密码并检查登录设备。"
	m := mailBody{
		scene:     "账号注销",
		title:     "注销已撤销",
		preheader: "注销已撤销，你的账号和数据是安全的。",
		blocks: []block{
			para{segs: []seg{plain("你的账号注销申请已撤销。")}},
			para{segs: []seg{plain(reassure)}},
			para{kind: pWarn, segs: []seg{plain(warn)}},
			cta{label: "管理账号", href: accountURL},
		},
	}
	htmlBody, text = m.render(b)
	return subject, htmlBody, text
}

// deleteDoneEmail 注销完成的通知信：删除范围 + 不可逆陈述、**无任何链接**
// （账号已不存在，再给入口就是死链），页脚前带反钓鱼声明——注销后的空窗期正是
// 钓鱼信最爱冒名的时间点。
func deleteDoneEmail(b brand) (subject, htmlBody, text string) {
	subject = b.prefix + "注销已完成"
	const fact = "你的账号与全部项目数据已被永久删除，无法恢复。"
	m := mailBody{
		scene:     "账号注销",
		title:     "账号已注销",
		preheader: fact,
		blocks: []block{
			para{segs: []seg{plain(fact)}},
		},
	}
	htmlBody, text = m.render(b)
	return subject, htmlBody, text
}

// adminChangeEmailNoticeEmail 管理员更换邮箱的通知信（B5）：新旧邮箱各一封，
// 品牌恒中性 Auth（subject 前缀【Auth】，账号级操作不借 App 名头）。
//
// 与自助改绑的 changeEmailNoticeEmail 的差别在措辞归属：这封明确说是**管理员**改的、
// 用户没做任何操作——旧邮箱那封是安全警报（含新邮箱地址 + 时间戳 + 「若非本人操作
// 请立即改密并联系管理员」，同 Artor 口径**零可点链接**），新邮箱那封是使用指引
// （「下次登录请使用新邮箱」）。两封主题一眼分信别（「已被管理员更换」= 警报 /
// 「已生效」= 指引）。邮箱以原始值进内容块，渲染点统一转义。
func adminChangeEmailNoticeEmail(b brand, toNew bool, oldEmail, newEmail string) (subject, htmlBody, text string) {
	if toNew {
		subject = b.prefix + "新邮箱已生效"
		title := "新邮箱已成为登录邮箱"
		lead := newEmail + " 已成为" + b.account + "的登录邮箱（由管理员设置，原登录邮箱 " + oldEmail + "），该账号的验证码会发到这里。"
		const warn = "下次登录请使用新邮箱。不是你本人知情的操作？请联系管理员。"
		m := mailBody{
			scene:     "账号安全",
			title:     title,
			preheader: "新邮箱已生效，下次登录请使用新邮箱。",
			blocks: []block{
				para{segs: []seg{plain(lead)}},
				para{kind: pWarn, segs: []seg{plain(warn)}},
				cta{label: "管理账号", href: accountURL},
			},
		}
		htmlBody, text = m.render(b)
		return subject, htmlBody, text
	}
	subject = b.prefix + "登录邮箱已被管理员更换"
	title := "登录邮箱已被管理员更换"
	lead := "你的账号登录邮箱已于 " + safeTime(time.Now()) + " 由管理员从 " + oldEmail + " 更换为 " + newEmail + "，验证码将发往新邮箱。"
	const warn = "若非本人操作，请立即修改密码并联系管理员。"
	m := mailBody{
		scene:     "账号安全",
		title:     title,
		preheader: "登录邮箱已被管理员更换。若非本人操作，请立即修改密码并联系管理员。",
		blocks: []block{
			para{segs: []seg{plain(lead)}},
			para{kind: pWarn, segs: []seg{plain(warn)}},
		},
	}
	htmlBody, text = m.render(b)
	return subject, htmlBody, text
}

// loginNotifyEmail 新设备登录提醒（W1）：五段式——检测到新设备登录 → 降噪先手句
// （「如果是你本人，无需任何行动。」）→ 设备/项目/时间明细卡 → 「不是我」的两步
// （改密 + 退出其它设备，各带 auth web 深链）→ 审查设备按钮与「管理登录提醒」次文
// → 页脚（含反钓鱼声明）。**不带 IP**——业界登录告警的反面清单项，既非用户可对号
// 的凭据，又给钓鱼信递素材。品牌按登录来源：App 登录取该 App 品牌，web 登录取中性
// Auth（调用方 brandFor(app) 传入）。
func loginNotifyEmail(b brand, device, appLabel string, at time.Time) (subject, htmlBody, text string) {
	subject = b.prefix + "新设备登录提醒"
	securityURL, sessionsURL := siteBase+"/web/console/security", siteBase+"/web/console/sessions"
	const reassure = "如果是你本人，无需任何行动。"
	m := mailBody{
		scene:     "账号安全",
		title:     "检测到新设备登录",
		preheader: "检测到新设备登录（" + device + "）。" + reassure,
		blocks: []block{
			para{segs: []seg{plain("你的账号刚刚在一台新设备上登录。")}},
			para{segs: []seg{plain(reassure)}},
			panel{rows: []row{
				{label: "设备", value: device},
				{label: "项目", value: appLabel},
				{label: "时间", value: safeTime(at)},
			}},
			para{kind: pWarn, segs: []seg{
				plain("如果这不是你本人的操作，请"),
				linked("立即修改密码并退出其它设备", securityURL),
				plain("。"),
			}},
			cta{label: "审查登录设备", href: sessionsURL},
			para{kind: pMeta, segs: []seg{
				plain("管理登录提醒设置："),
				linked("前往账号设置", accountURL),
			}},
		},
	}
	htmlBody, text = m.render(b)
	return subject, htmlBody, text
}

// inviteEmail 邀请建号的链接信（B9）：说清「谁邀请你、你被邀请做什么、链接什么时候
// 失效」，单 CTA 设置密码，页脚照常。品牌按邀请 app（调用方 brandFor 传入，无 app =
// 中性 Auth）；URL 由服务端拼好（token 已内嵌），模板不接用户输入的链接——token 是
// 凭证，正文之外不再进任何统计参数（无 UTM、无跟踪域：安全信挂跟踪会被网关预点、
// 烧掉一次性链接）。
//
// 邀请人身份写「一位管理员」而非具体邮箱：邀请行只落 invited_by 的 uid（user_invites
// 表无邀请人邮箱列），邀请信是模板纯函数、不查库；把 uid 解析成邮箱要动 invite.go
// 两条发信路（创建取 actor、重发要回查 invited_by），本次改版不动业务层。
func inviteEmail(b brand, inviteURL, inviter string, expiresAt time.Time) (subject, htmlBody, text string) {
	subject = b.prefix + "邀请你创建账号"
	expireLine := "此链接 24 小时内有效（" + safeTime(expiresAt) + " 前）；链接被使用、撤销或过期后即失效。"
	if inviter == "" {
		inviter = "一位管理员"
	}
	lead := inviter + " 邀请你创建账号。设置密码后即可完成创建并直接登录。"
	m := mailBody{
		scene:     "账号邀请",
		title:     "邀请你创建账号",
		preheader: inviter + " 邀请你创建账号，链接 24 小时内有效。",
		blocks: []block{
			para{segs: []seg{plain(lead)}},
			panel{rows: []row{{value: expireLine}}},
			cta{label: "设置密码并加入", href: inviteURL},
			para{kind: pWarn, segs: []seg{plain("不是你本人知情的操作？忽略这封邮件即可，不会有任何变化。")}},
		},
	}
	htmlBody, text = m.render(b)
	return subject, htmlBody, text
}

// maskEmail 遮掉本地名、保留域名：`u@b.com` → `u***@b.com`。
// 域名留着是因为它本身就是排障线索（拼错域名、企业邮箱拒收都只看域名）。
func maskEmail(email string) string {
	local, domain, ok := strings.Cut(email, "@")
	if !ok || local == "" || domain == "" {
		return "***"
	}
	return string([]rune(local)[:1]) + "***@" + domain
}
