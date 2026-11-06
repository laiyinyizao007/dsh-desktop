# DSH Web 加载性能：部署结构与维护说明

这份文档记录本机 DSH Web 的实际部署结构，以及各部分为什么这么改。
改动的目的是：让浏览器在网络上少拿字节、少发请求，同时不让服务端算一遍
用不上的东西。

## 链路

```
浏览器
  │
  ├─ http://100.86.255.34:43129   直连 Harness（保留给本机调试）
  │
  ├─ http://100.86.255.34:43128   nginx 入口 ← 推荐
  │      │
  │      ├─ /assets/*、/dsh-desktop-logo*.png、/favicon*.svg
  │      │     nginx 直接读文件，带 Brotli / gzip 预压缩变体，
  │      │     缓存头 immutable 一年
  │      │
  │      └─ 其它一切 → dsh-web-proxy :43131
  │                       └─ dsh web :43129
  │
  └─ https://dsh.averivendell.world  Cloudflare 隧道 → nginx :43128
```

## 边缘缓存：为什么 bundle URL 里有 `proxy=2`

Harness 用 `plugins/??<插件列表>&rev=<hash>` 广播它的插件图。`??` 会让 URL
解析器把后面的列表当成查询串，于是**路径只剩 `/plugins/`**——没有扩展名。

Cloudflare 按路径的扩展名决定缓存什么，所以这些 bundle 永远不会被缓存
（`cf-cache-status: DYNAMIC`）：每一次打开页面，3.9 MB 的插件代码都要从树莓派
穿过隧道回源一次。这就是冷启动 34 秒的原因。

代理把插件图里的 URL 改成：

```
plugins/<插件列表>.js?rev=<hash>&proxy=2
```

路径以 `.js` 结尾，Cloudflare 的默认规则就会缓存它
（`cf-cache-status: MISS` → `HIT`）。`rev` 仍然在 query 里，内容变了 URL 也会变。

要点：

- **两处都要改**：HTML 属性里是 `&amp;rev=`，而模块图 JSON 在 `<script>` 里
  （raw text，实体不解码），是 `&rev=`。只改一处，客户端会按模块图里的旧 URL
  把每个 bundle 再下载一遍。
- **还原要只带 `rev=`**：代理把请求转回 Harness 自己的形式时，多带一个
  `proxy=2` 会让 revision 对不上，bundle 就 404 了。
- **token 只对根页面有效**：把它加到 bundle 请求上会得到 404，而 404 是
  Cloudflare 愿意缓存的——所以错误响应一律带 `no-store`。
- 旧形式的请求会被 **302** 到可缓存的形式（`BUNDLE_URL_FORMAT` 这个常量就是
  URL 格式的版本号，改格式时 URL 会变，旧的缓存条目自然作废）。

## 各部分职责

| 组件 | 位置 | 职责 |
|---|---|---|
| nginx | `/etc/nginx/conf.d/dsh.conf` | 静态资源直吐、Brotli、HTTP/2、authority 归一化、计时日志 |
| dsh-web-proxy | `scripts/dsh-web-proxy.mjs`（仓库内） | 注入启动 token、缓存头、Cookie 过滤、插件图 URL 改写、会话列表裁剪 |
| 预压缩脚本 | `scripts/dsh-web-assets-precompress.mjs`（仓库内） | 生成 `.br` / `.gz` 变体 |
| 预热脚本 | `scripts/dsh-web-warm-cache.mjs`（仓库内） | 让边缘缓存提前持有所有 bundle |
| token 捕获脚本 | `scripts/dsh-web-capture-token.mjs`（仓库内） | 把启动 token 从日志复制到 `/var/lib/dsh-web/launch-token` |
| 冷加载探针 | `scripts/dsh-cold-load-probe.sh`（仓库内） | 测一次真实的冷加载，输出可对比的基线 |
| dsh web | `dsh-web.service` | 真正提供 API 与模块图 |

### 为什么 nginx 的 worker 跑在 `averypi` 而不是 `www-data`

静态资源在 `/home/averypi/dsh-desktop/node_modules/…` 下，而 `/home/averypi`
是 `0700`。用 `www-data` 就得给整条路径链加 ACL，而 `npm install` 升级依赖后
ACL 会失效、nginx 就会开始 403。改 `/etc/nginx/nginx.conf` 的 `user` 一行更稳。

