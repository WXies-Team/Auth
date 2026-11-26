package ui

import (
	"bytes"
	"math"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// 所有页面共用 layout 骨架：<head> 必须带三件套 link 与按明暗区分的 theme-color，
// 顶栏品牌区挂 favicon.svg（透明底 + #3482FF 裸蓝素盾 shield，与站点 favicon 同源）。
func TestLayoutHeadHasIconLinks(t *testing.T) {
	raw, err := files.ReadFile("templates/layout.html")
	if err != nil {
		t.Fatalf("读页面骨架: %v", err)
	}
	head := string(raw)
	for _, want := range []string{
		`<link rel="icon" href="/favicon.svg" type="image/svg+xml">`,
		`<link rel="icon" href="/favicon.ico" sizes="48x48">`,
		`<link rel="apple-touch-icon" href="/apple-touch-icon.png">`,
		`<meta name="theme-color" content="#3482FF" media="(prefers-color-scheme: light)">`,
		`<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">`,
		`<img src="/favicon.svg" alt="" width="28" height="28">`,
		`name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"`,
	} {
		if !strings.Contains(head, want) {
			t.Errorf("layout <head> 缺 %s", want)
		}
	}
	// 装饰性图片 alt 必须为空串：紧随其后的品牌名文字才是给读屏的
	if !strings.Contains(head, `class="brand-mark" aria-hidden="true"><img src="/favicon.svg" alt=""`) {
		t.Error("顶栏品牌图标应是 aria-hidden 包裹的空 alt 装饰图")
	}
}

// 静态资产清单三件齐全、可按名取到，且 Content-Type 不缺。
func TestStaticAssetRegistry(t *testing.T) {
	want := []string{"app.css", "app.js", "apple-touch-icon.png", "favicon.ico", "favicon.svg"}
	got := StaticNames()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("静态清单应为 %v（定序），得到 %v", want, got)
	}
	for _, name := range want {
		data, ctype, ok := Static(name)
		if !ok {
			t.Errorf("Static(%q) 未命中", name)
			continue
		}
		if len(data) == 0 || ctype == "" {
			t.Errorf("Static(%q) 内容或类型为空", name)
		}
	}
	if _, _, ok := Static("nope.png"); ok {
		t.Error("名单外的静态名不该命中")
	}
}

// 页面模板一个不缺：路由层登记了 12 个页面，模板缺一个就启动即炸（ui.go 的
// Has 会被 cmd/server 逐个查），这里在包内先钉住数量与关键页。
func TestPageTemplatesPresent(t *testing.T) {
	for _, name := range []string{"login", "console", "admin-access", "admin-config", "admin-ai"} {
		if !Has(name) {
			t.Errorf("页面模板缺失: %s", name)
		}
	}
	if Has("not-a-page") {
		t.Error("未知页名不该命中")
	}
}

// cssRule 取一条以行首选择器开头的规则体（含大括号）。要求行首是为了不被
// `.btn .ico` 这类更长的选择器抢匹配。
// mustCSS 读出 style.css 全文（失败即 Fatal）。
func mustCSS(t *testing.T) string {
	t.Helper()
	b, err := files.ReadFile("style.css")
	if err != nil {
		t.Fatalf("读 style.css: %v", err)
	}
	return string(b)
}

func mustJS(t *testing.T) string {
	t.Helper()
	b, err := files.ReadFile("app.js")
	if err != nil {
		t.Fatalf("读 app.js: %v", err)
	}
	return string(b)
}

// jsBlock 截 app.js 的 [start,end) 一段。机制断言要看「某个函数体内真的这么
// 做」，全文 Contains 会把别处的同名字符串误算成命中。
func jsBlock(t *testing.T, js, start, end string) string {
	t.Helper()
	i := strings.Index(js, start)
	if i < 0 {
		t.Fatalf("app.js 缺起点 %q", start)
	}
	j := strings.Index(js[i:], end)
	if j < 0 {
		t.Fatalf("app.js 缺终点 %q", end)
	}
	return js[i : i+j]
}

// jsBlockAfter 从 anchor 之后再找起点：app.js 里 openDetail/load 各有多处同名
// 实现，直接用 jsBlock 会把用户页的块错当成会话页的块。
func jsBlockAfter(t *testing.T, js, anchor, start, end string) string {
	t.Helper()
	k := strings.Index(js, anchor)
	if k < 0 {
		t.Fatalf("app.js 缺锚点 %q", anchor)
	}
	i := strings.Index(js[k+len(anchor):], start)
	if i < 0 {
		t.Fatalf("app.js 锚点 %q 后缺起点 %q", anchor, start)
	}
	i += k + len(anchor)
	j := strings.Index(js[i:], end)
	if j < 0 {
		t.Fatalf("app.js 缺终点 %q", end)
	}
	return js[i : i+j]
}

// stripCSSComments 去掉 /* ... */，让「规则里有什么声明」的断言只看真声明。
func stripCSSComments(css string) string {
	var b strings.Builder
	for {
		i := strings.Index(css, "/*")
		if i < 0 {
			b.WriteString(css)
			return b.String()
		}
		b.WriteString(css[:i])
		j := strings.Index(css[i:], "*/")
		if j < 0 {
			return b.String()
		}
		css = css[i+j+2:]
	}
}

func cssRule(css, selector string) (string, bool) {
	i := strings.Index(css, "\n"+selector+" ")
	if i < 0 {
		return "", false
	}
	open := strings.Index(css[i:], "{")
	if open < 0 {
		return "", false
	}
	start := i + open
	end := strings.Index(css[start:], "}")
	if end < 0 {
		return "", false
	}
	return css[start : start+end], true
}

// 骨架与响应头：窄屏可用（viewport-fit=cover）+ safe-area 内边距在 CSS 里有落地。
func TestNarrowScreenShellReady(t *testing.T) {
	raw, err := files.ReadFile("templates/layout.html")
	if err != nil {
		t.Fatalf("读页面骨架: %v", err)
	}
	if !strings.Contains(string(raw), "viewport-fit=cover") {
		t.Error("layout 缺 viewport-fit=cover（刘海屏 safe-area 前提）")
	}
	cssBytes, err := files.ReadFile("style.css")
	if err != nil {
		t.Fatalf("读 style.css: %v", err)
	}
	css := string(cssBytes)
	if !strings.Contains(css, "env(safe-area-inset-") {
		t.Error("style.css 缺 safe-area 内边距")
	}
	if !strings.Contains(css, "@media (min-width: 900px)") {
		t.Error("style.css 缺 900px 断点（侧栏导航的切换点）")
	}
	// 表格类页面（会话/审计/用户）窄屏靠 .table-wrap 横滚，不破版
	if !strings.Contains(css, ".table-wrap") || !strings.Contains(css, "overflow-x: auto") {
		t.Error("表格容器应是 overflow-x:auto 的横滚盒")
	}
}

// 设备页：本设备会话行不可退出——退出按钮只在 it.current 为假时渲染（JS 源码级
// 钉住，无 DOM 的单测拿不到渲染结果；服务端语义另由 TestSessionLifecycle 钉 current 标记）。
// 列表口径是**扁平**：一行=一条会话，行主标题=设备名（同名设备并排，不做归并），
// 分组渲染与组级批量退出已删干净。
func TestSessionsPageCurrentRowNeverKickable(t *testing.T) {
	jsBytes, err := files.ReadFile("app.js")
	if err != nil {
		t.Fatalf("读 app.js: %v", err)
	}
	js := string(jsBytes)
	if !strings.Contains(js, "${it.current ? '' : '<button type=\"button\" class=\"btn small danger\">退出</button>'}") {
		t.Error("本设备会话行不该渲染退出按钮（it.current 分支应为空串）")
	}
	if !strings.Contains(js, "'<span class=\"badge on\">本设备</span>'") {
		t.Error("本设备会话行应带「本设备」徽标")
	}
	// 会话 id 一律按字符串处理（雪花 id 的 JS 精度陷阱）：列表请求的回执是
	// {sessions:[...]}；行结构 = 设备名主标题 + 「项目名 · 最近活跃 · IP · 首次登录」
	// 常驻副行（2026-10 拍板去展开，与两个日记 App 同口径：区分同名设备的两条
	// 线索不再藏在「详情」里）
	if !strings.Contains(js, "res.sessions || []") {
		t.Error("会话列表应从 {sessions:[...]} 回执取数组")
	}
	if strings.Contains(js, "sessTag") {
		t.Error("session 尾号短标识已退役，app.js 不该再出现 sessTag")
	}
	for _, want := range []string{
		`<span class="title">${esc(it.device)}</span>`,
		`· 最近活跃 ${esc(relTime(it.lastSeenAt))}`,
		`IP ${ipWithRegion(it.ip, it.ipRegion)}`,
		`首次登录 ${esc(it.createdAt > 0 ? fmtTime(it.createdAt) : '—')}`,
	} {
		if !strings.Contains(js, want) {
			t.Errorf("会话行应包含 %s（设备名主标题 + 常驻副行含 IP 与首次登录）", want)
		}
	}
	for _, gone := range []string{`data-act="more"`, "sess-more"} {
		if strings.Contains(js, gone) {
			t.Errorf("会话行已扁平化，app.js 不该再出现 %q", gone)
		}
	}
	// 页首 hint 钉住「最近活跃」口径（用户问得最多的一句）
	page, err := files.ReadFile("templates/sessions.html")
	if err != nil {
		t.Fatalf("读 sessions.html: %v", err)
	}
	pageStr := string(page)
	if !strings.Contains(pageStr, "最近活跃指该设备最后与服务器通信的时间。") {
		t.Error("sessions.html 页首应有「最近活跃」口径说明")
	}
	// 分组定案已否（同名不同设备被归并=歧义）：分组渲染、组级踢按钮、
	// revoke-many 的组级调用一个字节不留，模板说明也不许再提「分组」
	for _, gone := range []string{"device-group", "group-kick", "/api/sessions/revoke-many"} {
		if strings.Contains(js, gone) {
			t.Errorf("会话页已扁平化，app.js 不该再出现 %q", gone)
		}
	}
	if strings.Contains(pageStr, "分组") {
		t.Error("sessions.html 不该再有「按设备分组」的说明（列表已扁平化）")
	}
}

// 发码提示要给可执行的下一步：在垃圾箱里按发件人搜索，并说清 60 秒后可重发。
// 旧文案「没收到可查看垃圾箱」太模糊，用户不知道搜什么，已退役。
func TestSendCodeToastHasActionableNextStep(t *testing.T) {
	jsBytes, err := files.ReadFile("app.js")
	if err != nil {
		t.Fatalf("读 app.js: %v", err)
	}
	js := string(jsBytes)
	if !strings.Contains(js, "在垃圾箱里搜索发件人『Auth』，60 秒后可重新发送") {
		t.Error("发码 toast 应告诉用户在垃圾箱搜哪个发件人，以及何时能重发")
	}
	if strings.Contains(js, "没收到可查看垃圾箱") {
		t.Error("旧的无下一步发码文案不该残留")
	}
}

// UA Client Hints 的 opt-in：Render 是全部页面（登录页/授权页/邀请页/控制台页）
// 的响应头收口，浏览器见到 Accept-CH 后才会在本站后续请求带上高熵的
// Sec-CH-UA-Model（机型），登录建会话时并进设备名（internal/auth 的 uaWithCH）。
func TestRenderOptsIntoClientHints(t *testing.T) {
	rec := httptest.NewRecorder()
	if err := Render(rec, "login", Data{Title: "登录", Minimal: true}); err != nil {
		t.Fatalf("渲染登录页: %v", err)
	}
	if got := rec.Header().Get("Accept-CH"); got != "Sec-CH-UA-Platform, Sec-CH-UA-Model" {
		t.Errorf("登录页响应应带 Accept-CH: Sec-CH-UA-Platform, Sec-CH-UA-Model，得到 %q", got)
	}
	// 控制台页同一收口（不只登录页，所有经 Render 的页面都带）
	rec2 := httptest.NewRecorder()
	if err := Render(rec2, "console", Data{Title: "概览", Email: "u@example.com"}); err != nil {
		t.Fatalf("渲染概览页: %v", err)
	}
	if got := rec2.Header().Get("Accept-CH"); got != "Sec-CH-UA-Platform, Sec-CH-UA-Model" {
		t.Errorf("概览页响应也应带 Accept-CH，得到 %q", got)
	}
}

// 顶栏账号胶囊与管理后台入口都在 layout 里，且管理入口由 .IsAdmin 门控
// （role 判定发生在 cmd/server 的 pageHandler，非管理员的 HTML 里没有这个按钮）。
// 进入后台后入口变「返回控制台」（.InAdmin 门控）。
// 配置中心要求接口地址填完整端点：只写 /v1 会被前端当场拦下，避免后端再拼
// /chat/completions；提示文案与校验正则都要在 initAdminConfig 里。
func TestAdminConfigRequiresFullEndpoint(t *testing.T) {
	block := jsBlock(t, mustJS(t), "function initAdminConfig() {", "\n/* ---------- 后台：AI 用量")
	for _, want := range []string{
		"必须填写完整接口地址（含 /chat/completions",
		`/^https?:\/\/.+\/chat\/completions\/?$/`,
	} {
		if !strings.Contains(block, want) {
			t.Errorf("配置中心缺完整接口地址校验/提示：%s", want)
		}
	}
}

// 登录/授权 Minimal 壳必须在内容区居中（grid 子项只靠 auto margin 在部分路径会贴左）。
func TestAuthShellCentered(t *testing.T) {
	rule, ok := cssRule(stripCSSComments(mustCSS(t)), ".auth-shell")
	if !ok {
		t.Fatal("style.css 缺 .auth-shell")
	}
	for _, want := range []string{"justify-self: center;", "max-width: 440px;"} {
		if !strings.Contains(rule, want) {
			t.Errorf(".auth-shell 缺居中约束 %q", want)
		}
	}
}

// 条件式 Passkey 请求与「使用 Passkey 登录」按钮不能并发：点击前必须先 abort
// 并等待条件式请求结束，否则浏览器报 "A request is already pending"。
func TestPasskeyModalAbortsConditionalRequest(t *testing.T) {
	block := jsBlock(t, mustJS(t), "function initLogin() {", "\n/* ---------- WebAuthn：")
	for _, want := range []string{
		"mediation: 'conditional'",
		"let condStopped = false;",
		"condStopped = true;",
		"await stopConditional();",
	} {
		if !strings.Contains(block, want) {
			t.Errorf("Passkey 登录缺条件式请求收口 %q", want)
		}
	}
}

// 卡内列表按 Miuix 分组：16dp 卡片内边距 + 行间分隔线，不把每行做成独立小卡片。
func TestCardGroupedListGeometry(t *testing.T) {
	css := mustCSS(t)
	for _, want := range []string{
		"padding: var(--sp-4);",
		".card > .list {",
		"margin-inline: calc(var(--sp-4) * -1);",
		".card > .list > .item + .item { border-top: 1px solid var(--line); }",
	} {
		if !strings.Contains(css, want) {
			t.Errorf("卡内分组几何缺 %q", want)
		}
	}
}

// 触屏按压/焦点不能画出不跟随圆角的整块方框：关掉浏览器 tap highlight，
// hover 样式只在有 hover 的设备生效，焦点环只画在真正的交互控件上。
func TestTouchFeedbackAndScopedFocusRing(t *testing.T) {
	css := mustCSS(t)
	for _, want := range []string{
		"-webkit-tap-highlight-color: transparent;",
		"touch-action: manipulation;",
		"@media (hover: none)",
		".nav-item:hover { background: transparent; color: var(--dim); }",
		`where(a, button, input, select, textarea, summary, [role="button"], [tabindex]):focus-visible`,
	} {
		if !strings.Contains(css, want) {
			t.Errorf("触屏/焦点样式缺 %q", want)
		}
	}
}

