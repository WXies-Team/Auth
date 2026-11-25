// Package geoip 把 IP 解析成「省 市」级归属地，用于会话/设备列表的「大致位置」。
//
// 数据是 **ip2region v3 的离线 xdb**（Apache-2.0 / MIT，中国数据精确到城市），
// 随二进制内嵌——本服务不向外发任何地理查询请求：IP 属于个人数据，会话页面每次
// 刷新都打第三方 API 既慢又把用户 IP 散给外部服务。查询走内存二分，10 微秒级。
//
// 双栈：v4 库 11 MB、v6 库 36 MB，都随二进制内嵌。按地址族各查各的库，
// 不拿 v4 段去凑 v6 地址。IPv4-mapped（::ffff:1.2.3.4）与 NAT64（64:ff9b::/96）
// 先还原成内嵌的 IPv4 再查——它们本质是 v4 目的地，直接丢给 v6 库只会查空。
//
// IPv6 的精度口径（2026-11 调研结论）：
//   - 地理库把位置挂在**前缀**上，不挂在单个接口地址上；同一 /64 内的隐私地址
//     （RFC 8981）会轮换主机位但仍在同一地点。本包因此以 /64 作为缓存键，
//     既减少重复查询，也不会因为主机位变化而得到前后矛盾的地区。
//   - /32、/48 是运营商/站点的分配粒度，城市级精度在 v6 上普遍弱于 v4；查不到或
//     只到国家时按「宁可少说」返回可用的最粗层级，不猜城市。
//   - 上游 ip2region README 明确说自带 ipv6_source 更新不规律，精度要求高时应
//     换商用离线数据（见 README 的选型说明）；本仓当前保持离线 + 内嵌，不改成
//     在线 API，也不引入 MaxMind/DB-IP 的账号与再分发义务。
//   - IPv6 前缀粒度与隐私地址的业界口径：APNIC《IPv6 prefix lengths》统计
//     /48、/56、/64 的分布（https://blog.apnic.net/2024/04/25/ipv6-prefix-lengths/）；
//     RFC 8981 隐私地址轮换主机位，RFC 8805 geofeed 以**前缀**发布位置；
//     MaxMind 也明确 IPv6 / 移动网络的 city 级精度显著弱于 IPv4
//     （https://support.maxmind.com/knowledge-base/articles/maxmind-geolocation-accuracy）。
//
// 数据更新：替换本目录的 ip2region_v4.xdb / ip2region_v6.xdb 后重新发版——和
// favicon/品牌图标同一套「资产随二进制走」的口径。上游：
// https://github.com/lionsoul2014/ip2region
package geoip

import (
	_ "embed"
	"net"
	"strings"
	"sync"

	"github.com/lionsoul2014/ip2region/binding/golang/xdb"
)

//go:embed ip2region_v4.xdb
var dbV4 []byte

//go:embed ip2region_v6.xdb
var dbV6 []byte

var (
	once sync.Once
	v4   *xdb.Searcher
	v6   *xdb.Searcher
)

// regionCacheMax 是「查询结果 → 地区」缓存的上限：会话列表一页最多百来行，
// 4096 条覆盖一个活跃站点的常见出口 IP/前缀绰绰有余，同时给内存一个硬上限。
const regionCacheMax = 4096

var (
	cacheMu    sync.Mutex
	regionMemo = map[string]string{}
	cacheOrder []string
)

// initSearchers 按地址族各建一个内存查询器（整库驻留，查询无磁盘 IO）。
// 任一族建失败就保持 nil——Region 返回空串，页面不显示归属地，绝不影响会话页本身。
func initSearchers() {
	if v, err := xdb.VersionFromName("v4"); err == nil {
		if s, err := xdb.NewWithBuffer(v, dbV4); err == nil {
			v4 = s
		}
	}
	if v, err := xdb.VersionFromName("v6"); err == nil {
		if s, err := xdb.NewWithBuffer(v, dbV6); err == nil {
			v6 = s
		}
	}
}

// Region 返回「省 市」形式的归属地（如「江苏 南京」）；查不到、内网地址或
// IP 非法时返回空串。调用方拿到空串就不渲染该段，不做任何猜测。
func Region(ip string) string {
	ip = strings.TrimSpace(ip)
	// IPv6 zone（fe80::1%eth0）不是地址的一部分；RemoveZone 解析失败时保留原串，
	// 后面的 ParseIP 会把它当非法地址返回空串。
	if i := strings.LastIndexByte(ip, '%'); i > 0 && strings.Contains(ip, ":") {
		ip = ip[:i]
	}
	if ip == "" {
		return ""
	}
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return ""
	}
	// 内网/回环/链路本地/未指定/组播/文档段：归属地无意义，硬查会给出误导性结果。
	// 2001:db8::/32 不是 IsPrivate，但同样不该渲染。
	if parsed.IsLoopback() || parsed.IsPrivate() || parsed.IsLinkLocalUnicast() ||
		parsed.IsUnspecified() || parsed.IsMulticast() || isDocumentationV6(parsed) {
		return ""
	}
	once.Do(initSearchers)

	lookup, key := lookupAddress(parsed)
	if lookup == nil {
		return ""
	}
	if got, ok := memoGet(key); ok {
		return got
	}
	searcher := v6
	if lookup.To4() != nil {
		searcher = v4
	}
	if searcher == nil {
		memoPut(key, "")
		return ""
	}
	raw, err := searcher.Search(lookup.String())
	if err != nil || raw == "" {
		memoPut(key, "")
		return ""
	}
	out := formatRegion(raw)
	memoPut(key, out)
	return out
}

