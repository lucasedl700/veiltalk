# nginx 反向代理参考（等价于 Caddy XTransformPort 方案）

> 适用场景：服务器上已习惯用 nginx 而非 Caddy。
> 目标：与项目根 `Caddyfile` 的 `:81` 网关行为完全一致——按查询参数
> `XTransformPort` 把请求转发到本机对应端口（3003 信令 / 3004 运维），其余转发到 3000。
> 前置认知：WebRTC 需要安全上下文，生产必须 HTTPS（`getUserMedia` 在裸 HTTP 的公网页面被禁用）。

## 1. 核心思路

前端固定写法 `io('/?XTransformPort=3003')`（socket.io `path='/'`），因此 nginx 需要按
**查询参数**分流。用 `map $arg_XTransformPort` 做端口白名单（只放行 3003/3004，其余落到
3000），**不要**把 `$arg_XTransformPort` 直接拼进 `proxy_pass`——那会构成任意本地端口探测
（SSRF）。

## 2. http 级配置（/etc/nginx/nginx.conf 的 http{} 块，或 conf.d/*.conf）

```nginx
# —— XTransformPort 端口白名单：安全关键，勿用 $arg 动态拼接 ——
map $arg_XTransformPort $veiltalk_backend {
    default 127.0.0.1:3000;      # 页面/静态/API 全部走 Next.js
    3003    127.0.0.1:3003;      # socket.io 信令
    3004    127.0.0.1:3004;      # 运维 HTTP API（/svc/*）
}

# —— WebSocket Upgrade 连接头开关（socket.io 轮询→websocket 升级必需）——
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

## 3. server 块（含 WebSocket 透传）

```nginx
server {
    listen 80;
    server_name veiltalk.example.com;
    return 301 https://$host$request_uri;        # ACME http-01 由 certbot 或 Caddy 处理时可删
}

server {
    listen 443 ssl;
    http2 on;
    server_name veiltalk.example.com;

    ssl_certificate     /etc/letsencrypt/live/veiltalk.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/veiltalk.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://$veiltalk_backend;

        # —— WebSocket 升级头（缺了这两行，socket.io 会退化成纯轮询甚至握手失败）——
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # —— 标准透传头 ——
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # —— 长连接友好：socket.io 默认 25s ping / 60s pingTimeout，超时切断会触发重连 ——
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
        proxy_buffering off;        # 信令小包即时性优先，关闭响应缓冲
    }
}
```

## 4. 与 Caddy 版的差异与注意点

| 事项 | Caddy | nginx |
| --- | --- | --- |
| 自动 HTTPS | 内置 | 用 certbot 签发/续期 |
| WebSocket | 反代自动处理 | 必须手写 Upgrade/Connection 头 |
| 端口路由 | `{query.XTransformPort}` 动态或 `@matcher` 白名单 | `map $arg_XTransformPort` 白名单（推荐写法即白名单） |
| 长连接超时 | 默认满足 | `proxy_read_timeout` 需调大（默认 60s 会掐 socket.io） |
| 缓冲 | 默认透传 | `proxy_buffering off`（信令实时性） |

## 5. 验证

```bash
# 信令握手：应返回 0{"sid":...,"upgrades":["websocket"],...} 而不是 HTML
curl -s 'https://veiltalk.example.com/?EIO=4&transport=polling&XTransformPort=3003' | head -c 120

# 运维 API
curl -s 'https://veiltalk.example.com/svc/ledger?XTransformPort=3004&limit=1' | head -c 120

# WebSocket 升级（应返回 101）
curl -s -i -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  'https://veiltalk.example.com/?EIO=4&transport=websocket&XTransformPort=3003' | head -n1
```

若第一条返回 HTML，说明 map 未生效（检查 `$arg_XTransformPort` 名称拼写与 reload）；
若 101 拿不到，优先查 Upgrade 头与 `proxy_read_timeout`。
