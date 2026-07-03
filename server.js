const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8787);
const ROOT_DIR = __dirname;
const EASTMONEY_HOST = "push2.eastmoney.com";
const TOP_STOCK_PATH = "/api/qt/clist/get";
const QUOTE_PATH = "/api/qt/ulist.np/get";
const DEFAULT_TOP_LIMIT = 100;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);
const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
  "Referer": "https://quote.eastmoney.com/",
  "Cache-Control": "no-cache",
  "Connection": "close",
};

// 读取最新日期计划，避免前端直接访问本地文件受浏览器限制。
function readLatestPlan() {
  const files = fs.readdirSync(ROOT_DIR)
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file))
    .sort();
  const latestFile = files.at(-1);
  if (!latestFile) {
    return { date: "", file: "", content: "", parsed: parsePlan("") };
  }

  const content = fs.readFileSync(path.join(ROOT_DIR, latestFile), "utf8");
  return {
    date: latestFile.replace(".md", ""),
    file: latestFile,
    content,
    parsed: parsePlan(content),
  };
}

// 从 Markdown 中抽取结构化线索，供页面直接渲染和筛选。
function parsePlan(content) {
  return {
    sectorHints: extractInlineList(content, "板块线索"),
    referenceHints: extractInlineList(content, "参考线索"),
    riskHints: extractInlineList(content, "风险线索"),
    disciplineHints: extractInlineList(content, "纪律线索"),
    focusItems: extractFocusItems(content),
    buyRule: extractSection(content, "买入条件"),
    forbiddenRule: extractSection(content, "禁止事项"),
    coreRule: extractSection(content, "核心策略"),
  };
}

// 解析“**字段**：值”格式的列表，保持项目原始策略口径。
function extractInlineList(content, label) {
  const pattern = new RegExp(`\\*\\*${label}\\*\\*：([^\\n]+)`);
  const match = content.match(pattern);
  if (!match) return [];
  return match[1]
    .replace(/[。；;]/g, "、")
    .split(/[、,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// 提取关注方向条目，只保留用户真正会看盘用的列表。
function extractFocusItems(content) {
  const focus = extractSection(content, "关注方向");
  return focus
    .split(/\r?\n/)
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length > 0);
}

// 提取指定 Markdown 小节，遇到下一个二级标题即停止。
function extractSection(content, heading) {
  const pattern = new RegExp(`## ${heading}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`);
  const match = content.match(pattern);
  return match ? match[1].trim() : "";
}

// 代理东方财富接口，前端只访问本地服务，降低跨域失败概率。
async function fetchEastmoney(pathname, params) {
  const maxAttempts = 5;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requestEastmoney(pathname, params);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await wait(1500);
    }
  }
  throw lastError;
}

// 执行单次远端行情请求，失败交给上层统一暴露。
async function requestEastmoney(pathname, params) {
  const protocols = ["https", "http"];
  let lastError = null;
  for (const protocol of protocols) {
    const url = buildEastmoneyUrl(protocol, pathname, params);
    try {
      const response = await fetch(url, { headers: REQUEST_HEADERS });
      return await parseEastmoneyResponse(response);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// 构建远端行情地址，协议可切换但数据源保持一致。
function buildEastmoneyUrl(protocol, pathname, params) {
  const url = new URL(`${protocol}://${EASTMONEY_HOST}${pathname}`);
  for (const [key, value] of params.entries()) url.searchParams.set(key, value);
  return url;
}

// 解析远端响应，非成功状态直接暴露。
function parseEastmoneyResponse(response) {
  if (!response.ok) throw new Error(`行情接口状态异常：${response.status}`);
  return response.json();
}

// 网络短抖动时等待后重试，最终失败仍返回明确错误。
function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 构建成交额前排查询参数，字段只保留页面需要的行情信息。
function buildTopStockParams(limit) {
  return new URLSearchParams({
    pn: "1",
    pz: String(limit || DEFAULT_TOP_LIMIT),
    po: "1",
    np: "1",
    ut: "bd1d9ddb04089700cf9c27f6f7426281",
    fltt: "2",
    invt: "2",
    fid: "f6",
    fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
    fields: "f12,f14,f2,f3,f4,f5,f6,f8,f10,f15,f16,f17,f18,f20,f21,f22,f62,f100,f124",
  });
}

// 构建批量行情查询参数，服务持仓和候选票刷新。
function buildQuoteParams(secids) {
  return new URLSearchParams({
    fltt: "2",
    secids,
    fields: "f12,f14,f2,f3,f4,f5,f6,f8,f10,f15,f16,f17,f18,f20,f21,f22,f62,f100,f124",
  });
}

// 统一写 JSON 响应，方便页面拿到明确错误。
function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}

// 处理 API 请求，所有失败都返回明确错误信息而不是静默吞掉。
async function handleApi(requestUrl, response) {
  try {
    if (requestUrl.pathname === "/api/latest-plan") {
      sendJson(response, 200, readLatestPlan());
      return;
    }
    if (requestUrl.pathname === "/api/top-stocks") {
      const limit = Number(requestUrl.searchParams.get("limit")) || DEFAULT_TOP_LIMIT;
      sendJson(response, 200, await fetchEastmoney(TOP_STOCK_PATH, buildTopStockParams(limit)));
      return;
    }
    if (requestUrl.pathname === "/api/quotes") {
      const secids = requestUrl.searchParams.get("secids") || "";
      sendJson(response, 200, await fetchEastmoney(QUOTE_PATH, buildQuoteParams(secids)));
      return;
    }
    sendJson(response, 404, { error: "未找到接口" });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
}

// 安全解析静态文件路径，避免访问项目目录外的文件。
function resolveStaticPath(pathname) {
  const safePath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = path.normalize(path.join(ROOT_DIR, safePath));
  if (!filePath.startsWith(ROOT_DIR)) return "";
  return filePath;
}

// 返回静态页面资源，缺失文件给 404。
function serveStatic(requestUrl, response) {
  const filePath = resolveStaticPath(requestUrl.pathname);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("文件不存在");
    return;
  }

  const extension = path.extname(filePath);
  response.writeHead(200, { "content-type": MIME_TYPES.get(extension) || "text/plain; charset=utf-8" });
  fs.createReadStream(filePath).pipe(response);
}

// 创建本地服务，只提供当前项目页面和只读数据接口。
function createServer() {
  return http.createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    if (requestUrl.pathname.startsWith("/api/")) {
      handleApi(requestUrl, response);
      return;
    }
    serveStatic(requestUrl, response);
  });
}

createServer().listen(PORT, () => {
  console.log(`本地操盘面板已启动：http://localhost:${PORT}`);
});