### 为什么 nginx 要归一化 Host 和 Origin

Harness 把会话 Cookie 绑定到它看到的 authority，并拒绝 Origin 与之不符的
`/api` 请求。浏览器可以从公网域名、局域网 IP、手机桥三个入口进来，authority
各不相同。nginx 把它们统一成 Harness 自己的 authority（`100.86.255.34:43129`），
Cookie 就跨入口通用了。

> **坑**：nginx 的 `proxy_set_header` 一旦在 `location` 里出现任意一条，server
> 层里的**全部** `proxy_set_header` 都会被丢弃。丢了 `Host` 的话，Harness 会把
> Cookie 签成 upstream 组名（`dsh_harness_proxy`），于是所有 `/api` 请求 403。
> 所以 `location /` 里必须把每一条都写全。

### 为什么代理要过滤 Cookie

浏览器会同时持有多个 authority 的 Cookie（同域不同端口算同域）。Harness 只认
自己那个。代理会解出 Cookie payload 里的 authority，只转发匹配的那一个，不匹配
就连同 token 一起丢掉重新换取。

> **坑**：Cookie 值是 `v1.<base64 payload>.<签名>` 三段。解 payload 时只能取
> 第二段，整段一起解会把签名也算进 base64，导致 JSON 解析失败、每次都以为
> 「没有 Cookie」而重新注入 token —— 表现就是无限重定向。

## 可调参数（环境变量）

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_PROXY_SESSION_LIST_TRIM` | `1` | 是否裁剪会话列表；设 `0` 恢复原样 |
| `DSH_PROXY_SESSION_LIST_HEADERS` | `1` | 保留几条 `contextHeaders` 快照；`0` = 全删 |
| `DSH_PROXY_SESSION_LIST_CACHE_MS` | `1000` | 会话列表缓存时长；`0` = 每次重算 |

代理的 systemd drop-in 在 `/etc/systemd/system/dsh-web-proxy.service.d/`。

## 会话列表为什么要裁剪

`session/list` 会返回全部会话，每个会话带一整块投影数据。其中 `contextHeaders`
（每个会话在每一轮对话时发给模型的工具定义快照）占了 **87%**。侧边栏列会话只需要
标题和时间。

客户端依赖分析结果（`dsh-client-ui-sidebar` / `dsh-better-sidebar` / `dsh-cost-meter`
等）：

- **保留**：`title`、`subagent`、`plan`、`goal`、`agentPreset`、`userQuestions`、
  `todos`、`inbox`、`costUsage`、`contextTimeline`、`contextPressure`、
  `contextBreakdown`、`workingDirectory`
- **丢弃**：`turnOutline`、`tokenUsage`、`sessionStats`、`contextActivity`、
  `subagentTiming`、`subagentCatalog`、`permissions`、`modelSelection`、
  `imageLimits`、`sessionListMetadata`
- **只留最新一条**：`contextHeaders` —— 最新一条就是「当前上下文」，
  `dsh-context` 插件的上下文洞察面板仍能正确显示工具清单，只失去历史趋势

效果：线缆从 329 KB 降到 59 KB。

## 2026-11-06：公网域名「超级慢」的根因与修复

一次「整站打开要一两分钟」的排查，结论有两条，都不是浏览器的问题。

### 根因一：树莓派到 Cloudflare 的 TCP 拥塞窗口塌缩

`ss -ti` 看隧道 socket：

```
cubic wscale:13,7 rto:360 rtt:156.726 mss:1388 cwnd:7 ssthresh:4
  bytes_sent:14392323 bytes_retrans:630577
  pacing_rate 595136bps delivery_rate 301040bps
  reord_seen:26 dsack_dups:150