// 会话总览的搜索卡与用户表之间必须有显式间距：#sess-users-view 是块容器，
// .content 的 grid gap 不作用于它内部，靠 toolbar 自己的下边距隔开（2026-10-22 实报回归）。
func TestSessionsSearchToolbarSpacing(t *testing.T) {
	if !strings.Contains(mustCSS(t), "#sess-users-view > .toolbar { margin-bottom: var(--gap); }") {
		t.Error("会话总览搜索卡缺下边距，会与下方用户表黏连")
	}
}

// 宽屏 rail 必须跟随动态视口高度：100vh 在横屏平板/移动浏览器上高于可视区，
// 会把 rail 底部的管理入口与头像推到屏幕底部之外；中间导航单独滚动。
func TestRailFitsDynamicViewport(t *testing.T) {
	css := mustCSS(t)
	for _, want := range []string{
		"height: 100dvh;",
		"max-height: 100dvh;",
		"overflow: hidden;",
		".rail-nav {",
		"flex: 1 1 auto; min-height: 0;",
	} {
		if !strings.Contains(css, want) {
			t.Errorf("rail 缺动态视口/滚动约束：%s", want)
		}
	}
}

func TestTopbarAccountAndAdminEntry(t *testing.T) {
	raw, err := files.ReadFile("templates/layout.html")
	if err != nil {
		t.Fatalf("读页面骨架: %v", err)
	}
	head := string(raw)
	for _, want := range []string{
		`{{if .IsAdmin}}<a class="btn small admin-entry" href="{{if .InAdmin}}/web/console{{else if .IsSuper}}/web/admin{{else}}/web/admin/sessions{{end}}" id="admin-entry">`,
		`{{if .InAdmin}}返回控制台{{else}}管理后台{{end}}`,
		// ≥900px 顶栏被 CSS 隐藏，管理入口与账号胶囊必须在 rail 底部另出一份，
		// 否则桌面端只剩导航项、没有进入管理后台的按钮。
		`<div class="rail-foot">`,
		`<div class="rail-nav">{{template "nav-items" .Nav}}</div>`,
		`id="rail-admin-entry"`,
		// B5：顶栏账号胶囊升级为头像（图/色块+首字）+ 昵称（回退邮箱前缀，完整邮箱在 title）
		`id="topbar-email" title="{{.Email}}"`,
		`id="me-avatar"`,
		`{{if .AvatarSrc}}<img src="{{.AvatarSrc}}" alt="">{{else}}{{.Initial}}{{end}}`,
		`{{.AcctName}}`,
	} {
		if !strings.Contains(head, want) {
			t.Errorf("layout 顶栏缺 %s", want)
		}
	}
	// 登录页（Minimal）没有顶栏：管理入口与账号胶囊都包在 not Minimal 里
	if !strings.Contains(head, "{{if not .Minimal}}\n<!-- 顶栏常驻") {
		t.Error("顶栏应整体由 not Minimal 门控（登录页无顶栏）")
	}
	// 渲染级钉子：管理员的概览页在窄屏顶栏和宽屏 rail 各有一个入口；
	// 普通用户的 HTML 里两个都没有（按钮由服务端 role 门控，不是前端隐藏）。
	adminRec := httptest.NewRecorder()
	if err := Render(adminRec, "console", Data{
		Title: "概览", Email: "admin@example.com", IsAdmin: true, IsSuper: true,
	}); err != nil {
		t.Fatalf("渲染管理员概览页: %v", err)
	}
	adminHTML := adminRec.Body.String()
	for _, id := range []string{`id="admin-entry"`, `id="rail-admin-entry"`, `class="rail-foot"`} {
		if !strings.Contains(adminHTML, id) {
			t.Errorf("管理员概览页缺 %s（宽屏顶栏被隐藏时必须由 rail 兜底）", id)
		}
	}
	userRec := httptest.NewRecorder()
	if err := Render(userRec, "console", Data{Title: "概览", Email: "user@example.com"}); err != nil {
		t.Fatalf("渲染普通用户概览页: %v", err)
	}
	for _, id := range []string{`id="admin-entry"`, `id="rail-admin-entry"`} {
		if strings.Contains(userRec.Body.String(), id) {
			t.Errorf("普通用户 HTML 不该有 %s", id)
		}
	}
	// 全站零页脚（2026-10 定案）：页脚只承载固定说明，属于各页上下文而非全站导航，
	// miuix 的 Scaffold 也从不渲染页脚。layout 里**连容器都不许出现**。
	if strings.Contains(head, "<footer") || strings.Contains(head, `class="foot"`) {
		t.Error("layout 不该再有 <footer>/`.foot`——全站已删页脚")
	}
	// 服务端应用注册表 JSON 注入点存在
	if !strings.Contains(head, `<script type="application/json" id="known-apps">{{.AppsJSON}}</script>`) {
		t.Error("layout 应注入 known-apps 应用注册表 JSON")
	}
	if got := initialOf("someone@example.com"); got != "S" {
		t.Errorf("账号胶囊首字母应取邮箱首字符大写，得到 %q", got)
	}
	if !IsAdminRole("admin") || !IsAdminRole("super") || IsAdminRole("user") || IsAdminRole("") {
		t.Error("IsAdminRole 认 admin 与 super 两档")
	}
	if !IsSuperRole("super") || IsSuperRole("admin") {
		t.Error("IsSuperRole 只认 super")
	}
}

// W2 项目切换器与角色页：切换器 markup 在 layout、SwitchApps 按角色分叉、
// 403 页模板齐备、导航按 super 分叉（角色管理已并入用户页；W4 加「项目访问」，
// super 六项 / app-admin 四项）。
func TestAppSwitchAndRolesPage(t *testing.T) {
	// 1. layout 带切换器容器；重写后切换器从顶栏移进**内容区**（筛选贴着它过滤
	// 的数据，也不再跟顶栏抢窄屏空间）：admin-entry（顶栏）与 acct（顶栏）在前，
	// app-switch 必须出现在 </header> 之后的 main 内。
	raw, err := files.ReadFile("templates/layout.html")
	if err != nil {
		t.Fatalf("读 layout: %v", err)
	}
	head := string(raw)
	sw := strings.Index(head, `id="app-switch"`)
	ae := strings.Index(head, `id="admin-entry"`)
	ac := strings.Index(head, `class="acct"`)
	headerEnd := strings.Index(head, "</header>")
	if sw < 0 {
		t.Fatal("layout 缺项目切换器容器 id=app-switch")
	}
	if ae < 0 || ac < 0 || headerEnd < 0 {
		t.Fatalf("layout 缺顶栏结构 ae=%d ac=%d headerEnd=%d", ae, ac, headerEnd)
	}
	if !(ae < ac && ac < headerEnd && headerEnd < sw) {
		t.Errorf("切换器应整体在 </header> 之后的 main 内（ae<ac<headerEnd<sw），得到 ae=%d ac=%d headerEnd=%d sw=%d",
			ae, ac, headerEnd, sw)
	}

	// 2. SwitchApps：super = 「全部」+ knownApps 全量（当前 4 个，高亮「全部」）；app-admin 只回授权项
	super := SwitchApps(true, nil, "")
	if len(super) != 5 || super[0].Key != "" || super[0].Label != "全部" || !super[0].Active {
		t.Errorf("super 切换器应为「全部」+4 个项目且「全部」默认高亮，得到 %+v", super)
	}
	if super[3].Label != "奇奇岛护照" || super[4].Label != "屑涵短链" {
		t.Errorf("切换器应带上两个外部项目，得到 %+v", super)
	}
	superCal := SwitchApps(true, nil, "CalorieDiary")
	if superCal[0].Active || !superCal[1].Active {
		t.Errorf("?app=calorie 时应高亮该项，得到 %+v", superCal)
	}
	one := SwitchApps(false, []string{"CalorieDiary"}, "")
	if len(one) != 1 || one[0].Key != "CalorieDiary" {
		t.Errorf("app-admin 切换器只该有授权项，得到 %+v", one)
	}
	for _, c := range one {
		if c.Label == "全部" {
			t.Error("app-admin 的切换器不该有「全部」")
		}
	}

	// 3. 角色管理模板已删（并入用户页），403 页仍在
	if Has("admin-roles") {
		t.Error("admin-roles 模板应已删除（角色管理并入用户页）")
	}
	if !Has("denied") {
		t.Error("页面模板缺失: denied")
	}

	// 4. AdminNav 按角色分叉：super 六项（用户/项目访问/会话/审计/配置/AI），
	// app-admin 四项（项目访问/会话/审计/AI）；项目访问页两级都开
	//（super 见全部项目、app-admin 只见授权项目，数据在服务端裁）
	navS := AdminNav("", true)
	navA := AdminNav("", false)
	if len(navS) != 6 {
		t.Errorf("super 导航应六项，得到 %d", len(navS))
	}
	if len(navA) != 4 {
		t.Errorf("app-admin 导航应四项，得到 %d", len(navA))
	}
	for _, list := range [][]NavItem{navS, navA} {
		n := 0
		for _, it := range list {
			if it.Href == "/web/admin/access" {
				n++
			}
		}
		if n != 1 {
			t.Errorf("导航应恰有一项「项目访问」入口，得到 %d", n)
		}
	}
	for _, it := range navA {
		if it.Href == "/web/admin" || it.Href == "/web/admin/config" || it.Href == "/web/admin/roles" {
			t.Errorf("app-admin 导航不该有平台级入口 %q", it.Href)
		}
	}
	// super 导航不该再有独立的角色页入口
	for _, it := range navS {
		if it.Href == "/web/admin/roles" {
			t.Error("角色管理已并入用户页，super 导航不该再有 /web/admin/roles")
		}
	}

	// 5. 切换器样式只用 transition（动效令牌），不新增 keyframe 绕过门禁
	cssBytes, err := files.ReadFile("style.css")
	if err != nil {
		t.Fatalf("读 style.css: %v", err)
	}
	cssRuleStr, ok := cssRule(string(cssBytes), ".app-switch")
	if !ok {
		t.Fatal("style.css 缺 .app-switch 规则")
	}
	for _, frag := range []string{"--card", "--radius-ctl"} {
		if !strings.Contains(cssRuleStr, frag) {
			t.Errorf(".app-switch 缺令牌 %q", frag)
		}
	}
	chipRule, ok := cssRule(string(cssBytes), ".app-chip")
	if !ok {
		t.Fatal("style.css 缺 .app-chip 规则")
	}
	if !strings.Contains(chipRule, "var(--dur-1) var(--ease)") {
		t.Error(".app-chip 的动效应沿用 --dur-1/--ease 令牌")
	}
}

// 危险操作区（注销账号）独立红区：模板用 danger-zone，CSS 有 error 描边 + 淡底。
func TestDangerZoneIsolatedFromSettings(t *testing.T) {
	raw, err := files.ReadFile("templates/account.html")
	if err != nil {
		t.Fatalf("读账号页: %v", err)
	}
	if !strings.Contains(string(raw), `class="danger-zone"`) {
		t.Error("注销账号区应用 danger-zone 独立红区")
	}
	cssBytes, _ := files.ReadFile("style.css")
	css := string(cssBytes)
	rule, ok := cssRule(css, ".danger-zone")
	if !ok {
		t.Fatal("style.css 缺 .danger-zone 规则")
	}
	for _, frag := range []string{"var(--danger)", "var(--danger-bg)"} {
		if !strings.Contains(rule, frag) {
			t.Errorf(".danger-zone 缺 %s（error 描边/淡底）", frag)
		}
	}
}

// 403 页要给**可实际使用的求助路径**（NIST 的 redress 要求：容易被找到）与一个
// 报障时间戳，而不是「请联系管理员」这种找不到人的空话。
func TestDeniedPageRedressAndTimestamp(t *testing.T) {
	raw, err := files.ReadFile("templates/denied.html")
	if err != nil {
		t.Fatalf("读 denied 模板: %v", err)
	}
	tpl := string(raw)
	for _, want := range []string{"support@horatio.cn", "开通邀请邮件", `id="denied-at"`} {
		if !strings.Contains(tpl, want) {
			t.Errorf("403 页缺求助/报障要素 %q", want)
		}
	}
	// 渲染后仍带两条出路
	rec := httptest.NewRecorder()
	if err := Render(rec, "denied", Data{Title: "无权访问", Minimal: true, DeniedApp: "ExpenseDiary"}); err != nil {
		t.Fatalf("渲染 403 页: %v", err)
	}
	body := rec.Body.String()
	for _, want := range []string{"/web/admin/sessions", "/web/console", "denied-at"} {
		if !strings.Contains(body, want) {
			t.Errorf("403 页渲染缺 %q", want)
		}
	}
	// 空 reason 的旧形态兜底：策略拒绝仍标「当前」
	if !strings.Contains(body, "策略拒绝 · 当前") {
		t.Error("403 页未给 reason 时应按策略拒绝的旧形态兜底")
	}
	// 带 reason=permission 时：高亮权限不足一级并展示原始 reason
	rec = httptest.NewRecorder()
	if err := Render(rec, "denied", Data{Title: "无权访问", Minimal: true,
		DeniedApp: "EPassportForMikey", DeniedReason: "permission"}); err != nil {
		t.Fatalf("渲染带 reason 的 403 页: %v", err)
	}
	body = rec.Body.String()
	for _, want := range []string{`id="denied-reason"`, `>permission<`, "权限不足 · 当前",
		`<li class="denied-tier on">`} {
		if !strings.Contains(body, want) {
			t.Errorf("403 页（reason=permission）缺 %q", want)
		}
	}
	if strings.Contains(body, "策略拒绝 · 当前") {
		t.Error("reason=permission 时不该再把策略拒绝标成当前")
	}
}

// 授权页（B4 authorize 模板）：确认态带项目名/回跳域名/继续取消双钮（同表单
// decision 分流），错误态是同卡片语言的变体；两态都走 Minimal 壳。
func TestAuthorizeTemplateRendersBothVariants(t *testing.T) {
	if !Has("authorize") {
		t.Fatal("页面模板缺失: authorize")
	}
	raw, err := files.ReadFile("templates/authorize.html")
	if err != nil {
		t.Fatalf("读授权页模板: %v", err)
	}
	tpl := string(raw)
	for _, want := range []string{
		`method="post" action="/oauth/authorize/confirm"`,
		`name="decision" value="allow"`, `name="decision" value="deny"`,
		`name="tx" value=`, `.AppName`, `.RedirectHost`, `.Email`,
		`.ErrorTitle`, `.ErrorMessage`,
		`登录到「`, `它将获得：`, `range .Scopes`, `拒绝并返回`,
	} {
		if !strings.Contains(tpl, want) {
			t.Errorf("授权页模板缺 %q", want)
		}
	}
	// 确认态渲染：项目名、回跳域名、账号邮箱都出现在 HTML 里
	rec := httptest.NewRecorder()
	data := Data{Title: "授权登录", Minimal: true, OAuth: &OAuthView{
		Tx: "tx-1", App: "CalorieDiary", AppName: "热量日记",
		RedirectHost: "app.example.com", Email: "u@example.com",
		Scopes: []string{"你的账号标识（uid）", "你的邮箱地址"},
	}}
	if err := Render(rec, "authorize", data); err != nil {
		t.Fatalf("渲染确认页: %v", err)
	}
	body := rec.Body.String()
	for _, want := range []string{"热量日记", "app.example.com", "u@example.com", "tx-1", "继续", "拒绝并返回"} {
		if !strings.Contains(body, want) {
			t.Errorf("确认页 HTML 缺 %q", want)
		}
	}
	if rec.Code != http.StatusOK {
		t.Errorf("默认应 200，得到 %d", rec.Code)
	}
	// 错误态渲染：带状态码起头 + 标题与文案
	recErr := httptest.NewRecorder()
	if err := Render(recErr, "authorize", Data{
		Title: "无法发起授权", Minimal: true, Status: http.StatusBadRequest,
		OAuth: &OAuthView{ErrorTitle: "无法发起授权", ErrorMessage: "应用未登记，请联系应用管理员在控制台开通后再试"},
	}); err != nil {
		t.Fatalf("渲染错误页: %v", err)
	}
	if recErr.Code != http.StatusBadRequest {
		t.Errorf("错误页应以 400 起头，得到 %d", recErr.Code)
	}
	for _, want := range []string{"无法发起授权", "应用未登记"} {
		if !strings.Contains(recErr.Body.String(), want) {
			t.Errorf("错误页 HTML 缺 %q", want)
		}
	}
}