// lookupAddress 把地址归一成「查库用的 IP + 缓存键」：
//
//	IPv4（含 ::ffff: 映射）→ 原 v4 地址，键 = 完整 v4
//	NAT64 64:ff9b::/96     → 取出末 4 字节还原 v4，键 = 完整 v4
//	原生 IPv6              → 原地址，键 = /64 前缀（隐私地址同一前缀共用结果）
func lookupAddress(parsed net.IP) (net.IP, string) {
	if v4 := parsed.To4(); v4 != nil {
		return v4, v4.String()
	}
	if isNAT64(parsed) {
		v4 := net.IPv4(parsed[12], parsed[13], parsed[14], parsed[15])
		return v4, v4.String()
	}
	mask := net.CIDRMask(64, 128)
	return parsed, parsed.Mask(mask).String() + "/64"
}

// isNAT64 判定 64:ff9b::/96（RFC 6052 知名前缀）：末 32 位是内嵌的 IPv4。
func isNAT64(ip net.IP) bool {
	if len(ip) != net.IPv6len {
		return false
	}
	for i := 0; i < 12; i++ {
		var want byte
		switch i {
		case 0:
			want = 0x00
		case 1:
			want = 0x64
		case 2:
			want = 0xff
		case 3:
			want = 0x9b
		default:
			want = 0x00
		}
		if ip[i] != want {
			return false
		}
	}
	return true
}

// documentationV6 是 2001:db8::/32（RFC 3849，文档示例专用）。
var documentationV6 = mustCIDR("2001:db8::/32")

func isDocumentationV6(ip net.IP) bool { return documentationV6.Contains(ip) }

func mustCIDR(s string) *net.IPNet {
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		panic("geoip 内置 CIDR 非法: " + s)
	}
	return n
}

// memoGet / memoPut 是带上限的简单 FIFO 缓存（不引第三方 LRU）：命中即回，
// 满了淘汰最早写入的键。空结果也缓存——「这个内网段查不到」同样值得记住。
func memoGet(key string) (string, bool) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	v, ok := regionMemo[key]
	return v, ok
}

func memoPut(key, value string) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	if _, ok := regionMemo[key]; ok {
		regionMemo[key] = value
		return
	}
	if len(regionMemo) >= regionCacheMax && len(cacheOrder) > 0 {
		oldest := cacheOrder[0]
		cacheOrder = cacheOrder[1:]
		delete(regionMemo, oldest)
	}
	regionMemo[key] = value
	cacheOrder = append(cacheOrder, key)
}

// formatRegion 把 ip2region 的 `国家|省份|城市|ISP|ISO` 收成给人看的两段。
//
// 三条收敛规则，都是「宁可少说，不说错」：
//   - 「0」是上游的「无此项」占位，丢弃；
//   - 「Reserved」是保留段（TEST-NET 等）的占位词，同样丢弃——直接渲染会得到
//     「Reserved Reserved」这种比不显示更糟的结果（实测 192.0.2.1 就是这样）；
//   - 国内地址省掉「中国」前缀，且相邻重复项（直辖市常见的 北京市|北京市）只留一份。
func formatRegion(raw string) string {
	fields := strings.Split(raw, "|")
	get := func(i int) string {
		if i >= len(fields) {
			return ""
		}
		v := strings.TrimSpace(fields[i])
		if v == "0" || strings.EqualFold(v, "reserved") {
			return ""
		}
		return v
	}
	country, province, city := get(0), get(1), get(2)

	parts := make([]string, 0, 3)
	if country != "" && country != "中国" && country != "China" {
		parts = append(parts, country)
	}
	for _, v := range []string{province, city} {
		if v == "" {
			continue
		}
		if len(parts) > 0 && parts[len(parts)-1] == v {
			continue // 相邻重名（北京市|北京市）只留一份
		}
		parts = append(parts, v)
	}
	return strings.Join(parts, " ")
}

// RegionCacheKey 给调用方/测试一个稳定的归一化视图（不参与业务判定）：
// IPv4 返回完整地址，IPv6 返回 /64 前缀（NAT64 还原成 v4）。
func RegionCacheKey(ip string) string {
	ip = strings.TrimSpace(ip)
	if i := strings.LastIndexByte(ip, '%'); i > 0 && strings.Contains(ip, ":") {
		ip = ip[:i]
	}
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return ""
	}
	lookup, key := lookupAddress(parsed)
	if lookup == nil {
		return ""
	}
	return key
}