```

`cwnd` 只有 7 个报文段，`delivery_rate` 约 30 KB/s，重传 4.4%。**按 `cwnd × mss / rtt`
算出来的带宽和 `delivery_rate` 完全吻合**——瓶颈就是拥塞窗口本身，不是链路带宽，
也不是请求条数（30 个并发请求走隧道总墙钟 2.88 秒，隧道是多路复用的）。

链路上有乱序（`reord_seen`、`dsack_dups`），cubic 把乱序丢包当成拥塞，把窗口压到个
位数，于是**3.5 MB 的插件图按 25 KB/s 要走 140 秒**。

内核当时跑的是 `cubic`——`/etc/sysctl.conf` 里虽然写着 `tcp_congestion_control=bbr`，
但 **`tcp_bbr` 模块从来没被加载**，所以那行配置一直没生效；而
`net.core.rmem_max` / `wmem_max` 是内核默认值 208 KB，`tcp_rmem` 的上限被它卡住，
socket 缓冲始终只有 208 KB。

修复（`/etc/sysctl.d/99-dsh-tunnel.conf` + `/etc/modules-load.d/tcp-bbr.conf`）：

```
net.ipv4.tcp_congestion_control = bbr      # 按带宽×RTT 发送，对乱序导致的伪丢包免疫
net.core.default_qdisc = fq
net.core.rmem_max = 16777216               # 这两项才是真正的上限
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 67108864
net.ipv4.tcp_wmem = 4096 65536 67108864
net.ipv4.tcp_slow_start_after_idle = 0      # 隧道空闲后不必重新慢启动
net.ipv4.tcp_mtu_probing = 1
```

改完要 `systemctl restart cloudflared-dsh`——**拥塞控制算法只在建连时选定**，
旧连接不会自己换。

效果（同一台机器实测）：

| | 修复前 | 修复后 |
|---|---|---|
| 拥塞控制 | `cubic` | `bbr` |
| `cwnd` | 2–7 段 | **297** |
| `delivery_rate` | 15–38 KB/s | **7.19 Mbps ≈ 899 KB/s** |
| 重传率 | 4–16% | **0.76%** |

回滚：`sysctl -w net.ipv4.tcp_congestion_control=cubic`，删掉那个 sysctl 文件。

> **这张表测的是 `protocol: http2` 时的 TCP 隧道。** 后来的 QUIC 改动把这条链路
> 换成了 UDP（见下文「顺手调的两处隧道参数」），QUIC 的拥塞控制在用户态
> （quiche），不再走内核的 `tcp_congestion_control`——所以现在 `ss -ti` 里已经
> 看不到这条隧道了。BBR 这一组 sysctl 仍然留着：它对本机另外两条 TCP 隧道
> （`pi-github-sync`、`claude-webui`）有效，也保证将来把 DSH 隧道切回 http2 时
> 不会再塌回去。

### 根因二：边缘缓存从 11-04 20:18 起就没被填过

链路是 `nginx:43128 → proxy:43131 → dsh web:43129`，而 **Harness 只监听
`100.86.255.34:43129`**（不监听 `127.0.0.1`，写错就是 502）。

代理靠**日志里那一行启动 URL** 里的 launch token 来给匿名访客换取会话。
11-05 00:35 logrotate 的 `copytruncate` 把 `/var/log/dsh-web.log` 清空了，那一行
token 就此消失。后果：

- 新浏览器 → `401 dsh web authentication required`；`/healthz` 恒 503。
- **还在用的人完全不受影响**——浏览器里留着旧的会话 cookie。于是站点「看起来是好的」，
  而其余人进不来。
- 预热脚本拿到 401 的根页面，解析出 **0 个 URL**，打印 `0 warmed, 0 failed` 后
  **正常退出 0**；unit 里还写着 `SuccessExitStatus=0`。这个静默失败让「边缘没缓存」
  这件事完全不可见。

修复分三处：

1. **代理不再用 `undefined` 覆盖已有的好 token**，并把 token 绑定到 Harness 身份
   （PID + 启动时间）：Harness 换了进程，旧 token 就是死的。
2. **token 另存一份**：`dsh-web-capture-token.mjs` 在每次 `dsh-web.service` 启动后
   （`ExecStartPost`）等 ≤30 秒读到 token 行，先**向 Harness 验证这个 token 还有效**，
   再原子写入 `/var/lib/dsh-web/launch-token`（`0600`）。代理在日志里找不到 token 时
   从这个文件取，但只在文件里记的 Harness 身份跟当前进程一致时才用。
   > 这次救回 token 靠的是轮转日志 `.1` 里那一行——**没有重启 Harness**，
   > 所以没有丢掉任何在跑的会话。
3. **预热不会再静默失败**：页面里没有 bundle 就 `exit 1`；unit 去掉了
   `SuccessExitStatus=0`；timer 从每天一次改成**每 10 分钟**一次，并且在
   `dsh-auto-restart.sh` 重启 Harness 之后立刻补一次（bundle 换了 revision 就等于
   换了 URL，边缘缓存当场作废）。

logrotate 保留（改成每周、保留 4 份）——它只清掉日志里那一行 token，token 现在
另有一份，这次轮转不再让公网地址变成 401。

### 顺手调的两处隧道参数

`~/.cloudflared/config-dsh.yml`：

- `protocol: http2` → **`quic`**。这条链路会乱序，TCP 上丢一个包后面全堵着；
  QUIC 是按流恢复的。实测一次回源（缓存 MISS）的吞吐从 78 KB/s 升到 150–280 KB/s，
  已经和「直接从边缘取」的速率持平——**隧道不再是慢的那一段**。
- `originRequest.keepAliveConnections: 4` → `100`（默认值；4 是过度收紧）。
- `region` 试过 `weu`，**不存在**：只有 `us` 一条 SRV 记录可解析，所以隧道落在
  LAX 是没法选的。

### 可观测性

- nginx 新增 `log_format dsh_timing`（`$request_time` / `$upstream_response_time` /
  `$upstream_connect_time` / `$upstream_status` / `$bytes_sent` / `$http_cf_ray` /
  `$request_uri`），DSH 站点写 `/var/log/nginx/dsh_timing.log`；`/assets/` 仍然
  `access_log off`。**`$remote_addr` 在这里永远是 127.0.0.1**（隧道从本机连进来），
  跟边缘对账要靠 `$http_cf_ray`。
- `scripts/dsh-cold-load-probe.sh` —— 模拟一次冷启动，逐条打印 `cf-cache-status`、
  字节数和 TTFB，最后汇总总时长与总字节，作为回归基线。
  > bundle 的并发请求各自**只读**一份 cookie jar 的副本。共用一个 jar 会让 11 个
  > 并发 curl 同时改写同一个文件，回源型请求（要校验 cookie 的）就会偶发 401 ——
  > 走边缘缓存时看不出来，因为边缘直接返回，根本不到源站。

### 轮询频率

`/__volt` 的电源徽标从每 5 秒改成**每 30 秒**（和已有的 restart-notice 同样处理：
这个变化没人能比 30 秒更快地响应），并去掉了 `cache: 'no-store'`。

代理给四个纯只读的 GET 接口加上
`Cache-Control: public, max-age=5, stale-while-revalidate=60`：
`/__volt`、`/api/desktop-workbenches/restart-status`、
`/api/desktop-workbenches/market-installs`、`/plugins/dsh-agent-teams/state`。

> **注意**：Cloudflare **默认不缓存**这些路径——它们没有可缓存的扩展名，源站给的
> `Cache-Control` 不足以让边缘收下，实测仍是 `cf-cache-status: DYNAMIC`。
> 要让它们真正出隧道，需要在 Cloudflare 控制台给这四条路径建一条
> **Cache Rule → Cache Everything**（本机没有 zone 级 API token，只能手工建：
> `~/.cloudflared/cert.pem` 里的 Argo tunnel token 调 `/zones/<id>/rulesets` 返回
> **403 Authentication error**，它只有 tunnel/DNS 权限）。
>
> 这几个接口的内容不敏感（电源状态、重启状态、agent 状态、市场目录），
> 边缘缓存会忽略 Cookie，等于**这些响应对任何知道域名的人可见**——站点本身
> 对知道域名的人就是开放的，2026-11-06 已确认**不加访问闸门**。

### 2026-11-06 补记：边缘缓存规则的实测结果

**怎么量才量得到真话**：这四条路径里，除根页面外**没有会话一律 401**
（代理的认证闸门）。而 `curl -sI` 不带 cookie，所以量到的是 401 那条分支——
`cache-control: no-store`、`cf-cache-status: DYNAMIC`，**看起来像「没缓存」，
其实连业务响应都没拿到**。要量真实行为必须带会话 cookie：

```bash
curl -sSL -o /dev/null -c /tmp/jar -b /tmp/jar https://dsh.averivendell.world/
curl -s -o /dev/null -D - -b /tmp/jar https://dsh.averivendell.world/__volt \
  | grep -iE '^HTTP|^cf-cache-status|^age:|^cache-control'