// 接受邀请页（B9 invite 模板）：与 authorize 同款「同模板双变体」——确认态渲染
// 表单（邮箱只读 + new-password/username/nickname autocomplete + 隐藏 token，零 JS），
// 错误态整卡替换并以 400 起头；AppLabel 与页面里的项目名同源。
func TestInviteTemplateRendersBothVariants(t *testing.T) {
	if !Has("invite") {
		t.Fatal("页面模板缺失: invite")
	}
	raw, err := files.ReadFile("templates/invite.html")
	if err != nil {
		t.Fatalf("读邀请页模板: %v", err)
	}
	tpl := string(raw)
	for _, want := range []string{
		`method="post" action="/web/invite"`,
		`name="token" value=`, `name="password"`, `name="nickname"`,
		`autocomplete="new-password"`, `autocomplete="username"`, `autocomplete="nickname"`,
		`readonly`, `minlength="8"`,
		`.ErrorTitle`, `.ErrorMessage`, `.Error`, `.Email`, `.AppName`,
	} {
		if !strings.Contains(tpl, want) {
			t.Errorf("邀请页模板缺 %q", want)
		}
	}

	// 表单变体：邮箱、项目名、隐藏 token 都进 HTML（200）
	rec := httptest.NewRecorder()
	if err := Render(rec, "invite", Data{
		Title: "接受邀请", Minimal: true,
		Invite: &InviteView{Token: "tok-123", Email: "invitee@example.com",
			App: "CalorieDiary", AppName: AppLabel("CalorieDiary")},
	}); err != nil {
		t.Fatalf("渲染表单变体: %v", err)
	}
	body := rec.Body.String()
	for _, want := range []string{"invitee@example.com", "tok-123", "热量日记", "设置密码并完成注册"} {
		if !strings.Contains(body, want) {
			t.Errorf("表单变体 HTML 缺 %q", want)
		}
	}
	if rec.Code != http.StatusOK {
		t.Errorf("默认应 200，得到 %d", rec.Code)
	}

	// 错误变体：400 起头 + 标题文案，且不再渲染提交表单
	recErr := httptest.NewRecorder()
	if err := Render(recErr, "invite", Data{
		Title: "无法接受邀请", Minimal: true, Status: http.StatusBadRequest,
		Invite: &InviteView{ErrorTitle: "无法接受邀请", ErrorMessage: "邀请链接已过期（24 小时内有效），请联系邀请人重新发送"},
	}); err != nil {
		t.Fatalf("渲染错误变体: %v", err)
	}
	if recErr.Code != http.StatusBadRequest {
		t.Errorf("错误变体应以 400 起头，得到 %d", recErr.Code)
	}
	errBody := recErr.Body.String()
	for _, want := range []string{"无法接受邀请", "已过期", "前往登录"} {
		if !strings.Contains(errBody, want) {
			t.Errorf("错误变体 HTML 缺 %q", want)
		}
	}
	if strings.Contains(errBody, `action="/web/invite"`) {
		t.Error("错误变体不该渲染提交表单")
	}

	// 提交被打回：表单 + 字段下就地报错（不是整卡错误变体）
	recForm := httptest.NewRecorder()
	if err := Render(recForm, "invite", Data{
		Title: "接受邀请", Minimal: true, Status: http.StatusBadRequest,
		Invite: &InviteView{Token: "tok-1", Email: "a@example.com", Error: "密码至少 8 位"},
	}); err != nil {
		t.Fatalf("渲染就地报错: %v", err)
	}
	if !strings.Contains(recForm.Body.String(), "密码至少 8 位") ||
		!strings.Contains(recForm.Body.String(), `action="/web/invite"`) {
		t.Error("业务打回应重渲染表单并在字段下方报错")
	}

	// AppLabel：注册表内回展示名，未知 slug 回原串，空串回空
	if AppLabel("CalorieDiary") != "热量日记" || AppLabel("ExpenseDiary") != "开支日记" {
		t.Errorf("AppLabel 应回注册表展示名，得到 %q / %q", AppLabel("CalorieDiary"), AppLabel("ExpenseDiary"))
	}
	if AppLabel("nope") != "nope" || AppLabel("") != "" {
		t.Errorf("未知/空 slug 应回原样，得到 %q / %q", AppLabel("nope"), AppLabel(""))
	}
}

// 零外链：内联脚本里不许出现任何 http(s):// 引用（favicon/二维码都是同源或运行时注入）。
func TestNoExternalResources(t *testing.T) {
	for _, name := range []string{"app.js", "style.css"} {
		b, err := files.ReadFile(name)
		if err != nil {
			t.Fatalf("读 %s: %v", name, err)
		}
		if strings.Contains(string(b), "http://") || strings.Contains(string(b), "https://") {
			t.Errorf("%s 出现外链引用（零外部依赖规矩）", name)
		}
	}
}

// 动效系统（miuix「丝滑统一」）：常规 easing + 时长梯度令牌、弹簧只给物理反馈、
// 入场/弹入/转圈关键帧、reduced-motion 一刀切（动画与过渡都关，且清零 animation-delay）。
func TestMotionSystem(t *testing.T) {
	cssBytes, err := files.ReadFile("style.css")
	if err != nil {
		t.Fatalf("读 style.css: %v", err)
	}
	css := string(cssBytes)

	// 1. 统一 easing 与时长令牌在 :root 里
	rule, ok := cssRule(css, ":root")
	if !ok {
		t.Fatal("style.css 缺 :root 规则")
	}
	for _, frag := range []string{"--ease: cubic-bezier(.16, 1, .3, 1)", "--dur-1", "--dur-2", "--dur-3"} {
		if !strings.Contains(rule, frag) {
			t.Errorf(":root 缺动效令牌 %q（全站唯一 easing/时长梯度）", frag)
		}
	}

	// 2. 关键帧齐备：入场（12px/4px 两档）、淡入、对话框弹入、转圈、徽标浮现
	for _, kf := range []string{
		"@keyframes rise-in", "@keyframes rise-in-sm", "@keyframes fade-in",
		"@keyframes dlg-in", "@keyframes spin", "@keyframes pop-in",
	} {
		if !strings.Contains(css, kf) {
			t.Errorf("style.css 缺 %s", kf)
		}
	}

	// 3. 只动 transform/opacity：关键帧体内不得出现 width/height/margin/top/left 这类 layout 属性
	for _, banned := range []string{
		"height:", "width:", "margin-", "top:", "left:", "padding:",
	} {
		for _, block := range keyframeBodies(css) {
			if strings.Contains(block, banned) {
				t.Errorf("关键帧里出现 layout 属性 %q（只许 transform/opacity，防抖动）：%s", banned, block)
				break
			}
		}
	}

	// 4. 入场错峰与浮层豁免
	for _, want := range []string{
		".content > *:nth-child(3) { animation-delay: 210ms; }",
		".content > #toast, .content > dialog { animation: none; }",
		"tbody tr:nth-child(-n+10)",
		".leaving",
		".dlg[open]",
		".btn[aria-busy=true]::after",
	} {
		if !strings.Contains(css, want) {
			t.Errorf("style.css 缺动效结构 %q", want)
		}
	}

	// 5. reduced-motion 分级降级（依据 Chrome Modern Web Guidance · Motion：
	//    不全局掐 transition-duration——只处理空间运动，保留颜色过渡与必要进度）
	rms := reducedMotionBlock(css)
	if rms == "" {
		t.Fatal("style.css 缺 prefers-reduced-motion 媒体查询")
	}
	for _, frag := range []string{
		"animation-duration: 0.001ms !important",
		"animation-delay: 0ms !important",
		".btn:active, .tab:active, .app-chip:active, .select-btn:active",
		"input[type=checkbox]:active, input[type=radio]:active { transform: none; }",
		// 必要反馈不冻结：加载转圈在 reduce 下放慢而不是停
		"animation-iteration-count: infinite !important",
	} {
		if !strings.Contains(rms, frag) {
			t.Errorf("reduced-motion 块缺 %q", frag)
		}
	}
	// 全局掐 transition-duration 的旧配方不许回潮（Chrome 官方建议的反例）
	if strings.Contains(rms, "transition-duration: 0.001ms") {
		t.Error("reduced-motion 不应全局掐 transition-duration（颜色过渡会被闪断，见 Chrome Motion 指南）")
	}

	// 6. JS 侧同一套 easing，且动画入口都尊重用户设置
	jsBytes, err := files.ReadFile("app.js")
	if err != nil {
		t.Fatalf("读 app.js: %v", err)
	}
	js := string(jsBytes)
	for _, want := range []string{
		"cubic-bezier(.16, 1, .3, 1)",
		"(prefers-reduced-motion: reduce)",
		"function swapIn(el)",
		"function popIn(el)",
		"function fadeOutRow(el, done)",
		"function flowSwap(", // 流程步连续过渡（登录↔两步验证↔强制改密不瞬变）
	} {
		if !strings.Contains(js, want) {
			t.Errorf("app.js 缺动效设施 %q", want)
		}
	}
}

// keyframeBodies 抽出每个 @keyframes 的规则体（粗粒度：只要大括号内的文本）。
func keyframeBodies(css string) []string {
	var out []string
	for i := 0; ; {
		j := strings.Index(css[i:], "@keyframes")
		if j < 0 {
			return out
		}
		start := i + j
		open := strings.Index(css[start:], "{")
		if open < 0 {
			return out
		}
		depth, k := 0, start+open
		for ; k < len(css); k++ {
			if css[k] == '{' {
				depth++
			} else if css[k] == '}' {
				depth--
				if depth == 0 {
					break
				}
			}
		}
		out = append(out, css[start:k])
		i = k
	}
}

// reducedMotionBlock 取 prefers-reduced-motion 那个媒体查询块的全文。
func reducedMotionBlock(css string) string {
	i := strings.Index(css, "@media (prefers-reduced-motion: reduce)")
	if i < 0 {
		return ""
	}
	open := strings.Index(css[i:], "{")
	if open < 0 {
		return ""
	}
	depth, k := 0, i+open
	for ; k < len(css); k++ {
		if css[k] == '{' {
			depth++
		} else if css[k] == '}' {
			depth--
			if depth == 0 {
				return css[i : k+1]
			}
		}
	}
	return css[i:]
}

// 品牌区两处（顶栏 `.brand` 与登录页 `.brand-lg`）**同源同款 = favicon.svg 的裸蓝
// 矢量**；全站不得残留任何带底的 logo 图；图标与文字的垂直居中要有双保险
// （flex 的 align-items:center 是主保险，inline 盒子的 vertical-align:middle 是兜底）。
func TestBrandMarksShareFaviconAndCenter(t *testing.T) {
	// 1. 两处品牌区都用同一个 favicon.svg
	for _, tpl := range []string{"templates/layout.html", "templates/login.html"} {
		raw, err := files.ReadFile(tpl)
		if err != nil {
			t.Fatalf("读 %s: %v", tpl, err)
		}
		if !strings.Contains(string(raw), `src="/favicon.svg"`) {
			t.Errorf("%s 的品牌区应引用 /favicon.svg（与站点 favicon 同源），实际没有", tpl)
		}
	}

	// 2. 全模板扫 <img>：src 只允许 /favicon.svg（二维码那张是运行时注入、本身无 src）
	entries, err := files.ReadDir("templates")
	if err != nil {
		t.Fatalf("列模板: %v", err)
	}
	imgTag := regexp.MustCompile(`<img\b[^>]*>`)
	imgSrc := regexp.MustCompile(`\bsrc="([^"]*)"`)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".html") {
			continue
		}
		raw, err := files.ReadFile("templates/" + e.Name())
		if err != nil {
			t.Fatalf("读 %s: %v", e.Name(), err)
		}
		for _, tag := range imgTag.FindAllString(string(raw), -1) {
			m := imgSrc.FindStringSubmatch(tag)
			if m == nil {
				continue // 运行时才补 src（二维码）
			}
			// B5 顶栏档案头像：src 是 Render 拼好的 data URL（{{.AvatarSrc}}），
			// 不是外链也不是品牌位——放行，其余仍只许站点 favicon。
			// 授权页的请求方 logo 是「谁在请求访问」的身份标识，由 appLogoPath
			// 从 knownApps 白名单生成，不是站点品牌位，单独放行。
			if m[1] == "/favicon.svg" || m[1] == "{{.AvatarSrc}}" || m[1] == "{{appLogo .App}}" {
				continue
			}
			t.Errorf("%s 里有非 favicon 的图片引用 %q——品牌图必须统一成裸蓝矢量，不许带底",
				e.Name(), m[1])
		}
	}

	// 3. 样式：双保险齐备
	cssBytes, err := files.ReadFile("style.css")
	if err != nil {
		t.Fatalf("读 style.css: %v", err)
	}
	css := string(cssBytes)
	if strings.Contains(css, "background-image") {
		t.Error("style.css 不该有 background-image（品牌图标走 <img>，不用底图）")
	}
	for _, want := range []struct{ selector, frag string }{
		{".brand", "align-items: center"},
		{".brand", "vertical-align: middle"},
		{".brand-mark", "align-items: center"},
		{".brand-mark", "vertical-align: middle"},
		{".ico", "vertical-align: middle"},
		{".brand-lg", "align-items: center"},
		{".brand-lg", "justify-content: center"},
	} {
		rule, ok := cssRule(css, want.selector)
		if !ok {
			t.Errorf("style.css 缺规则 %s", want.selector)
			continue
		}
		if !strings.Contains(rule, want.frag) {
			t.Errorf("%s 规则缺 %q（图标与文字垂直居中的保险）：\n%s", want.selector, want.frag, rule)
		}
	}
	// 品牌图标必须是显式尺寸的 <img>，加载前不抖版面
	layout, _ := files.ReadFile("templates/layout.html")
	if !strings.Contains(string(layout), `<img src="/favicon.svg" alt="" width="28" height="28">`) {
		t.Error("顶栏品牌图标应是 alt=\"\" + 显式 28×28 的 img")
	}
	login, _ := files.ReadFile("templates/login.html")
	if !strings.Contains(string(login), `<img class="ico" src="/favicon.svg" alt="" width="28" height="28">`) {
		t.Error("登录页大品牌区应是 alt=\"\" + 显式 28×28 的 img（与顶栏同源）")
	}
}

