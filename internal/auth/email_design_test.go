package auth

// 邮件模板的**设计契约**测试（2026-11 重写版）：把重写时逐条论证过的行为面钉成
// 断言——验证码不进主题与预览行、安全警报零链接、HTML 的每个 href 在纯文本部件
// 都有降级 URL、正文链接不带统计参数（token 不进统计口径）、每封信都有预览行。
// 结构与品牌面的钉子在 brand_test / otp_test / loginnotify_test。

import (
	"html"
	"regexp"
	"strings"
	"testing"
	"time"
)

// designMails 是全模板清单（含邀请信），供设计契约逐封跑。
func designMails(b brand) map[string]func() (string, string, string) {
	at := time.Unix(1761000000, 0)
	const cancelURL = "https://auth.horatio.cn/web/delete-cancel?token=abc123"
	return map[string]func() (string, string, string){
		"验证码": func() (string, string, string) { return codeEmail(b, "注册", "123456") },
		"改绑新邮箱": func() (string, string, string) {
			return changeEmailNoticeEmail(b, true, "old@example.com", "new@example.com")
		},
		"改绑旧邮箱": func() (string, string, string) {
			return changeEmailNoticeEmail(b, false, "old@example.com", "new@example.com")
		},
		"管理员改邮新": func() (string, string, string) {
			return adminChangeEmailNoticeEmail(b, true, "old@example.com", "new@example.com")
		},
		"管理员改邮旧": func() (string, string, string) {
			return adminChangeEmailNoticeEmail(b, false, "old@example.com", "new@example.com")
		},
		"管理员重置": func() (string, string, string) {
			return passwordResetNoticeEmail(b, siteBase+"/web/setup-password?token=abc")
		},
		"改密确认":  func() (string, string, string) { return passwordChangedNoticeEmail(b, at) },
		"注销确认":  func() (string, string, string) { return deleteRequestEmail(b, cancelURL, at) },
		"注销撤销":  func() (string, string, string) { return deleteCancelledEmail(b) },
		"注销完成":  func() (string, string, string) { return deleteDoneEmail(b) },
		"新登录提醒": func() (string, string, string) { return loginNotifyEmail(b, "Pixel 8", "热量日记", at) },
		"邀请": func() (string, string, string) {
			return inviteEmail(b, siteBase+"/web/invite?token=abc", "admin@example.com", at)
		},
	}
}

// preheaderIn 抠出隐藏预览行的可见文本（mso-hide:all 的隐藏 div 内、零宽填充前）。
func preheaderIn(t *testing.T, htmlBody string) string {
	t.Helper()
	m := regexp.MustCompile(`mso-hide:all;">([^<]*)`).FindStringSubmatch(htmlBody)
	if m == nil {
		t.Fatal("正文缺隐藏预览行")
	}
	return strings.Split(m[1], "&#8199;")[0]
}

// hrefRe 抠出 HTML 部件里的全部链接地址。
var hrefRe = regexp.MustCompile(`href="([^"]+)"`)

// 验证码只进正文：主题与收件箱预览行都不得带码（锁屏/通知预览会露出主题与预览，
// 带外凭据不该在未解锁设备上出现），纯文本部件必须能抄到码。
func TestCodeEmailKeepsCodeOutOfSubjectAndPreheader(t *testing.T) {
	for _, app := range []string{"CalorieDiary", "ExpenseDiary", ""} {
		b := brandFor(app)
		subject, htmlBody, text := codeEmail(b, "注册", "123456")
		if strings.Contains(subject, "123456") {
			t.Errorf("app=%q 主题不该带验证码: %q", app, subject)
		}
		pre := preheaderIn(t, htmlBody)
		if strings.Contains(pre, "123456") {
			t.Errorf("app=%q 预览行不该带验证码: %q", app, pre)
		}
		// 预览行与正文同源：写时效就得和码卡里的口径一致
		if !strings.Contains(pre, "5 分钟内有效") || !strings.Contains(pre, "检查垃圾邮件") {
			t.Errorf("app=%q 预览行应给时效与垃圾箱指引，得到 %q", app, pre)
		}
		if !strings.Contains(text, "123456") {
			t.Errorf("app=%q 纯文本部件缺验证码", app)
		}
	}
}