```

**最终生效的规则**（zone `averivendell.world`，ruleset
`479bd0be9291452aab1b7958515ea1d4`，phase `http_request_cache_settings`）：

```
expression: (http.host eq "dsh.averivendell.world"
             and http.request.method in {"GET" "HEAD"}
             and http.request.uri.path in {"/__volt"
                 "/api/desktop-workbenches/restart-status"
                 "/api/desktop-workbenches/market-installs"
                 "/plugins/dsh-agent-teams/state"})
action:     set_cache_settings
params:     { "cache": true,
              "edge_ttl":    { "mode": "override_origin", "default": 30 },
              "browser_ttl": { "mode": "override_origin", "default": 5  } }
```

实测：四条路径全部 `cf-cache-status: HIT`，客户端 120 次请求 → 源站只处理 **16 次**。

#### 三个踩过的坑

1. **`edge_ttl` 和 `browser_ttl` 是两回事。** 只设 `edge_ttl` 的话，Cloudflare
   仍然把 `max-age=14400`（4 小时）发给浏览器——那是 **Browser Cache TTL** 的默认值。
   浏览器于是把电源徽标的读数缓存 4 小时，徽标**冻住不刷新**。
   现在 `browser_ttl` 设 5 秒，浏览器每次轮询都问边缘要新的。

2. **TTL 的方向是反的直觉。** 边缘 TTL 要**长**（30 秒 ≳ 轮询间隔），
   浏览器 TTL 要**短**（5 秒）。边缘 TTL 短到 5 秒时，Cloudflare 会在每个请求上
   重新回源校验，源站一个都没省下（实测 120 → 62）；边缘 TTL 30 秒时才有
   120 → 16 的效果。

3. **API 的字段名是 `default`，不是 `default_ttl`。**
   `{"mode":"override_origin","default":30}` 是对的；
   写成 `default_ttl` 会得到 `invalid JSON: unknown field "default_ttl"`，
   而 `{"mode":"override_origin"}` 不带 default 会得到
   `default cannot be empty in override_origin mode`。
   `stale_while_revalidate` 这个字段名在当前 API 版本里也不存在
   （`stale-while-revalidate=60` 是源站自己带的，Cloudflare 保留了它）。

#### 权限

本机的 `~/.cloudflared/cert.pem`（Argo tunnel token）**读不到** rulesets：
`/zones/<id>/rulesets` 返回 **403 Authentication error**。能操作的是另外建的
API token，权限需要 **Zone → Cache Rules → Edit** + **Zone → Zone → Read**。
这个 token **没有 Cache Purge**，所以改完规则后边缘上旧的对象不会立刻消失，
要等它按旧的 TTL 过期后重新存储（实测几分钟内就换成新的 `max-age` 了）。

这四个接口的内容不敏感（电源状态、重启状态、agent 状态、市场目录），
边缘缓存会忽略 Cookie，等于**这些响应对任何知道域名的人可见**——站点本身
对知道域名的人就是开放的，2026-11-06 已确认**不加访问闸门**。


## 在家用哪个入口

| 入口 | 首字节 | 说明 |
|---|---|---|
| `http://10.32.7.113:43128` | **16 ms** | 同一局域网，不走任何公网链路 |
| `http://100.86.255.34:43128` | **16 ms** | Tailscale，同上 |
| `https://dsh.averivendell.world` | 1.1–2.6 s | 公网域名，给**不在家**时用 |