// 换装矩阵（2026-10-20 拍板，2026-10-21 品牌字形统一为素盾 shield）：**品牌位**走
// favicon.svg 的素盾，**passkey 功能位**
// 一律 key-round——两者不许再撞脸。这里钉住三件事：icons.go 有 key-round 且 path 与 lucide
// 官方一致、登录页 Passkey 按钮用的就是它、全模板没有 fingerprint 功能位残留（防回潮）。
func TestPasskeyFunctionalIconIsKeyRound(t *testing.T) {
	glyph, ok := icons["key-round"]
	if !ok {
		t.Fatal("icons.go 缺 key-round 条目（passkey 功能位统一用它）")
	}
	if !strings.Contains(glyph, `M2.586 17.414A2 2 0 0 0 2 18.828V21`) {
		t.Error("key-round 的 path 与 lucide 官方 key-round 不符（字形被改了？）")
	}
	if _, dead := icons["fingerprint"]; dead {
		t.Error("icons.go 不该再有 fingerprint 条目（品牌位已换素盾 shield、功能位是 key-round）")
	}

	entries, err := files.ReadDir("templates")
	if err != nil {
		t.Fatalf("列模板: %v", err)
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".html") {
			continue
		}
		raw, err := files.ReadFile("templates/" + e.Name())
		if err != nil {
			t.Fatalf("读 %s: %v", e.Name(), err)
		}
		if strings.Contains(string(raw), `{{icon "fingerprint"}}`) {
			t.Errorf("%s 还在用 fingerprint 功能图标——passkey 功能位应是 key-round", e.Name())
		}
	}

	login, err := files.ReadFile("templates/login.html")
	if err != nil {
		t.Fatalf("读 login.html: %v", err)
	}
	if !strings.Contains(string(login), `{{icon "key-round"}} 使用 Passkey 登录`) {
		t.Error("登录页 Passkey 按钮应是 {{icon \"key-round\"}} 使用 Passkey 登录")
	}
}

