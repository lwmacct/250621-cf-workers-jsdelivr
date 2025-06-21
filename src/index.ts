/**
 * CDN 代理服务 - Cloudflare Workers (TypeScript版本)
 * 用于镜像 cdn.jsdelivr.net 的代理服务
 * 支持移动设备适配、地区封禁、内容替换等功能
 *
 * 版本: 2.0
 * 优化: 2024
 */

import { Hono } from "hono";
import type { Context } from "hono";

// 类型定义
interface ProxyConfig {
  upstream: string;
  upstream_mobile: string;
  blocked_region: string[];
  blocked_ip_address: string[];
  replace_dict: Record<string, string>;
  cache_ttl: number;
  allowed_methods: string[];
}

// 配置区域 - 根据需要修改以下配置
const config: ProxyConfig = {
  // 替换成你想镜像的站点
  upstream: "cdn.jsdelivr.net",

  // 如果那个站点有专门的移动适配站点，否则保持和上面一致
  upstream_mobile: "cdn.jsdelivr.net",

  // 封禁地区列表 (ISO 3166-1 alpha-2 国家代码)
  blocked_region: ["KP", "RU"],

  // 封禁IP地址列表
  blocked_ip_address: ["0.0.0.0", "127.0.0.1"],

  // 内容替换规则
  replace_dict: {
    $upstream: "$custom_domain",
    "//cdn.jsdelivr.net": "",
  },

  // 缓存TTL设置 (秒)
  cache_ttl: 86400, // 24小时

  // 允许的HTTP方法
  allowed_methods: ["GET", "HEAD", "OPTIONS"],
};

const app = new Hono();

// 健康检查路由
app.get("/health", (c: Context) => {
  return c.json({
    status: "ok",
    service: "CDN Proxy",
    version: "2.0",
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (c: Context) => {
  return c.json({
    status: "ok",
    message: "This is a CDN Proxy service.",
    timestamp: new Date().toISOString(),
  });
});

// 主代理路由 - 匹配所有路径
app.all("*", async (c: Context): Promise<Response> => {
  return await fetchAndApply(c.req.raw);
});

/**
 * 主要的代理处理函数
 */
async function fetchAndApply(request: Request): Promise<Response> {
  // 方法验证
  if (!config.allowed_methods.includes(request.method)) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const region: string = request.headers.get("cf-ipcountry")?.toUpperCase() || "UNKNOWN";
  const ipAddress: string = request.headers.get("cf-connecting-ip") || "";
  const userAgent: string = request.headers.get("user-agent") || "";

  let response: Response;
  const url = new URL(request.url);
  const urlHost = url.host;

  // HTTPS重定向
  if (url.protocol === "http:") {
    url.protocol = "https:";
    return Response.redirect(url.href, 301);
  }

  // 设备类型检测和上游域名选择
  const upstreamDomain: string = isMobileDevice(userAgent) ? config.upstream_mobile : config.upstream;

  url.host = upstreamDomain;

  // 地区和IP封禁检查
  if (config.blocked_region.includes(region)) {
    return new Response("Access denied: WorkersProxy is not available in your region yet.", {
      status: 403,
    });
  }

  if (config.blocked_ip_address.includes(ipAddress)) {
    return new Response("Access denied: Your IP address is blocked by WorkersProxy.", {
      status: 403,
    });
  }

  // 代理请求处理
  try {
    const method = request.method;
    const requestHeaders = request.headers;
    const newRequestHeaders = new Headers(requestHeaders);

    newRequestHeaders.set("Host", upstreamDomain);
    newRequestHeaders.set("Referer", url.href);

    const originalResponse = await fetch(url.href, {
      method: method,
      headers: newRequestHeaders,
    });

    const originalResponseClone = originalResponse.clone();
    const responseHeaders = originalResponse.headers;
    const newResponseHeaders = new Headers(responseHeaders);
    const status = originalResponse.status;

    // 设置CORS和安全头
    newResponseHeaders.set("access-control-allow-origin", "*");
    newResponseHeaders.set("access-control-allow-credentials", "true");
    newResponseHeaders.delete("content-security-policy");
    newResponseHeaders.delete("content-security-policy-report-only");
    newResponseHeaders.delete("clear-site-data");

    // 内容类型检查和处理
    const contentType = newResponseHeaders.get("content-type");
    let originalText: ReadableStream | string;

    if (contentType && contentType.includes("text/html")) {
      originalText = await replaceResponseText(originalResponseClone, upstreamDomain, urlHost);
    } else {
      originalText = originalResponseClone.body || "";
    }

    response = new Response(originalText, {
      status,
      headers: newResponseHeaders,
    });
  } catch (error: unknown) {
    // 错误处理
    console.error("Proxy error:", error);
    response = new Response("Internal Server Error", { status: 500 });
  }

  return response;
}

/**
 * 替换响应文本中的特定内容
 */
async function replaceResponseText(response: Response, upstreamDomain: string, hostName: string): Promise<string> {
  const text = await response.text();

  // 优化替换逻辑
  const replacements = new Map<RegExp, string>();

  // 预处理替换字典
  for (const [key, value] of Object.entries(config.replace_dict)) {
    let processedKey = key;
    let processedValue = value;

    // 处理特殊占位符
    if (processedKey === "$upstream") {
      processedKey = upstreamDomain;
    } else if (processedKey === "$custom_domain") {
      processedKey = hostName;
    }

    if (processedValue === "$upstream") {
      processedValue = upstreamDomain;
    } else if (processedValue === "$custom_domain") {
      processedValue = hostName;
    }

    // 转义正则表达式特殊字符
    const escapedKey = processedKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    replacements.set(new RegExp(escapedKey, "g"), processedValue);
  }

  // 执行替换
  let processedText = text;
  for (const [regex, replacement] of replacements) {
    processedText = processedText.replace(regex, replacement);
  }

  return processedText;
}

/**
 * 检测是否为移动设备
 */
function isMobileDevice(userAgentInfo: string): boolean {
  if (!userAgentInfo) return false;

  const mobileAgents: string[] = [
    "Android",
    "iPhone",
    "SymbianOS",
    "Windows Phone",
    "iPad",
    "iPod",
    "BlackBerry",
    "Mobile",
  ];

  return mobileAgents.some((agent: string) => userAgentInfo.toLowerCase().includes(agent.toLowerCase()));
}

export default app;