三条入口**共用同一条会话 Cookie**：nginx 把 `Host` / `Origin` 归一化成
`100.86.255.34:43129`，Harness 的 Cookie 就签在这个 authority 上，所以换入口不用
重新登录。Windows 侧 hosts 加一行 `dsh.lan → 10.32.7.113` 就能用一个正常域名。

**结论：在家用局域网/Tailscale 入口，公网域名留给外出。** 两者的差距不在带宽，
在首字节的往返次数。

### 公网域名现在还剩多少时间

服务端这条链路已经不再拖后腿了，剩下的时间全在**访客 → Cloudflare POP**这一段。

两条入口跑同一个探针（`scripts/dsh-cold-load-probe.sh`），同一台机器、同一时刻：

| | 公网域名 | 局域网 / Tailscale |
|---|---|---|
| 根页面 | 2648 ms | **16 ms** |
| 88 个 bundle | 25.6 s（88 HIT / 0 MISS） | **889 ms** |
| 合计 | **28.3 s** | **904 ms** |

**差 31 倍。** 公网这一侧每个请求的往返 ≈ 1–3 秒：`cf-ray` 落在 **AMS**
（阿姆斯特丹），而本机出口是上海电信直连、不走代理。同一次测量里
`www.cloudflare.com` 落的是 **SJC**，说明这条国际路径本身就抖——换成
Cloudflare 的另一组 anycast IP（`104.16.x` → LAX）延迟没有稳定改善，
8 次采样的中位数和 AMS 在一个量级。