// B5 账号资料卡与顶栏升级：账号页渲染出资料卡全套控件（头像/色板/保存/清头像），
// 顶栏派生数据（显示名/首字/色板 hex/头像 data URL）在 Render 里落地；无昵称时
// 显示名回退邮箱前缀、首字回退邮箱首字符。
func TestProfileCardAndTopbarDerivation(t *testing.T) {
	if !Has("account") {
		t.Fatal("页面模板缺失: account")
	}
	// 账号页带档案渲染：资料卡控件 + palette 注入 + 头像 data URL
	rec := httptest.NewRecorder()
	avatar := "aGVsbG8="
	if err := Render(rec, "account", Data{
		Title: "账号", Email: "someone@example.com", Nickname: "阿橘",
		AvatarColor: 3, AvatarImage: avatar,
	}); err != nil {
		t.Fatalf("渲染账号页: %v", err)
	}
	body := rec.Body.String()
	for _, want := range []string{
		"账号资料", `id="pf-avatar"`, `id="pf-palette"`, `id="pf-save"`,
		`id="avatar-palette"`, "阿橘", "data:image/jpeg;base64," + avatar,
		"someone@example.com", `id="topbar-email" title="someone@example.com"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("账号页缺 %q", want)
		}
	}

	// 顶栏派生：无昵称 → 显示名邮箱前缀、首字邮箱首字符；色板越界回退首位
	rec2 := httptest.NewRecorder()
	if err := Render(rec2, "console", Data{Title: "概览", Email: "prefix@example.com", AvatarColor: 99}); err != nil {
		t.Fatalf("渲染概览页: %v", err)
	}
	b2 := rec2.Body.String()
	if !strings.Contains(b2, `id="topbar-email" title="prefix@example.com">prefix<`) {
		t.Error("无昵称时顶栏显示名应回退邮箱前缀")
	}
	if !strings.Contains(b2, ">P<") {
		t.Error("无昵称时顶栏首字应回退邮箱首字符大写")
	}
	if AvatarPaletteHex(99) != AvatarPaletteHex(0) || AvatarPaletteHex(-1) != AvatarPaletteHex(0) {
		t.Error("色板下标越界应回退首位")
	}
	// 色板与两 App AvatarPalette 逐值同序（8 色）
	wantPalette := []string{"#5B8DEF", "#7C6AF2", "#E2556B", "#FF8A3D", "#2BB673", "#14A8A0", "#E6B422", "#8B7355"}
	for i, hex := range wantPalette {
		if AvatarPaletteHex(i) != hex {
			t.Errorf("色板第 %d 位应 %s，得到 %s", i, hex, AvatarPaletteHex(i))
		}
	}
}

// 头像首字墨色（FX6a 必修1）：8 色色板逐色实测——选中的墨对底色 ≥4.5:1（正文线），
// 且确实是黑/白两支里对比更高的一支（与两 App AvatarPalette.inkFor 同规则）。写死
// 白墨的旧实现在这里全线翻车（白墨实测 1.92~4.49）。同时钉住三个注入点：layout 顶栏
// 底色+墨色成对、app.js 有 avatarInk 且被各渲染点调用、style.css .avatar 不再写死
// var(--primary-ink)。
func TestAvatarInkContrast(t *testing.T) {
	// 独立复算（不借 prod 的 hexLuminance，防实现与断言同错）：sRGB 线性化 + WCAG 加权
	lin := func(c uint8) float64 {
		f := float64(c) / 255
		if f <= 0.04045 {
			return f / 12.92
		}
		return math.Pow((f+0.055)/1.055, 2.4)
	}
	lum := func(hex string) float64 {
		n, err := strconv.ParseUint(strings.TrimPrefix(hex, "#"), 16, 32)
		if err != nil {
			t.Fatalf("解析色值 %q: %v", hex, err)
		}
		return 0.2126*lin(uint8(n>>16)) + 0.7152*lin(uint8(n>>8)) + 0.0722*lin(uint8(n))
	}
	ratio := func(a, b string) float64 {
		la, lb := lum(a), lum(b)
		if la < lb {
			la, lb = lb, la
		}
		return (la + 0.05) / (lb + 0.05)
	}
	for _, bg := range avatarPalette {
		ink := avatarInkFor(bg)
		if ink != "#000000" && ink != "#ffffff" {
			t.Errorf("色板 %s 的墨色应是黑/白之一，得到 %q", bg, ink)
			continue
		}
		if got := ratio(ink, bg); got < 4.5 {
			t.Errorf("色板 %s 的墨 %s 对比度 %0.2f < 4.5:1 正文线", bg, ink, got)
		}
		white, black := ratio("#ffffff", bg), ratio("#000000", bg)
		best := "#000000"
		if white >= black { // 平手取白，与 app.js avatarInk / 两 App inkFor 同 tie-break
			best = "#ffffff"
		}
		if ink != best {
			t.Errorf("色板 %s 应取对比更高的 %s（白 %0.2f / 黑 %0.2f），得到 %s", bg, best, white, black, ink)
		}
	}
	// 顶栏渲染：底色与墨色成对进同一行内 style（无档案头像时才出色块；#E6B422 = 下标 6）
	rec := httptest.NewRecorder()
	if err := Render(rec, "console", Data{Title: "概览", Email: "ink@example.com", AvatarColor: 6}); err != nil {
		t.Fatalf("渲染概览页: %v", err)
	}
	if !strings.Contains(rec.Body.String(), `style="background:#E6B422;color:#000000"`) {
		t.Error("顶栏色块应成对注入底色与墨色（background+color 同一 style）")
	}
	// style.css .avatar：不再写死白墨 var(--primary-ink)（默认兜底黑墨）
	cssBytes, err := files.ReadFile("style.css")
	if err != nil {
		t.Fatalf("读 style.css: %v", err)
	}
	rule, ok := cssRule(string(cssBytes), ".avatar")
	if !ok {
		t.Fatal("style.css 缺 .avatar 规则")
	}
	if strings.Contains(rule, "--primary-ink") {
		t.Error(".avatar 不该再写死白墨 var(--primary-ink)（白墨对色板全数 <4.5:1）")
	}
	// app.js avatarInk：定义 + 三处调用（avatarHTML / 资料卡 renderAvatar / 顶栏 updateTopbarAvatar）
	jsBytes, err := files.ReadFile("app.js")
	if err != nil {
		t.Fatalf("读 app.js: %v", err)
	}
	if n := strings.Count(string(jsBytes), "avatarInk("); n < 4 {
		t.Errorf("app.js 应定义并三处调用 avatarInk，只找到 %d 处", n)
	}
}

// W1 底栏清零：登录（含注册/找回 tab）、授权（确认与错误两变体）、邀请（表单与
// 错误两变体）、403 拒绝页**渲染产物里连 <footer> 容器都不出现**——不是 display:none
// 藏一下。逐页 Render 实测（而不是只看模板里的 if 条件），条件被误删时这里先翻车。
func TestMinimalPagesRenderNoFooter(t *testing.T) {
	cases := []struct {
		file string
		data Data
	}{
		{"login", Data{Title: "登录", Minimal: true}},
		{"authorize", Data{Title: "授权登录", Minimal: true, OAuth: &OAuthView{
			Tx: "t", App: "CalorieDiary", AppName: "热量日记", RedirectHost: "a.example", Email: "u@example.com"}}},
		{"authorize", Data{Title: "无法发起授权", Minimal: true, Status: http.StatusBadRequest,
			OAuth: &OAuthView{ErrorTitle: "无法发起授权", ErrorMessage: "应用未登记"}}},
		{"invite", Data{Title: "接受邀请", Minimal: true, Invite: &InviteView{
			Token: "t", Email: "a@example.com", App: "CalorieDiary", AppName: "热量日记"}}},
		{"invite", Data{Title: "无法接受邀请", Minimal: true, Status: http.StatusBadRequest,
			Invite: &InviteView{ErrorTitle: "无法接受邀请", ErrorMessage: "邀请链接已过期"}}},
		{"denied", Data{Title: "无权访问", Minimal: true, DeniedApp: "CalorieDiary"}},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		if err := Render(rec, c.file, c.data); err != nil {
			t.Fatalf("渲染 %s: %v", c.file, err)
		}
		body := rec.Body.String()
		if strings.Contains(body, "<footer") || strings.Contains(body, `class="foot"`) {
			t.Errorf("%s（Minimal 壳）渲染出了底栏——公共页一律无页脚", c.file)
		}
	}
	// 全模板只允许 layout 一处 <footer>（否则门控漏了第二处渲染点）
	entries, err := files.ReadDir("templates")
	if err != nil {
		t.Fatalf("列模板: %v", err)
	}
	n := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".html") {
			continue
		}
		raw, rerr := files.ReadFile("templates/" + e.Name())
		if rerr != nil {
			t.Fatalf("读 %s: %v", e.Name(), rerr)
		}
		n += strings.Count(string(raw), "<footer")
	}
	if n != 0 {
		t.Errorf("全站零页脚：模板集里不该有任何 <footer>，得到 %d 处", n)
	}
	cssBytes, cerr := files.ReadFile("style.css")
	if cerr != nil {
		t.Fatalf("读 style.css: %v", cerr)
	}
	if strings.Contains(string(cssBytes), ".foot {") {
		t.Error("style.css 不该再有 `.foot` 规则（页脚已整体退役）")
	}
	// 注销撤销页（cmd/server 的独立 HTML）不进模板集：它自带的整页里也没有页脚。
}

// 窄屏底栏（miuix FloatingNavigationBar）：居中**不许依赖 transform**。
// 旧写法 left:50% + translateX(-50%) 会被入场动画 rise-in 的关键帧
// （transform: translateY(...)）整个覆盖 —— 动画期间胶囊没有水平位移、停在
// 右半边，动画一结束再瞬间弹回正中。居中用 left/right:0 + margin-inline:auto。
// （2026-11 重写后底栏类名 tabnav → dock，断言同步迁移。）
func TestDockCenteringNeverUsesTransform(t *testing.T) {
	css := stripCSSComments(mustCSS(t))
	rule, ok := cssRule(css, ".dock")
	if !ok {
		t.Fatal("缺 .dock 规则")
	}
	if strings.Contains(rule, "transform:") {
		t.Error(".dock 自身不许写 transform（会被入场动画覆盖导致横向跳动），居中请用 left/right:0 + margin-inline:auto")
	}
	if !strings.Contains(rule, "margin-inline: auto") || !strings.Contains(rule, "left: 0; right: 0") {
		t.Error(".dock 应以 left/right:0 + margin-inline:auto 居中")
	}
	// miuix FloatingToolbarDefaults.CornerRadius = 50dp → 药丸
	if !strings.Contains(rule, "border-radius: 50px") {
		t.Error(".dock 圆角应为 50px（miuix FloatingToolbarDefaults.CornerRadius=50dp，药丸形态）")
	}
	// 未选中项 = 同色 ×40% alpha、选中全不透明（UnselectedAlpha 0.4）
	var navRules strings.Builder
	for _, seg := range strings.Split(css, ".dock .nav-item") {
		if i := strings.Index(seg, "}"); i > 0 {
			navRules.WriteString(seg[:i])
		}
	}
	if !strings.Contains(navRules.String(), "opacity: .4") {
		t.Error("未选中项应为 opacity:.4（miuix UnselectedAlpha 0.4），不是给选中项加底色块")
	}
}

// miuix 规范对齐（2026-10 全站重构）：卡片是**纯填充无描边**、圆角全站唯一 16、
// 分组行用 border-top 分隔。此前卡片用 box-shadow:inset 画环，而 inset 阴影画在
// 子元素背景之下——表格行 hover、选中 chip、按钮一触到卡片边缘就把环盖掉，
// 「点黑后圆角线消失」就是它。这三条钉住形态，防止回潮。
func TestMiuixCardForm(t *testing.T) {
	cssBytes, err := files.ReadFile("style.css")
	if err != nil {
		t.Fatalf("读 style.css: %v", err)
	}
	// 先剥注释：说明性文字里会提到 box-shadow:inset（讲历史根因），不算声明
	css := stripCSSComments(string(cssBytes))

	card, ok := cssRule(css, ".card")
	if !ok {
		t.Fatal("缺 .card 规则")
	}
	if strings.Contains(card, "box-shadow") {
		t.Error("miuix Card 是纯填充、无描边——.card 不该有 box-shadow（会被子元素背景盖掉，圆角断裂）")
	}
	if !strings.Contains(card, "var(--radius-card)") {
		t.Error(".card 应用 --radius-card，保证圆角与全站同源")
	}
	// 卡片圆角令牌恒 16（miuix CardDefaults.CornerRadius）：窄屏不许另起一套
	if !strings.Contains(css, "--radius-card: 16px;") {
		t.Error("--radius-card 应为 16px（miuix CardDefaults.CornerRadius）")
	}
	if strings.Contains(css, "border-radius: 18px") {
		t.Error("不该有 border-radius:18px 的断点覆盖——圆角不随宽度变")
	}
	// 行间分隔线必须是 border（画在自身背景之上），不能是 inset 阴影（会被盖）
	grp, ok := cssRule(css, ".group > .item + .item")
	if !ok {
		t.Fatal("缺 .group > .item + .item 分隔线规则")
	}
	if !strings.Contains(grp, "border-top") || strings.Contains(grp, "box-shadow") {
		t.Error("卡内行的分隔线应用 border-top（inset 阴影会被行 hover 背景盖掉）")
	}
	// 已退役的 --card-line 不许回来
	if strings.Contains(css, "--card-line") {
		t.Error("--card-line 已随「卡片去环」退役，不该再出现")
	}
}

// W3 头像底色派生：avatarColor 未设（0/越界）按 uid%8 从同一 8 色色板派生，
// 显式色原样用——顶栏不再「全员一个色」。Go 半边钉 AvatarPaletteHexFor 与
// Render 落地；JS 半边（app.js avatarHex/avatarHTML）钉结构与镜像式。
func TestAvatarDeriveByUID(t *testing.T) {
	want := []string{"#5B8DEF", "#7C6AF2", "#E2556B", "#FF8A3D", "#2BB673", "#14A8A0", "#E6B422", "#8B7355"}
	for _, uid := range []int64{1, 8, 9, 1000001, 1000002, 1000003} {
		if got := AvatarPaletteHexFor(uid, 0); got != want[uid%8] {
			t.Errorf("uid=%d 未设色应派生 palette[uid%%%d]=%s，得到 %s", uid, len(want), want[uid%8], got)
		}
		if got := AvatarPaletteHexFor(uid, 99); got != want[uid%8] {
			t.Errorf("uid=%d 越界色应按未设派生 %s，得到 %s", uid, want[uid%8], got)
		}
		if got := AvatarPaletteHexFor(uid, 3); got != want[3] {
			t.Errorf("uid=%d 显式色 3 应原样用 %s，得到 %s", uid, want[3], got)
		}
	}
	if AvatarPaletteHexFor(0, 0) != want[0] {
		t.Error("无 uid（Minimal 壳）回退色板首位")
	}
	// Render 落地：uid=9（9%8=1）、未设色 → 顶栏色块 #7C6AF2（墨色按亮度择黑）
	rec := httptest.NewRecorder()
	if err := Render(rec, "console", Data{Title: "概览", Email: "u@example.com",
		UID: 9, AvatarColor: 0}); err != nil {
		t.Fatalf("渲染概览: %v", err)
	}
	if !strings.Contains(rec.Body.String(), "background:#7C6AF2") {
		t.Error("顶栏色块应按 uid 派生（uid=9 → #7C6AF2）")
	}
	// app.js 半边：派生式与真图端点/回退结构
	jsBytes, err := files.ReadFile("app.js")
	if err != nil {
		t.Fatalf("读 app.js: %v", err)
	}
	js := string(jsBytes)
	for _, wantFrag := range []string{
		"u % p.length",                      // uid%8 派生式
		"/admin/users/${esc(u.uid)}/avatar", // 列表/抽屉头像走真图端点
		`class="avatar-img" loading="lazy"`, // 懒加载
		"wrap.dataset.initial",              // onerror 回退色块+首字
		"avatar-img",                        // 捕获阶段 error 监听的选择器依据
	} {
		if !strings.Contains(js, wantFrag) {
			t.Errorf("app.js 缺 W3 头像结构 %q", wantFrag)
		}
	}
	// 回退方向是「图 → 占位符」：不再有按 avatarImage 直出 data URL 的分支
	if strings.Contains(js, `data:image/jpeg;base64,${esc(u.avatarImage)}`) {
		t.Error("列表/抽屉头像不该再走 data URL 直出（应走 /admin/users/{uid}/avatar + onerror 回退）")
	}
}

// reauth 弹框的能力自适应契约 + W4 Web 接入撤下的同步钉：
// 三块能力区（Passkey 主钮 / 码框 / 密码兜底）齐全；app.js 有单例 in-flight
// （并发 401 共享弹框，修「验完要手动刷新」）与 Passkey 仪式接线；
// Web 接入的模板与脚本一并撤净不许回潮。
func TestReauthStagedAndWebAccessRemoved(t *testing.T) {
	layout, err := files.ReadFile("templates/layout.html")
	if err != nil {
		t.Fatalf("读 layout: %v", err)
	}
	head := string(layout)
	for _, want := range []string{
		`id="reauth-passkey-wrap"`, `id="reauth-code-wrap"`, `id="reauth-password-wrap"`,
		`id="reauth-passkey"`, `id="reauth-code"`, `id="reauth-password"`, `class="hidden"`,
	} {
		if !strings.Contains(head, want) {
			t.Errorf("reauth 弹窗缺能力自适应结构 %q", want)
		}
	}
	for _, gone := range []string{`id="reauth-step1"`, `id="reauth-step2"`, `<p class="or">或</p>`} {
		if strings.Contains(head, gone) {
			t.Errorf("reauth 弹窗不该再有旧分步结构 %q", gone)
		}
	}
	jsBytes, err := files.ReadFile("app.js")
	if err != nil {
		t.Fatalf("读 app.js: %v", err)
	}
	js := string(jsBytes)
	for _, want := range []string{
		"reauthInflight", "passkeyCount", "totpEnabled", "passwordSet",
		"/web/reauth/webauthn/options", "/web/reauth/webauthn/finish",
		`body: { password }`, "body: { totpCode, recoveryCode }",
	} {
		if !strings.Contains(js, want) {
			t.Errorf("app.js 缺能力自适应接线 %q", want)
		}
	}
	if strings.Contains(js, "reauthShowStep(") {
		t.Error("旧的两步分步接线应已退役（reauthShowStep）")
	}
	access, err := files.ReadFile("templates/admin-access.html")
	if err != nil {
		t.Fatalf("读 admin-access: %v", err)
	}
	if strings.Contains(string(access), "oauth-secret-dlg") {
		t.Error("Web 接入的一次性 Secret 层应随 W4 撤下")
	}
	if strings.Contains(js, "data-webaccess") || strings.Contains(js, "showOAuthSecret") {
		t.Error("app.js 不该再渲染 Web 接入块（W4：后端端点保留休眠，前端整体撤下）")
	}
}

// W5/W6 发码按钮内联与密码管理器徽章修复的结构钉：
// 验证码行 = 输入 flex + 按钮 flex:none 同一行；徽章锚定收进字段（position:relative
// + 右侧预留 44px）+ :-webkit-autofill 归一保住 FX3 内环。
func TestCodeRowInlineAndBadgeAnchorFix(t *testing.T) {
	cssBytes, err := files.ReadFile("style.css")
	if err != nil {
		t.Fatalf("读 style.css: %v", err)
	}
	css := string(cssBytes)
	codeLine, ok := cssRule(css, ".code-line")
	if !ok {
		t.Fatal("style.css 缺 .code-line 规则（W5 验证码行）")
	}
	for _, frag := range []string{"display: flex", "position: relative"} {
		if !strings.Contains(codeLine, frag) {
			t.Errorf(".code-line 缺 %q", frag)
		}
	}
	// W6 定位锚：.field 必须是 positioned，徽章/下拉才解析回字段自身
	field, ok := cssRule(css, ".field")
	if !ok {
		t.Fatal("style.css 缺 .field 规则")
	}
	if !strings.Contains(field, "position: relative") {
		t.Error(".field 应带 position:relative（W6：凭据徽章的包含块锚点）")
	}
	if !strings.Contains(css, `input[autocomplete="one-time-code"], input[type=password]`) ||
		!strings.Contains(css, "padding-right: 44px") {
		t.Error("凭据/OTP 字段应预留右侧徽章位（padding-right: 44px）")
	}
	if !strings.Contains(css, "input:-webkit-autofill") {
		t.Error("缺 :-webkit-autofill 归一（autofill 底色会盖掉站点内环）")
	}
	// 6 处发码按钮都进了 code-line（grep 全部「获取验证码」按钮的所在行）
	for _, tpl := range []string{"templates/login.html", "templates/account.html"} {
		raw, rerr := files.ReadFile(tpl)
		if rerr != nil {
			t.Fatalf("读 %s: %v", tpl, rerr)
		}
		if n := strings.Count(string(raw), `class="code-line"`); n < 1 {
			t.Errorf("%s 缺 code-line 行（W5 发码按钮内联）", tpl)
		}
		if strings.Contains(string(raw), `style="margin-top:-4px"`) {
			t.Errorf("%s 不该再有负 margin 的独占发码行（W5 已内联）", tpl)
		}
	}
	jsBytes, err := files.ReadFile("app.js")
	if err != nil {
		t.Fatalf("读 app.js: %v", err)
	}
	if !strings.Contains(string(jsBytes), "hide: ['#send-2fa-code']") {
		t.Error("两步邮箱码模式的发码按钮显隐应指向 #send-2fa-code（原独立行已删）")
	}
}

// W8/W9 排版与原生控件 miuix 化：站内下拉（按钮+浮层菜单、值载体保留）、样式
// checkbox/radio、披露行箭头、日期输入吃站内规则、表格窄屏横滚不破版、审计时间档位。
func TestNativeControlsMiuixAndLayoutFixes(t *testing.T) {
	cssBytes, err := files.ReadFile("style.css")
	if err != nil {
		t.Fatalf("读 style.css: %v", err)
	}
	css := string(cssBytes)
	// ① 日期输入必须在输入框规则名单里（W8③ 直接根因：漏了 type=date 就掉回 UA 形态）
	if !strings.Contains(css, "input[type=date]") {
		t.Error("input[type=date] 应并入站内输入框规则（否则审计日期掉回 UA 原生形态）")
	}
	// ② 站内下拉形态与勾选/单选自绘
	for _, frag := range []string{
		".select-btn", ".select-menu", ".select-opt",
		"input[type=checkbox]", "appearance: none",
		"details.section > summary::after",
	} {
		if !strings.Contains(css, frag) {
			t.Errorf("style.css 缺站内控件形态 %q", frag)
		}
	}
	// ③ 窄屏不破版：表格有 min-width（横滚交给 .table-wrap），网格子项压回 min-width:0
	tableRule, _ := cssRule(css, "table")
	if !strings.Contains(tableRule, "min-width") {
		t.Error("table 应带 min-width（窄屏让容器横滚，而不是把列压成一字一行）")
	}
	if !strings.Contains(css, ".content > * { min-width: 0; }") {
		t.Error(".content 网格子项应 min-width:0（防表格把整页撑横滚）")
	}
	// ④ JS 侧：下拉装饰器 + 审计时间快捷档位
	jsBytes, err := files.ReadFile("app.js")
	if err != nil {
		t.Fatalf("读 app.js: %v", err)
	}
	js := string(jsBytes)
	for _, frag := range []string{"function decorateSelect(", "decorateSelects(document)", "data-range", "function setRange("} {
		if !strings.Contains(js, frag) {
			t.Errorf("app.js 缺 W8/W9 结构 %q", frag)
		}
	}
	// ⑤ 审计页模板带四档位 chips（今天/近7天/近30天/自定义）
	audit, err := files.ReadFile("templates/admin-audit.html")
	if err != nil {
		t.Fatalf("读 admin-audit: %v", err)
	}
	for _, frag := range []string{`data-range="today"`, `data-range="7"`, `data-range="30"`, `data-range="custom"`} {
		if !strings.Contains(string(audit), frag) {
			t.Errorf("审计页缺时间快捷档位 %q", frag)
		}
	}
}

// cssAtRuleBlock 取以 marker 开头的 at-rule 规则体（含大括号），用于钉
// @supports not 这类无法靠 cssRule 定位的兜底块。
func cssAtRuleBlock(css, marker string) string {
	i := strings.Index(css, marker)
	if i < 0 {
		return ""
	}
	open := strings.Index(css[i:], "{")
	if open < 0 {
		return ""
	}
	depth, k := 0, i+open
	for ; k < len(css); k++ {
		if css[k] == '{' {
			depth++
		} else if css[k] == '}' {
			depth--
			if depth == 0 {
				return css[i : k+1]
			}
		}
	}
	return css[i:]
}

// 设计令牌单一来源（Miuix 0.9.5 视觉语言）：4/8pt 间距、8/12/16/20/28 圆角、
// 五级语义表面、title1/2/4 + body2/footnote 字阶（字号与行高成对）。
// 令牌缺失后续样式就会回填裸 px，视觉语言随之漂移——钉住整套名字与量值。
func TestDesignTokensPresent(t *testing.T) {
	css := stripCSSComments(mustCSS(t))
	root, ok := cssRule(css, ":root")
	if !ok {
		t.Fatal("style.css 缺 :root 规则")
	}
	for _, group := range []struct {
		name string
		toks []string
	}{
		{"4/8pt 间距", []string{"--sp-1: 4px", "--sp-2: 8px", "--sp-3: 12px", "--sp-4: 16px", "--sp-5: 20px", "--sp-6: 24px", "--sp-8: 32px"}},
		{"圆角梯度", []string{"--radius-xs: 8px", "--radius-sm: 12px", "--radius-card: 16px", "--radius-lg: 20px", "--radius-xl: 28px", "--radius-pill: 999px"}},
		{"五级表面", []string{"--background:", "--surface:", "--surface-container:", "--surface-container-high:", "--surface-variant:"}},
		{"字阶", []string{"--font-title1: 32px", "--font-title2: 24px", "--font-title4: 15px", "--font-body2: 14px", "--font-footnote: 12px", "--lh-title1:", "--lh-footnote:"}},
	} {
		for _, tok := range group.toks {
			if !strings.Contains(root, tok) {
				t.Errorf("%s 缺令牌 %q", group.name, tok)
			}
		}
	}
	// 暗色对：画布/变体/玻璃都要有暗值，否则跟随系统时材质与层级会塌掉
	for _, frag := range []string{"--background: #000000", "--surface-variant: #2D2D2D", "--glass-bg: rgba(0, 0, 0, .66)"} {
		if !strings.Contains(css, frag) {
			t.Errorf("暗色缺表面/玻璃令牌 %q", frag)
		}
	}
}

// 玻璃材质只给浮动 chrome（顶栏/窄屏底栏）：都上 backdrop-filter
// blur(24px) saturate(1.6)，且 @supports not 时**两处**都退实底。
// 顶栏若漏兜底会在老浏览器变全透明，读不清——可读性优先于质感。
// （2026-11 重写：底栏类名 tabnav → dock；卡片/工具条改纯实底，玻璃收窄到 chrome。）
func TestGlassTopbarAndDockFallback(t *testing.T) {
	css := stripCSSComments(mustCSS(t))
	for _, sel := range []string{".topbar", ".dock"} {
		rule, ok := cssRule(css, sel)
		if !ok {
			t.Fatalf("style.css 缺 %s 规则", sel)
		}
		for _, frag := range []string{
			"-webkit-backdrop-filter: blur(var(--glass-bar-blur)) saturate(var(--glass-bar-saturate))",
			"backdrop-filter: blur(var(--glass-bar-blur)) saturate(var(--glass-bar-saturate))",
		} {
			if !strings.Contains(rule, frag) {
				t.Errorf("%s 缺玻璃声明 %q", sel, frag)
			}
		}
	}
	sup := cssAtRuleBlock(css, "@supports not ((backdrop-filter: blur(1px))")
	if sup == "" {
		t.Fatal("style.css 缺 @supports not 玻璃兜底块")
	}
	for _, frag := range []string{".topbar", "var(--canvas)", ".dock", "var(--card)"} {
		if !strings.Contains(sup, frag) {
			t.Errorf("@supports not 兜底缺 %q（顶栏/底栏都要退实底）", frag)
		}
	}
}

// 弹簧曲线只给物理反馈：Switch 滑块与导航项（窄屏底栏 / 宽屏侧栏）按压。
// 常规组件（按钮/卡片/标签/提示条/分段）一律克制 easing，否则会出现「处处回弹」。
func TestSpringLimitedToPhysicalFeedback(t *testing.T) {
	css := stripCSSComments(mustCSS(t))
	root, _ := cssRule(css, ":root")
	if !strings.Contains(root, "--spring: cubic-bezier(.34, 1.56, .64, 1)") {
		t.Error(":root 缺弹簧令牌 --spring")
	}
	if got := strings.Count(css, "var(--spring)"); got != 2 {
		t.Errorf("var(--spring) 应只出现 2 处（Switch 滑块 + 导航项按压），得到 %d", got)
	}
	sw, ok := cssRule(css, "input[type=checkbox].switch::after")
	if !ok {
		t.Fatal("style.css 缺 Switch 滑块规则")
	}
	if !strings.Contains(sw, "transition: transform var(--dur-2) var(--spring)") {
		t.Error("Switch 滑块位移应走弹簧 --spring")
	}
	nav, ok := cssRule(css, ".nav-item")
	if !ok {
		t.Fatal("style.css 缺 .nav-item 规则")
	}
	if !strings.Contains(nav, "var(--spring)") {
		t.Error("导航项按压应走弹簧 --spring（底栏/侧栏物理反馈）")
	}
	for _, sel := range []string{".btn", ".card", ".tab", ".toast", ".app-chip"} {
		if rule, ok := cssRule(css, sel); ok && strings.Contains(rule, "var(--spring)") {
			t.Errorf("%s 不该用弹簧曲线（只给物理反馈）", sel)
		}
	}
}

// Switch 与无障碍：原生 checkbox 保留语义/键盘（只加 class 与 role=switch），
// 44px 触控行、状态不只靠颜色（滑块位置）、计数变化可播报、吸顶栏不遮焦点。
func TestSwitchPatternAndA11y(t *testing.T) {
	css := stripCSSComments(mustCSS(t))
	sw, ok := cssRule(css, "input[type=checkbox].switch")
	if !ok {
		t.Fatal("style.css 缺 Switch 轨道规则")
	}
	for _, frag := range []string{"width: var(--tap)", "border-radius: var(--radius-pill)"} {
		if !strings.Contains(sw, frag) {
			t.Errorf("Switch 轨道缺 %q（44px 目标 + 药丸形）", frag)
		}
	}
	if row, ok := cssRule(css, ".switch-row"); !ok || !strings.Contains(row, "min-height: var(--tap)") {
		t.Error(".switch-row 应 ≥44px（整行可点，WCAG 2.5.5）")
	}
	if !strings.Contains(css, "html { scroll-padding-top: 72px; }") {
		t.Error("缺 scroll-padding-top（sticky 顶栏不遮锚点/焦点，WCAG 2.4.11）")
	}
	acc, err := files.ReadFile("templates/account.html")
	if err != nil {
		t.Fatalf("读账号页: %v", err)
	}
	if !strings.Contains(string(acc), `<input type="checkbox" class="switch" role="switch" id="login-notify">`) {
		t.Error("登录提醒应是原生 checkbox + .switch + role=switch（语义与键盘不替换）")
	}
	for name, id := range map[string]string{
		"admin-users.html": "users-total", "admin-sessions.html": "sess-total", "admin-audit.html": "audit-total",
	} {
		raw, rerr := files.ReadFile("templates/" + name)
		if rerr != nil {
			t.Fatalf("读 %s: %v", name, rerr)
		}
		if !strings.Contains(string(raw), `id="`+id+`" aria-live="polite"`) {
			t.Errorf("%s 的 #%s 应带 aria-live=polite（计数变化可被读屏感知）", name, id)
		}
	}
}

// 玻璃组件模式（2026-11 重写后口径）：**玻璃只给浮动 chrome**（顶栏/底栏/
// 对话框/菜单/Toast），内容面（卡片/工具条/详情面板）一律纯实底——Apple HIG
// 「never stack a light translucent surface on another」+ 文字对比优先；
// @supports not 分支逐个退回实底——不能出现「有模糊才看得见」。
func TestGlassComponentSurfaces(t *testing.T) {
	css := stripCSSComments(mustCSS(t))
	root, ok := cssRule(css, ":root")
	if !ok {
		t.Fatal("style.css 缺 :root")
	}
	for _, tok := range []string{
		"--glass-bg:", "--glass-float-bg:", "--glass-menu-bg:", "--glass-dialog-bg:",
		"--glass-stroke:", "--glass-bar-blur:", "--glass-bar-saturate:",
		"--badge-bg:", "--progress-track:", "--progress-fill:", "--empty-bg:",
		"--toast-bg:", "--toast-bad-bg:", "--toast-bad-ink:",
	} {
		if !strings.Contains(root, tok) {
			t.Errorf(":root 缺玻璃/语义令牌 %q", tok)
		}
	}
	for _, sel := range []string{".topbar", ".dock", ".dlg", ".select-menu", ".toast"} {
		rule, ok := cssRule(css, sel)
		if !ok {
			t.Fatalf("style.css 缺 %s 规则", sel)
		}
		if !strings.Contains(rule, "-webkit-backdrop-filter:") || !strings.Contains(rule, "backdrop-filter:") {
			t.Errorf("%s 缺玻璃模糊声明（含 -webkit- 前缀）", sel)
		}
	}
	// 内容面必须是实底（不叠半透明——叠在玻璃 chrome 下文字对比会塌）
	for _, sel := range []string{".card", ".toolbar", ".detail"} {
		rule, ok := cssRule(css, sel)
		if !ok {
			t.Fatalf("style.css 缺 %s 规则", sel)
		}
		if strings.Contains(rule, "backdrop-filter:") {
			t.Errorf("%s 应是纯实底内容面（玻璃只给浮动 chrome，见 HIG 材质分层）", sel)
		}
	}
	sup := cssAtRuleBlock(css, "@supports not ((backdrop-filter: blur(1px))")
	if sup == "" {
		t.Fatal("缺 @supports not 兜底块")
	}
	for _, frag := range []string{".topbar", ".dock", ".select-menu", ".dlg", ".toast"} {
		if !strings.Contains(sup, frag) {
			t.Errorf("@supports not 兜底缺 %s（玻璃 chrome 都要退实底）", frag)
		}
	}
	// 语义色真的被组件用上了（不是只定义不引用）
	for _, pair := range [][2]string{
		{".badge", "var(--badge-bg)"}, {".bar-track", "var(--progress-track)"},
		{".bar-fill", "var(--progress-fill)"}, {".empty", "var(--empty-bg)"},
	} {
		rule, ok := cssRule(css, pair[0])
		if !ok || !strings.Contains(rule, pair[1]) {
			t.Errorf("%s 应使用语义令牌 %s", pair[0], pair[1])
		}
	}
}

// 玻璃顶栏的 backdrop-filter 会成为固定定位的包含块：.dock 若留在 <header> 内，
// position:fixed 就相对顶栏而非视口，窄屏底栏会被钉到页面顶部。钉住「nav 在 header 之后」。
func TestBottomNavOutsideGlassTopbar(t *testing.T) {
	raw, err := files.ReadFile("templates/layout.html")
	if err != nil {
		t.Fatalf("读 layout: %v", err)
	}
	head := string(raw)
	end := strings.Index(head, "</header>")
	nav := strings.Index(head, `<nav class="dock"`)
	if end < 0 || nav < 0 || nav < end {
		t.Errorf("窄屏底栏必须在 </header> 之后（否则被玻璃顶栏的 backdrop-filter 钉到顶部），end=%d nav=%d", end, nav)
	}
}

// 窄屏响应式实测回归：顶栏横滚必须 flex-start（flex-end 会把最左按钮裁到容器外），
// 触控目标块与底栏项 ≥44，toast 的抬升媒体查询必须写在基础规则**之后**。
// （2026-11 重写：pointer:coarse 现在有两块——键盘让路 + 触控目标——按内容定位。）
func TestNarrowScreenResponsiveFixes(t *testing.T) {
	css := stripCSSComments(mustCSS(t))
	mobile := cssAtRuleBlock(css, "@media (max-width: 640px)")
	if mobile == "" || !strings.Contains(mobile, "justify-content: flex-start") {
		t.Error("窄屏 .topbar-actions 应 justify-content:flex-start（防最左按钮被裁且滚不到）")
	}
	coarse := ""
	for _, block := range coarseBlocks(css) {
		if strings.Contains(block, "var(--tap)") {
			coarse = block
			break
		}
	}
	if coarse == "" {
		t.Fatal("缺含 var(--tap) 的 @media (pointer: coarse) 触控目标块")
	}
	for _, frag := range []string{
		".btn.small", ".app-chip", ".brand", ".skip", ".pf-chip", ".nav-item", "var(--tap)",
		"input[type=checkbox]::before", "input[type=radio]::before",
	} {
		if !strings.Contains(coarse, frag) {
			t.Errorf("触控目标块缺 %q（触屏一律 ≥44px）", frag)
		}
	}
	nav := cssAtRuleBlock(css, ".dock .nav-item")
	if !strings.Contains(nav, "min-width: var(--tap)") {
		t.Error(".dock .nav-item 应 min-width:var(--tap)（实测 375px 下有项只有 43px）")
	}
	base := strings.Index(css, "\n.toast {")
	lift := strings.Index(css, "@media (max-width: 899.98px) {\n  .toast { bottom:")
	if base < 0 || lift < 0 || lift < base {
		t.Errorf("toast 抬升规则必须写在 .toast 基础规则之后（否则被基础规则的 bottom 覆盖），base=%d lift=%d", base, lift)
	}
}

// coarseBlocks 返回全部 @media (pointer: coarse) 块（本文件现在有两块）。
func coarseBlocks(css string) []string {
	var out []string
	for i := 0; ; {
		j := strings.Index(css[i:], "@media (pointer: coarse)")
		if j < 0 {
			return out
		}
		start := i + j
		block := cssAtRuleBlock(css[start:], "@media (pointer: coarse)")
		if block == "" {
			return out
		}
		out = append(out, block)
		i = start + len(block)
	}
}

// 每个模板都要能真的 Execute（parse 通过 ≠ 执行通过：字段引用错误只在执行期爆）。
// 2026-11 全量重写后 17 个模板逐一渲染，双变体页（authorize/invite/setup-password）
// 两态都过。
func TestEveryPageRenders(t *testing.T) {
	nav := ConsoleNav("console")
	adminNav := AdminNav("admin-users", true)
	cases := []struct {
		file string
		data Data
	}{
		{"login", Data{Title: "登录", Minimal: true}},
		{"console", Data{Title: "概览", Email: "u@example.com", Nav: nav}},
		{"sessions", Data{Title: "登录会话", Email: "u@example.com", Nav: nav}},
		{"passkeys", Data{Title: "Passkey", Email: "u@example.com", Nav: nav}},
		{"security", Data{Title: "两步验证", Email: "u@example.com", Nav: nav}},
		{"account", Data{Title: "账号", Email: "u@example.com", Nav: nav}},
		{"admin-users", Data{Title: "用户", Email: "a@example.com", Nav: adminNav, IsAdmin: true, IsSuper: true, InAdmin: true}},
		{"admin-access", Data{Title: "项目访问", Email: "a@example.com", Nav: AdminNav("admin-access", false), IsAdmin: true, InAdmin: true}},
		{"admin-sessions", Data{Title: "会话总览", Email: "a@example.com", Nav: adminNav, IsAdmin: true, IsSuper: true, InAdmin: true,
			Apps: SwitchApps(true, nil, ""), CurrentApp: ""}},
		{"admin-audit", Data{Title: "审计日志", Email: "a@example.com", Nav: adminNav, IsAdmin: true, IsSuper: true, InAdmin: true,
			Apps: SwitchApps(true, nil, "")}},
		{"admin-config", Data{Title: "配置中心", Email: "a@example.com", Nav: adminNav, IsAdmin: true, IsSuper: true, InAdmin: true}},
		{"admin-ai", Data{Title: "AI 用量", Email: "a@example.com", Nav: adminNav, IsAdmin: true, IsSuper: true, InAdmin: true,
			Apps: SwitchApps(true, nil, "")}},
		{"denied", Data{Title: "无权访问", Minimal: true, DeniedApp: "ExpenseDiary"}},
		{"authorize", Data{Title: "授权登录", Minimal: true, OAuth: &OAuthView{
			Tx: "tx-1", App: "CalorieDiary", AppName: "热量日记",
			RedirectHost: "app.example.com", Email: "u@example.com",
			Scopes: []string{"你的账号标识（uid）"}}}},
		{"authorize", Data{Title: "无法发起授权", Minimal: true, Status: http.StatusBadRequest,
			OAuth: &OAuthView{ErrorTitle: "无法发起授权", ErrorMessage: "应用未登记"}}},
		{"invite", Data{Title: "接受邀请", Minimal: true,
			Invite: &InviteView{Token: "t", Email: "a@example.com", App: "CalorieDiary", AppName: "热量日记"}}},
		{"invite", Data{Title: "无法接受邀请", Minimal: true, Status: http.StatusBadRequest,
			Invite: &InviteView{ErrorTitle: "无法接受邀请", ErrorMessage: "邀请链接无效"}}},
		{"setup-password", Data{Title: "设置新密码", Minimal: true,
			PasswordSetup: &PasswordSetupView{Token: "t", Email: "a@example.com"}}},
		{"setup-password", Data{Title: "无法设置密码", Minimal: true, Status: http.StatusBadRequest,
			PasswordSetup: &PasswordSetupView{ErrorTitle: "链接已失效", ErrorMessage: "令牌无效"}}},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		if err := Render(rec, c.file, c.data); err != nil {
			t.Errorf("渲染 %s: %v", c.file, err)
			continue
		}
		if rec.Code == 0 || rec.Body.Len() == 0 {
			t.Errorf("%s 渲染出空响应", c.file)
		}
	}
}

// 下拉菜单项是非原生控件：必须有显式焦点环，否则键盘用户看不出选中哪一行。
func TestSelectOptionFocusVisible(t *testing.T) {
	css := stripCSSComments(mustCSS(t))
	if !strings.Contains(css, ".select-opt:focus-visible") {
		t.Error("缺 .select-opt:focus-visible（自绘下拉项的键盘焦点环）")
	}
}

// ================= 2026-11 三模块重写（项目访问/会话总览/用户）+ 拒绝态 =================

// 项目访问页：用「成员 + 角色」表达谁能访问（平台管理员 / 项目管理员 / 登录名单），
// 不再使用「豁免管理」这种实现词；添加成员必须从已注册用户里搜索选择。
func TestAdminAccessMembersAndPicker(t *testing.T) {
	raw, err := files.ReadFile("templates/admin-access.html")
	if err != nil {
		t.Fatalf("读 admin-access 模板: %v", err)
	}
	tpl := string(raw)
	for _, want := range []string{
		`id="access-ladder"`, `id="access-stats"`, `id="access-denied"`,
		`id="member-dlg"`, `id="member-query"`, `id="member-results"`,
		`id="member-role"`, `id="access-dlg"`,
		"谁可以访问项目", "平台管理员", "项目管理员", "登录名单", "添加成员",
	} {
		if !strings.Contains(tpl, want) {
			t.Errorf("admin-access.html 缺 %q", want)
		}
	}
	if strings.Contains(tpl, "exempt-dlg") || strings.Contains(tpl, "豁免管理") {
		t.Error("旧的「豁免管理」弹层/术语不应保留")
	}
	if !strings.Contains(tpl, `id="access-stats" aria-live="polite"`) {
		t.Error("access-stats 应带 aria-live=polite（计数变化可被读屏感知）")
	}
	// 角色选择必须在结果列表之前：否则成员列表的滚动容器/对话框高度会把
	// 原生 select 弹层挤到可视区外。
	if strings.Index(tpl, `id="member-role-field"`) > strings.Index(tpl, `id="member-results"`) {
		t.Error("项目角色选择应排在成员列表之前")
	}
	if strings.Contains(tpl, "oauth-secret-dlg") {
		t.Error("Web 接入的一次性 Secret 层不应随重写回来")
	}

	js := mustJS(t)
	block := jsBlock(t, js, "function initAdminAccess() {", "\n/* ---------- 后台：会话总览")
	for _, want := range []string{
		"data-add-member",                               // 每卡的添加入口
		"/candidates?query=",                            // 从已注册用户里搜
		"body: { app: p.app, op: 'grant' }",             // 授予项目管理员
		"op: 'revoke'",                                  // 移除项目管理员
		"member-role-field",                             // 角色选择（可登录 / 项目管理员）
		"项目管理员可管理本项目成员",                                 // 角色语义
		"emptyEl.hidden = peopleEl.children.length > 0", // 空态随成员列表
	} {
		if !strings.Contains(block, want) {
			t.Errorf("项目访问实现缺 %q", want)
		}
	}
}

// 会话总览：四项服务端聚合 KPI、按用户的项目/归属地聚合列、钻取面板的
// 服务端归属地分布、每行到期时刻与「全量退出仅平台管理员」的角色门。
func TestAdminSessionsOverviewAggregation(t *testing.T) {
	raw, err := files.ReadFile("templates/admin-sessions.html")
	if err != nil {
		t.Fatalf("读 admin-sessions 模板: %v", err)
	}
	tpl := string(raw)
	for _, want := range []string{
		`id="sess-kpi-sessions"`, `id="sess-kpi-users"`, // 服务端总数
		`id="sess-kpi-projects"`, `id="sess-kpi-regions"`, // 服务端聚合桶数
		"覆盖项目（当前筛选）", "覆盖归属地（当前筛选）",
		`id="sd-region"`, // 钻取面板的归属地分布容器
		`id="sd-region-bars"`,
		`id="sd-kick-all"`,   // 全量退出（super 专属，JS 按角色显隐）
		`id="sd-scope-hint"`, // 项目管理员的范围说明
		`id="sd-all-dialog"`, // 全量退出确认
		"主要归属地", "覆盖项目",      // 聚合列
	} {
		if !strings.Contains(tpl, want) {
			t.Errorf("admin-sessions.html 缺 %q", want)
		}
	}
	if strings.Count(tpl, `id="sd-kick-all"`) != 1 {
		t.Error("全量退出按钮应恰有一处")
	}
	if strings.Contains(tpl, "本页覆盖") {
		t.Error("admin-sessions.html 不应再把 KPI 标成「本页覆盖」（服务端已全量聚合）")
	}

	jsBytes, err := files.ReadFile("app.js")
	if err != nil {
		t.Fatalf("读 app.js: %v", err)
	}
	js := string(jsBytes)
	for _, want := range []string{
		"function regionBreakdown(",          // 归属地聚合
		"$('#sd-region-bars').innerHTML",     // 分布条渲染
		"allBtn.dataset.uid = String(uid)",   // 确认文案要带 uid
		"$('#sd-scope-hint').hidden = false", // 非 super 换成范围说明
		"/revoke-sessions",                   // 全量退出走既有端点
	} {
		if !strings.Contains(js, want) {
			t.Errorf("app.js 缺会话总览结构 %q", want)
		}
	}
	// KPI 函数体必须只读回执的 apps/regions；出现本地 Set/regionBreakdown 就是
	// 又把一页数据当全量（本测试钉的就是这个回归）。做成纯判据以便变异检验。
	kpiIssues := func(src string) []string {
		var issues []string
		kpi := jsBlock(t, src, "function refreshKpis(res)", "async function loadUsers()")
		for _, want := range []string{
			"res.apps || []", "res.regions || []",
			"$('#sess-kpi-projects').textContent", "$('#sess-kpi-regions').textContent",
		} {
			if !strings.Contains(kpi, want) {
				issues = append(issues, "refreshKpis 未消费服务端聚合 "+want)
			}
		}
		for _, bad := range []string{"new Set((items || []).map", "regionBreakdown(items)"} {
			if strings.Contains(kpi, bad) {
				issues = append(issues, "refreshKpis 又用本页数据算 KPI："+bad)
			}
		}
		return issues
	}
	for _, issue := range kpiIssues(js) {
		t.Error(issue)
	}
	mutated := strings.Replace(js, "String((res.apps || []).length)",
		"String(new Set((items || []).map(s => s.app)).size)", 1)
	if len(kpiIssues(mutated)) == 0 {
		t.Error("变异检验失效：把项目 KPI 改回本页 Set 去重竟没被钉住")
	}
	// 每行到期时刻 + 钻取面板分布都来自同一份回执。openDetail 有两处同名实现，
	// 必须从会话控制器内部开始截。
	detail := jsBlockAfter(t, js, "async function loadUsers()",
		"async function openDetail(uid, email)", "$('#sd-close').addEventListener")
	for _, want := range []string{
		"s.expiresAt", "s.idleExpiresAt", "res.regions || []", "r.name", "r.count",
	} {
		if !strings.Contains(detail, want) {
			t.Errorf("会话详情未渲染新契约字段 %q", want)
		}
	}
	// 角色门：全量退出按钮的显隐必须按 IS_SUPER 分叉（端点 requireSuper）
	i := strings.Index(js, "allBtn.classList.remove('hidden')")
	j := -1
	if i >= 0 {
		j = strings.LastIndex(js[:i], "if (IS_SUPER)")
	}
	if i < 0 || j < 0 || i-j > 200 {
		t.Error("全量退出按钮应按 IS_SUPER 显隐（端点仅平台管理员可用）")
	}
}

// 用户页：服务端跨页筛选 chips（角色/封禁，写入 URL）、项目权限列与项目管理员语义、
// 详情面板把高风险操作收进 danger-zone。
func TestAdminUsersExemptionAndDangerZone(t *testing.T) {
	raw, err := files.ReadFile("templates/admin-users.html")
	if err != nil {
		t.Fatalf("读 admin-users 模板: %v", err)
	}
	tpl := string(raw)
	for _, want := range []string{
		`data-role-facet="all"`, `data-role-facet="super"`,
		`data-role-facet="admin"`, `data-role-facet="user"`,
		`data-status-facet="banned"`, // 封禁中筛选
		`id="users-facet-note"`,      // 当前筛选口径提示
		`id="users-denied"`,          // 拒绝态面板容器
		"项目权限",                       // 列名
		"把项目授予账号，就是让 TA 成为该项目的项目管理员", // 角色语义写进页首说明
	} {
		if !strings.Contains(tpl, want) {
			t.Errorf("admin-users.html 缺 %q", want)
		}
	}

	jsBytes, err := files.ReadFile("app.js")
	if err != nil {
		t.Fatalf("读 app.js: %v", err)
	}
	js := string(jsBytes)
	for _, want := range []string{
		"return '管理全部项目'",                                 // scopeSummary：super
		"`管理 ${n} 个项目`",                                   // scopeSummary：有授权
		"'未管理项目'",                                         // scopeSummary：零授权
		"项目管理员 · 可管理本项目",                                  // 详情面板逐项语义
		"class=\"danger-zone\"",                           // 高风险操作收进危险区
		"当前筛选生效",                                          // 筛选如实标注
		"banned: facet.status === 'banned' ? 'true' : ''", // 封禁筛选写 URL
	} {
		if !strings.Contains(js, want) {
			t.Errorf("app.js 缺用户页结构 %q", want)
		}
	}
	if strings.Contains(tpl, "只过滤当前页") || strings.Contains(tpl, "本页筛选") {
		t.Error("admin-users.html 还在说筛选只作用当前页")
	}
	if strings.Contains(js, "只过滤当前页") || strings.Contains(js, "本页筛选生效") {
		t.Error("app.js 还在说筛选只作用当前页")
	}

	// 机制：筛选条件必须进 /admin/users 查询串，renderRows 不再本地过滤。
	list := jsBlock(t, js, "function renderRows()", "async function load()")
	if strings.Contains(list, "filter(facetMatch)") {
		t.Error("renderRows 仍在本地过滤；服务端跨页筛选应直接渲染回执")
	}
	filterIssues := func(src string) []string {
		var issues []string
		// load() 有九处同名实现，用唯一的参数构造行作起点。
		load := jsBlock(t, src, "const params = new URLSearchParams({", "async function openDetail(uid, email)")
		for _, want := range []string{
			"params.set('role', facet.role)", "params.set('banned', 'true')", "params.toString()",
		} {
			if !strings.Contains(load, want) {
				issues = append(issues, "用户列表请求未带服务端筛选参数 "+want)
			}
		}
		return issues
	}
	for _, issue := range filterIssues(js) {
		t.Error(issue)
	}
	mutated := strings.Replace(js, "params.set('banned', 'true')", "", 1)
	if len(filterIssues(mutated)) == 0 {
		t.Error("变异检验失效：删掉封禁筛选参数竟没被钉住")
	}
	chips := jsBlock(t, js, "$$('[data-role-facet]').forEach(chip => chip.addEventListener('click'", "// 审计页的 uid 链接")
	if strings.Count(chips, "load();") != 2 || !strings.Contains(chips, "pager.state.offset = 0;") {
		t.Error("两个筛选 chip 都应重置页码并重新请求服务端（不能只重渲染当前页）")
	}
	if !strings.Contains(js, "q.get('banned') === 'true' || q.get('status') === 'banned'") {
		t.Error("筛选 URL 状态未恢复 banned=true")
	}
}

// 拒绝态分级：401/403 → 未登录/策略拒绝/权限不足 三档，面板带下一步动作；
// 403 页原因分级列表 + 重试；登录页与授权错误页接入同一条分级链路。
func TestDenialTierClassificationAndPanels(t *testing.T) {
	jsBytes, err := files.ReadFile("app.js")
	if err != nil {
		t.Fatalf("读 app.js: %v", err)
	}
	js := string(jsBytes)
	for _, want := range []string{
		"function denialTier(status, message, reason)",
		"function denialPanelHTML(err, opts)",
		"function showDenial(sel, err, opts)",
		"label: '未登录'", "label: '策略拒绝'", "label: '权限不足'",
		"reason === 'policy' || reason === 'permission'", // 服务端 reason 优先
		"err && err.reason",                   // 面板把 reason 透传进分级
		"if (data && data.reason) err.reason", // api() 把 403 reason 附到错误对象
		"/封禁|仅限受邀/",                           // 无 reason 时的文案判据（兼容老服务端）
		"data-denied-retry",                   // 面板里的重试动作
		"mailto:support@horatio.cn",           // 申诉/求助入口
		"#login-denied",                       // 登录流程内的拒绝分支
		"err.status === 403 &&",               // 登录页只把 403 当拒绝态（401 = 密码错）
		"stampDeniedAt",                       // 报障时间戳（403 页与授权错误页共用）
	} {
		if !strings.Contains(js, want) {
			t.Errorf("app.js 缺拒绝态结构 %q", want)
		}
	}

	// 403 没带 reason 时不再「非策略即权限」：CSRF/Origin、MFA 等拦截按原文
	// 回落普通报错，不能一律显示「联系平台管理员开通」。400/404 本就不分级。
	tier := jsBlock(t, js, "function denialTier(", "/* 拒绝面板 HTML")
	for _, want := range []string{
		"if (code !== 403) return '';",
		"if (/封禁|仅限受邀/.test(m)) return 'policy';",
		"if (/权限|授权|开通|没有该项目的管理/.test(m)) return 'permission';",
		"return '';",
	} {
		if !strings.Contains(tier, want) {
			t.Errorf("denialTier 缺无 reason 回落分支 %q", want)
		}
	}
	if strings.Contains(tier, "? 'policy' : 'permission'") {
		t.Error("denialTier 又把无 reason 的 403 硬判成权限不足")
	}

	login, err := files.ReadFile("templates/login.html")
	if err != nil {
		t.Fatalf("读 login 模板: %v", err)
	}
	if !strings.Contains(string(login), `id="login-denied"`) {
		t.Error("登录页应有拒绝态面板容器 id=login-denied")
	}

	// 403 页：原因分级列表（当前命中高亮）+ 重试 + 求助/报障要素
	denied, err := files.ReadFile("templates/denied.html")
	if err != nil {
		t.Fatalf("读 denied 模板: %v", err)
	}
	dtpl := string(denied)
	for _, want := range []string{
		`id="denied-tiers"`, " · 当前", "未登录", "权限不足",
		`{{$reason := .DeniedReason}}`,   // 命中级别由服务端 reason 驱动
		`{{if eq $reason "permission"}}`, // permission 时高亮权限不足一级
		`id="denied-reason"`,             // 原始 reason 展示位
		`id="denied-retry"`, "support@horatio.cn", "开通邀请邮件",
	} {
		if !strings.Contains(dtpl, want) {
			t.Errorf("denied.html 缺 %q", want)
		}
	}

	// 授权错误页：按状态码分级徽标 + 分级下一步 + 报障时间戳
	auth, err := files.ReadFile("templates/authorize.html")
	if err != nil {
		t.Fatalf("读 authorize 模板: %v", err)
	}
	atpl := string(auth)
	for _, want := range []string{
		`{{if eq $status 403}}策略拒绝{{else if eq $status 401}}未登录{{else}}请求无效{{end}}`,
		`id="auth-back"`, `id="denied-at"`, "回到控制台", "联系支持",
	} {
		if !strings.Contains(atpl, want) {
			t.Errorf("authorize.html 错误变体缺 %q", want)
		}
	}

	// 拒绝面板/分级列表的样式走既有令牌（--warn-bg/--radius-card/--ease 动效）
	css := stripCSSComments(mustCSS(t))
	for sel, frags := range map[string][]string{
		".denied-panel":                  {"var(--warn-bg)", "var(--radius-card)"},
		".denied-tier":                   {"var(--canvas)", "var(--radius-sm)"},
		".denied-tiers":                  {"display: grid"},
		".access-exempt":                 {"var(--sub-bg)"},
		".access-exempt > .item + .item": {"border-top"},
	} {
		rule, ok := cssRule(css, sel)
		if !ok {
			t.Errorf("style.css 缺 %s 规则", sel)
			continue
		}
		for _, f := range frags {
			if !strings.Contains(rule, f) {
				t.Errorf("%s 缺 %q（应复用既有令牌）", sel, f)
			}
		}
	}
}

// 三层权限的 UI 表达：角色层级图例（root/平台/项目/普通 + 任命边界）、任命入口
// 按授予者能力禁用并解释（只有根管理员能任命平台管理员）、越权拒绝走拒绝分级
// 面板（reportDenial），根管理员在列表里有独立徽标。
func TestRoleHierarchyAppointmentGating(t *testing.T) {
	raw, err := files.ReadFile("templates/admin-users.html")
	if err != nil {
		t.Fatalf("读 admin-users 模板: %v", err)
	}
	tpl := string(raw)
	for _, want := range []string{
		`id="role-ladder"`, // 角色层级图例
		"任命平台管理员",          // root 层的任命能力
		"任命项目管理员",          // 平台管理员层的任命能力
		"不参与任命",            // 项目管理员层的边界
		"不能授予高于自己的角色",      // 逐级向下原则
		"禁用时会说明原因",         // 禁用 + 解释的承诺
	} {
		if !strings.Contains(tpl, want) {
			t.Errorf("admin-users.html 缺角色层级要素 %q", want)
		}
	}

	access, err := files.ReadFile("templates/admin-access.html")
	if err != nil {
		t.Fatalf("读 admin-access 模板: %v", err)
	}
	if !strings.Contains(string(access), "根管理员可任命平台管理员") {
		t.Error("项目访问页的访问模型说明应指到任命链路（根 → 平台 → 项目）")
	}

	jsBytes, err := files.ReadFile("app.js")
	if err != nil {
		t.Fatalf("读 app.js: %v", err)
	}
	js := string(jsBytes)
	for _, want := range []string{
		"function isRootViewer()",  // 根判定读 /web/session.isRoot，不再硬编码 uid
		"window.__isRoot === true", // 拿不到 isRoot 时按非根保守处理
		"window.__isRoot = me.isRoot === true",
		"${u.isRoot",                            // 列表根徽标走服务端逐行 isRoot
		"const isRootTarget = !!d.isRoot",       // 详情锁定目标走服务端 isRoot
		"async function viewerUid()",            // 竞态兜底：详情打开前确保拿到当前 uid
		"function reportDenial(",                // 越权拒绝 → 分级面板的统一出口
		"reportDenial('#users-denied'",          // 用户页写操作
		"reportDenial('#access-denied'",         // 项目访问写操作
		"reportDenial('#sess-denied'",           // 会话退出写操作
		"平台管理员的角色只有根管理员能任命或回收",                  // 锁死目标的解释
		"只有根管理员能任命/回收平台管理员",                     // 非根视角的解释
		"根管理员账号只有本人能调整",                         // 目标是根时的解释
		`${canAppointSuper ? '' : ' disabled'}`, // 平台管理员选项按能力禁用
		`title="唯一的平台管理员任命者"`,                   // 列表根徽标
		"不跨项目",                                  // 项目管理员的授权边界
	} {
		if !strings.Contains(js, want) {
			t.Errorf("app.js 缺角色任命结构 %q", want)
		}
	}
	if strings.Contains(js, "ROOT_UID") || strings.Contains(js, "5939716") {
		t.Error("app.js 不该再硬编码根管理员 uid（改读 /web/session.isRoot）")
	}
}

// ================= 提交前审计补的钉子（2026-11） =================

// hostile 是「转义漏一处就会执行」的载荷：先闭合当前属性/文本节点，再挂脚本。
// 它同时充当 URL 载荷（javascript:）与文本载荷。
const hostilePayload = `"><script>alert(1)</script>`
const hostileHref = `javascript:alert(1)`

// 用户可控字段进模板的每条路都要过 html/template 的上下文转义：邮箱、昵称、
// 越权项目名、拒绝原因、授权页的应用名/回跳域/错误文案、邀请页的邮箱与错误、
// 导航项的 href 与标签、项目切换器的标签。任何一处改回 text/template、包上
// template.HTML/URL，或者手工拼 HTML，这个用例先红。
//
// 断言分三层：
//  1. 载荷原文不出现（`<script>alert(1)</script>` / `"><script` / javascript: alert）；
//  2. 文本上下文出现转义形态 `&lt;script&gt;`；
//  3. URL 上下文出现 #ZgotmplZ（Go 对 javascript: 的过滤标记）——它出现才证明
//     href 走的是 URL 转义而不是被当成安全串直出。
func TestPagesEscapeHostileUserData(t *testing.T) {
	data := Data{
		Title:        "审计",
		Email:        hostilePayload + "@example.com",
		Nickname:     hostilePayload,
		DeniedApp:    hostilePayload,
		DeniedReason: hostilePayload,
		CurrentApp:   hostilePayload,
		Nav: []NavItem{{
			Href: hostileHref, Label: hostilePayload, Icon: "shield-check", Active: true,
		}},
		Apps: []AppChoice{{Key: "evil", Label: hostilePayload, Active: true}},
		OAuth: &OAuthView{
			Tx: hostilePayload, App: hostilePayload, AppName: hostilePayload,
			RedirectHost: hostilePayload, Email: hostilePayload,
			Scopes:     []string{hostilePayload},
			ErrorTitle: hostilePayload, ErrorMessage: hostilePayload,
		},
		Invite: &InviteView{
			Token: hostilePayload, Email: hostilePayload, App: hostilePayload,
			AppName: hostilePayload, Error: hostilePayload,
			ErrorTitle: hostilePayload, ErrorMessage: hostilePayload,
		},
		PasswordSetup: &PasswordSetupView{
			Token: hostilePayload, Email: hostilePayload, Error: hostilePayload,
			ErrorTitle: hostilePayload, ErrorMessage: hostilePayload,
		},
	}
	bad := []string{
		`<script>alert(1)</script>`,
		`"><script`,
		hostileHref,
	}
	for name := range pages {
		rec := httptest.NewRecorder()
		if err := Render(rec, name, data); err != nil {
			t.Errorf("渲染 %s: %v", name, err)
			continue
		}
		body := rec.Body.String()
		for _, b := range bad {
			if strings.Contains(body, b) {
				t.Errorf("%s 把未转义的用户数据写进了 HTML：%q", name, b)
			}
		}
		if !strings.Contains(body, "&lt;script&gt;") {
			t.Errorf("%s 未见任何转义后的文本载荷（&lt;script&gt;）——用户数据没被渲染？", name)
		}
		// 导航渲染在非 Minimal 壳里；login/denied/authorize 等 Minimal 页不渲染 nav，
		// 于是 URL 过滤标记只在有 nav 的页面上要求出现。
		if !strings.Contains(body, `class="skip"`) || !strings.Contains(body, `class="dock"`) {
			continue // Minimal 壳：没有导航，也就没有 href 载荷
		}
		if !strings.Contains(body, "#ZgotmplZ") {
			t.Errorf("%s 的 javascript: 导航 href 没被 URL 上下文过滤（缺 #ZgotmplZ）", name)
		}
	}
}

// 品牌 logo 是「新增 app 就得补一份资产」的硬约束：注册表里的每个 slug 都必须
// 能被 /brand/ 路由真的取到（授权页 <img src> 与邮件 <img src> 都指它），
// 且扩展名对应的 Content-Type 正确。缺一份的表现是 consent 页与所有邮件裂图，
// 而且是线上才看得见——这里在编译期资产表上就挡下来。
func TestEveryKnownAppHasBrandAssets(t *testing.T) {
	pngMagic := []byte("\x89PNG\r\n\x1a\n")
	slugs := make([]string, 0, len(knownApps)+1)
	for _, a := range knownApps {
		slugs = append(slugs, a.key)
		want := "/brand/" + a.key + "-v1.png"
		if siteLogoApps[a.key] {
			want = "/brand/" + a.key + "-site.png"
			site, ctype, ok := BrandStatic(a.key + "-site.png")
			if !ok || ctype != "image/png" || !bytes.HasPrefix(site, pngMagic) {
				t.Errorf("%s 的站点 icon 资产缺失或不是 PNG", a.key)
			}
		}
		if got := appLogoPath(a.key); got != want {
			t.Errorf("appLogoPath(%q) 应为 %q，得到 %q", a.key, want, got)
		}
	}
	slugs = append(slugs, "auth") // 账号级邮件（重置/注销/改绑）的中性品牌
	for _, slug := range slugs {
		png, ctype, ok := BrandStatic(slug + "-v1.png")
		if !ok {
			t.Errorf("缺品牌资产 %s-v1.png（跑 go run ./scripts/genicons 重生）", slug)
			continue
		}
		if ctype != "image/png" {
			t.Errorf("%s-v1.png 的 Content-Type 应为 image/png，得到 %q", slug, ctype)
		}
		if !bytes.HasPrefix(png, pngMagic) {
			t.Errorf("%s-v1.png 不是 PNG（前 8 字节不是魔数）", slug)
		}
		svg, sctype, ok := BrandStatic(slug + ".svg")
		if !ok {
			t.Errorf("缺品牌矢量源 %s.svg", slug)
			continue
		}
		if sctype != "image/svg+xml; charset=utf-8" {
			t.Errorf("%s.svg 的 Content-Type 应为 image/svg+xml; charset=utf-8，得到 %q", slug, sctype)
		}
		if !bytes.Contains(svg, []byte("<svg")) {
			t.Errorf("%s.svg 不是 SVG 文档", slug)
		}
	}
	// 未知名字必须回 false（路由层据此 404，而不是回空 200）
	if _, _, ok := BrandStatic("../../etc/passwd"); ok {
		t.Error("BrandStatic 不该接受名单外的文件名")
	}
	// 站点静态资产（CSS/JS/图标）逐个可挂载，且 app.css 的内容就是 style.css
	if css, ctype, ok := Static("app.css"); !ok || ctype != "text/css; charset=utf-8" || len(css) == 0 {
		t.Errorf("Static(app.css) 应返回样式与 CSS Content-Type，得到 ok=%v type=%q len=%d", ok, ctype, len(css))
	}
}

// app.js 里的登录回跳闸门必须以**浏览器解析结果**为准，不能退回字符串前缀判据：
// `^\/(?![\/\\])` 放得过 `/%09/evil.com` —— URL 解析器会把 TAB 删掉，结果是
// `//evil.com`（协议相对，直接跳外站）。这里钉住三条不变量：
//  1. 用 new URL(raw, location.origin) 解析；
//  2. 与 location.origin 逐字比对；
//  3. 回传的是解析后的 pathname+search+hash，不是原始串。
//
// 注：CI 里没有 JS 运行时，所以这条按「实现机制」而非行为表来钉——机制对了，
// 所有编码/规范化绕过（TAB、换行、反斜杠、userinfo）都随之关闭。
func TestLoginNextUsesURLParserNotStringPrefix(t *testing.T) {
	jsBytes, err := files.ReadFile("app.js")
	if err != nil {
		t.Fatalf("读 app.js: %v", err)
	}
	js := string(jsBytes)
	start := strings.Index(js, "function safeNext(raw)")
	if start < 0 {
		t.Fatal("app.js 缺 safeNext（登录 next 的开放重定向闸门）")
	}
	end := strings.Index(js[start:], "const nextPath")
	if end < 0 {
		end = len(js) - start
	}
	body := js[start : start+end]
	for _, want := range []string{
		"new URL(raw, location.origin)",
		"u.origin !== location.origin",
		"u.username || u.password",
		"return u.pathname + u.search + u.hash",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("safeNext 缺 %q（必须以解析后的 origin 为准）", want)
		}
	}
	if strings.Contains(body, `(?![\/\\])`) || strings.Contains(body, `return raw`) {
		t.Error("safeNext 退回了字符串前缀判据（漏 TAB/换行规范化绕过，见 CWE-601）")
	}
}

// 零 JS 表单的防重复提交会在 submit 时禁用被点的按钮。带 name 的按钮（授权页的
// decision=allow/deny）必须**先把 name/value 抄进隐藏域**再禁用：表单条目表在
// submit 事件之后构造，被禁用的按钮不再算成功控件，decision 会整个丢掉，服务端
// 把「没有 decision」一律当拒绝——点「继续授权」会静默变成 access_denied。
func TestNamedSubmitButtonValuePreserved(t *testing.T) {
	raw, err := files.ReadFile("templates/authorize.html")
	if err != nil {
		t.Fatalf("读 authorize 模板: %v", err)
	}
	tpl := string(raw)
	if !strings.Contains(tpl, `name="decision" value="allow"`) ||
		!strings.Contains(tpl, `name="decision" value="deny"`) {
		t.Fatal("authorize 模板应以 name=decision 的双按钮提交（allow/deny）")
	}

	jsBytes, err := files.ReadFile("app.js")
	if err != nil {
		t.Fatalf("读 app.js: %v", err)
	}
	js := string(jsBytes)
	start := strings.Index(js, `$$('form[method=post]')`)
	if start < 0 {
		t.Fatal("app.js 缺零 JS 表单的防重复提交处理器")
	}
	end := strings.Index(js[start:], "initAppSwitch()")
	if end < 0 {
		t.Fatal("找不到表单处理器的结尾（initAppSwitch 之前）")
	}
	body := js[start : start+end]
	keep := strings.Index(body, "keep.name = b.name")
	disable := strings.Index(body, "b.disabled = true")
	if keep < 0 || disable < 0 || keep > disable {
		t.Errorf("表单处理器必须先把按钮的 name/value 抄进隐藏域再禁用（keep=%d disable=%d）", keep, disable)
	}
	for _, want := range []string{
		"keep.type = 'hidden'", "keep.name = b.name", "keep.value = b.value",
		"f.appendChild(keep)",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("表单处理器缺 %q（decision 会丢）", want)
		}
	}
}