// 纯安全警报零链接：改绑旧邮箱、管理员改邮旧邮箱、注销完成三封正文里不许有可点
// 锚点（警报信挂按钮只给钓鱼信递刀），纯文本部件也不给任何 URL。
func TestSecurityAlertEmailsCarryZeroLinks(t *testing.T) {
	b := brandFor("")
	mails := map[string]func() (string, string, string){
		"改绑旧邮箱": func() (string, string, string) {
			return changeEmailNoticeEmail(b, false, "old@example.com", "new@example.com")
		},
		"管理员改邮旧": func() (string, string, string) {
			return adminChangeEmailNoticeEmail(b, false, "old@example.com", "new@example.com")
		},
		"注销完成": func() (string, string, string) { return deleteDoneEmail(b) },
	}
	for name, build := range mails {
		_, htmlBody, text := build()
		if strings.Contains(htmlBody, "<a href") {
			t.Errorf("%s 是零链接安全警报，HTML 却带了锚点", name)
		}
		if strings.Contains(text, "http") {
			t.Errorf("%s 是零链接安全警报，纯文本却带了 URL", name)
		}
	}
}

// HTML 里的每个 href 在纯文本部件都有完整 URL（降级 URL 的家），且都不带统计参数
// ——安全信的 token 链接不进 UTM/跟踪口径：跟踪域会被网关预点、烧掉一次性链接，
// 还破坏「悬停核对 URL」的反钓鱼训练。
func TestEveryHTMLLinkFallsBackToTextWithoutTracking(t *testing.T) {
	for _, app := range []string{"CalorieDiary", "ExpenseDiary", ""} {
		b := brandFor(app)
		for name, build := range designMails(b) {
			_, htmlBody, text := build()
			for _, hit := range hrefRe.FindAllStringSubmatch(htmlBody, -1) {
				u := html.UnescapeString(hit[1])
				if strings.Contains(u, "utm_") || strings.Contains(u, "/wf/click") {
					t.Errorf("app=%q 的%s链接带统计/跟踪参数: %s", app, name, u)
				}
				if !strings.Contains(text, u) {
					t.Errorf("app=%q 的%s纯文本缺降级 URL %s", app, name, u)
				}
			}
		}
	}
}

// 每个 style="…" 属性必须**完整闭合到尾分号**：style 里混进双引号（如字体名用
// 直引号）会让属性在第一个引号处被截断，后面的字号/颜色/边距全部静默丢失——
// 这是重写前存量邮件真实存在的形态，正则抠出的每个值都得以 ; 收尾才算没截。
func TestStyleAttributesAreWellFormed(t *testing.T) {
	styleRe := regexp.MustCompile(`style="([^"]*)"`)
	for _, app := range []string{"CalorieDiary", "ExpenseDiary", ""} {
		b := brandFor(app)
		for name, build := range designMails(b) {
			_, htmlBody, _ := build()
			for _, hit := range styleRe.FindAllStringSubmatch(htmlBody, -1) {
				if !strings.HasSuffix(hit[1], ";") {
					t.Errorf("app=%q 的%s有未闭合到分号的 style 属性（疑似被内部引号截断）: %q",
						app, name, hit[1])
				}
			}
			if strings.Contains(htmlBody, `"PingFang`) {
				t.Errorf("app=%q 的%s字体名不许用双引号（会截断 style 属性）", app, name)
			}
		}
	}
}

// 每封信都有收件箱预览行（与主题互补的时效/下一步），且不是主题的复读。
func TestEveryTemplateHasPreheader(t *testing.T) {
	b := brandFor("")
	for name, build := range designMails(b) {
		subject, htmlBody, _ := build()
		pre := preheaderIn(t, htmlBody)
		if strings.TrimSpace(pre) == "" {
			t.Errorf("%s 缺预览行", name)
			continue
		}
		if strings.TrimSpace(pre) == subject {
			t.Errorf("%s 预览行不该复读主题 %q", name, subject)
		}
	}
}
