package auth

import (
	"bufio"
	"crypto/sha1"
	"encoding/hex"
	"net/http"
	"strings"
	"time"
)

// 密码泄露库校验（W10，Have I Been Pwned 的 k-Anonymity 协议）：
//
//	只把 SHA-1 的前 5 位十六进制发给 API（api.pwnedpasswords.com/range/XXXXX），
//	服务端返回该前缀下所有后缀与出现次数；本地比对完整 hash。密码本体与其完整
//	hash 都不出网，这是 HIBP 官方推荐的集成方式（NIST SP 800-63B §5.1.1.2 的
//	「比对已泄露口令」要求）。
//
// 三条口径：
//   - **只在设置/修改密码时查**（注册、找回、改密、接受邀请），登录不查；
//   - **失败开放**：网络错误/超时/非 200 一律放行（不能因为第三方不可用把所有人
//     锁在门外），但服务端仍会按本地强度规则校验；
//   - 配置中心 password_breach_check=0/off 关闭；未配置时生产默认开启，测试
//     （未注入 cfg）默认关闭——不让单测打外网。
const breachTimeout = 2 * time.Second

// breachRangeURL 可被测试替换（指向 httptest 服务）。
var breachRangeURL = "https://api.pwnedpasswords.com/range/"

// breachHTTPClient 可被测试替换（指向本地 httptest 服务）。
var breachHTTPClient = &http.Client{Timeout: breachTimeout}

// breachedPassword 查询密码是否出现在已知泄露库。第二返回值 ok=false 表示
// 「查不了」（网络/解析失败），调用方按失败开放处理。
func breachedPassword(password string) (hit bool, ok bool) {
	sum := sha1.Sum([]byte(password))
	full := strings.ToUpper(hex.EncodeToString(sum[:]))
	req, err := http.NewRequest(http.MethodGet, breachRangeURL+full[:5], nil)
	if err != nil {
		return false, false
	}
	req.Header.Set("Add-Padding", "true") // 填充响应长度，防流量分析
	req.Header.Set("User-Agent", "Auth-password-check")
	res, err := breachHTTPClient.Do(req)
	if err != nil {
		return false, false
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return false, false
	}
	suffix := full[5:]
	sc := bufio.NewScanner(res.Body)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(parts[0]), suffix) {
			return true, true
		}
	}
	if err := sc.Err(); err != nil {
		return false, false
	}
	return false, true
}

// breachCheckEnabled 读配置开关：未注入 cfg（单测/未接线）时不查；显式关闭才关。
func (s *Service) breachCheckEnabled() bool {
	if s.cfg == nil {
		return false
	}
	raw, err := s.cfg("password_breach_check")
	if err != nil {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "0", "off", "false", "no":
		return false
	default:
		return true
	}
}

// rejectBreached 是设置密码路径的统一收口：命中泄露库回 400 + 可执行文案；
// 查询失败开放（只留日志由调用方决定，不额外引入日志噪音）。最多 2 秒，
// 放在验证码校验之前，避免白烧一次码的试错次数。
func (s *Service) rejectBreached(password string) error {
	if !s.breachCheckEnabled() {
		return nil
	}
	hit, ok := breachedPassword(password)
	if ok && hit {
		return badRequest("该密码已在公开泄露库中出现，请换一个未用过的密码")
	}
	return nil
}