// ================= 2026-11 契约接线：Web 会话轮换 / 项目 admins =================

func issueHas(issues []string, sub string) bool {
	for _, s := range issues {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

// refreshWiringIssues 返回会话轮换接线的缺项。用纯函数是为了能做变异检验：
// 把 30 分钟改成 1 分钟、删掉单飞后，同一套判据必须报错。
func refreshWiringIssues(js string) []string {
	var issues []string
	add := func(ok bool, why string) {
		if !ok {
			issues = append(issues, why)
		}
	}
	i := strings.Index(js, "function rotateWebSession()")
	j := strings.Index(js, "function stopSessionRefresh()")
	add(i >= 0 && j > i, "single-flight: rotateWebSession/stopSessionRefresh 缺失")
	var rotate string
	if i >= 0 && j > i {
		rotate = js[i:j]
	}
	add(strings.Contains(rotate, "'/web/session/refresh'"), "endpoint: 未打刷新端点")
	add(strings.Contains(rotate, "noReauth: true"), "401: 不该弹重新验证框，交给 api() 既有登出")
	add(strings.Contains(rotate, "if (refreshInflight) return refreshInflight;"), "single-flight: 未复用在途请求")
	add(strings.Contains(rotate, ".finally(() => { refreshInflight = null; });"), "single-flight: 未释放在途槽")
	add(strings.Contains(rotate, ".catch(() => null)"), "silent: 409/断网失败未静默")

	k := strings.Index(js, "function startSessionRefresh()")
	l := strings.Index(js, "/* ---------- 应用注册表")
	add(k >= 0 && l > k, "trigger: startSessionRefresh 缺失")
	var starter string
	if k >= 0 && l > k {
		starter = js[k:l]
	}
	add(strings.Contains(starter, "void rotateWebSession();"), "trigger: 缺登录后立即一次")
	add(strings.Contains(starter, "setInterval(() => void rotateWebSession(), 30 * 60 * 1000)"),
		"30 分钟: 定时周期被改动或删除")
	add(strings.Contains(starter, "visibilitychange") && strings.Contains(starter, "if (!document.hidden)"),
		"trigger: 缺从隐藏变可见时触发")
	add(strings.Contains(js, "if ($('.topbar')) startSessionRefresh();"), "trigger: 极简壳不该轮换")
	add(strings.Count(js, "stopSessionRefresh(); await api('/web/logout'") >= 3,
		"logout: 三处登出都要先停轮换，防 Set-Cookie 回灌")
	return issues
}

func TestWebSessionRefreshRotationWiring(t *testing.T) {
	js := mustJS(t)
	if issues := refreshWiringIssues(js); len(issues) > 0 {
		for _, issue := range issues {
			t.Error(issue)
		}
	}
	// 变异检验：判据必须能咬住「周期改短」和「去掉单飞」两种回归。
	mutated := strings.Replace(js, "30 * 60 * 1000", "60 * 1000", 1)
	if !issueHas(refreshWiringIssues(mutated), "30 分钟") {
		t.Error("变异检验失效：把轮换周期改成 1 分钟竟没被钉住")
	}
	mutated = strings.Replace(js, "if (refreshInflight) return refreshInflight;", "", 1)
	if !issueHas(refreshWiringIssues(mutated), "single-flight") {
		t.Error("变异检验失效：删掉单飞竟没被钉住")
	}
}

// 项目卡用一份统一成员列表：项目管理员与登录名单合并展示，管理员行可被平台管理员
// 移除（走 /admin/roles/{uid}/scope），名单成员行走项目 access 端点；app-admin 不出现
// 移除管理员的按钮。
func TestAdminProjectMembersInlineRevoke(t *testing.T) {
	js := mustJS(t)
	card := jsBlock(t, js, "function cardOf(p)", "/* ---- 添加成员")
	for _, want := range []string{
		`data-people`, `peopleOf(p)`, `personRow`, `data-remove`,
		`/admin/roles/${person.uid}/scope`, `op: 'revoke'`,
		`fadeOutRow(row, () => load())`,
	} {
		if !strings.Contains(card, want) {
			t.Errorf("项目卡成员列表缺 %q", want)
		}
	}
	if !strings.Contains(card, "isAdmin && !IS_SUPER") {
		t.Error("移除项目管理员按钮只应给平台管理员")
	}
	// 管理员移除走角色 scope，登录名单移除走项目 access；两条路径不能串。
	rowBlock := jsBlock(t, js, "function personRow(person)", "function paintPeople()")
	if strings.Count(rowBlock, "/admin/roles/${person.uid}/scope") != 1 {
		t.Error("移除项目管理员应恰走一次 /admin/roles/{uid}/scope")
	}
	if strings.Count(rowBlock, "/admin/projects/${encodeURIComponent(p.app)}/access") != 1 {
		t.Error("移出登录名单应恰走一次项目 access 端点")
	}
}