所以公网域名这一侧已经没什么可挖的了：能动的只有**客户端的出口**
（VPN 换到香港/日本/新加坡，POP 就能落在 HKG/NRT/SIN 而不是 AMS），
或者干脆**在家走局域网入口**。

## 升级 DSH 之后要检查什么

1. `git status` —— `scripts/dsh-web-proxy.mjs` 的改动**尚未提交**。
   `git pull` 或 `git checkout` 会覆盖掉它们。若已覆盖，按本文的
   「各部分职责」重新施加，或先 `git stash` 保存。
2. `node scripts/dsh-web-assets-precompress.mjs --quiet` ——
   `dsh-web.service` 的 `ExecStartPost` 会在每次启动时自动跑，但手动跑一次更保险。
3. `sudo systemctl start dsh-web-warm-cache.service` —— 新版本的 bundle 有新的
   revision，新的 URL，边缘缓存还没见过它们。`dsh-web-warm-cache.timer` 每 10 分钟
   也会跑一次，但升级后立刻跑一次更好。**日志里应当出现 `N warmed`（N≈88）**；
   出现 `0 warmed` 或非零退出码就说明**页面没给出 bundle**（Harness 没起来，或
   它的 launch token 丢了）。
4. `curl -sI http://127.0.0.1:43128/assets/<某个>.js | grep -i content-encoding`
   —— 应当看到 `br`。
5. `curl -s http://127.0.0.1:43128/healthz` —— 应当 `ok: true`。
   若这里报 `no launch token in the log`，看 `/var/lib/dsh-web/launch-token` 是不是
   在（`dsh-web-capture-token.mjs` 写的），以及文件里记的 PID 是不是当前 Harness
   的 PID——**对不上就说明这个 token 属于一个已经换掉的 Harness**。
6. `curl -sI "https://dsh.averivendell.world/plugins/<某个>?rev=...&proxy=2" | grep -i cf-cache-status`
   —— 第一次 `MISS`，第二次 `HIT`。
7. `scripts/dsh-cold-load-probe.sh` —— 跑一次冷加载，看 `cache` 那行是不是
   `88 HIT, 0 MISS`。有 MISS 就说明边缘缓存又被作废了。
8. `sudo ss -unap | grep $(systemctl show cloudflared-dsh -p MainPID --value)` ——
   应当看到 4 条 **UDP** 连接（7844）。隧道现在是 `protocol: quic`，**不再有 TCP
   socket**，所以 `ss -ti` 看不到它；`ss -ti` 里那些显示 `cubic` 的 7844 连接属于
   本机另外两条隧道（`pi-github-sync`、`claude-webui`），与 DSH 无关。

## 回滚

| 想回滚什么 | 怎么做 |
|---|---|
| BBR | `sudo sysctl -w net.ipv4.tcp_congestion_control=cubic`，删 `/etc/sysctl.d/99-dsh-tunnel.conf` 和 `/etc/modules-load.d/tcp-bbr.conf`，重启 `cloudflared-dsh` |
| QUIC | `~/.cloudflared/config-dsh.yml` 里 `protocol: quic` → `http2`，重启 `cloudflared-dsh` |
| token 持久化 | 删 `/etc/systemd/system/dsh-web.service.d/20-token.conf`，`daemon-reload`；代理仍会优先读日志 |
| 预热频率 | `dsh-web-warm-cache.timer` 的 `OnUnitActiveSec` 改回 `1d` |
| 插件图 URL 改写 | 把 `BUNDLE_URL_FORMAT` 的用途去掉，恢复 `??` 形式；或直接 `git checkout scripts/dsh-web-proxy.mjs` |
| 会话列表裁剪 | `DSH_PROXY_SESSION_LIST_TRIM=0`，重启 proxy |
| nginx 静态资源 | 注释掉 `/assets/` 那个 location，reload nginx |
| 整个 nginx 层 | 停 nginx，proxy 改回 `--port 43128`，Cloudflare 配置不动 |
| proxy 的全部改动 | `git checkout scripts/dsh-web-proxy.mjs`，重启 proxy |
