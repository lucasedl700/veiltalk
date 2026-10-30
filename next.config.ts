import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  /* 预览面板源（*.space-z.ai）访问 _next 资源属预期跨域，白名单避免 dev 噪声警告 */
  allowedDevOrigins: ["preview-*.space-z.ai", "preview-chat-*.space-z.ai"],
  /* 本机无 Caddy 网关时的直连兜底：按 XTransformPort 查询参数把 /svc 与信令 socket.io
     反代到对应本机端口。必须 beforeFiles —— '/' 本身是页面路由，afterFiles 永远不会触发，
     socket.io（/?EIO=4&XTransformPort=3003）会打到页面自身导致信令连不上。
     生产部署里 Caddy 在 :81 先行拦截，不会走到这些规则。 */
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/svc/:path*",
          has: [{ type: "query", key: "XTransformPort", value: "3004" }],
          destination: "http://127.0.0.1:3004/svc/:path*",
        },
        {
          source: "/",
          has: [{ type: "query", key: "XTransformPort", value: "3003" }],
          destination: "http://127.0.0.1:3003/",
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
