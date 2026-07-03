const API = {
  latestPlan: "/api/latest-plan",
  topStocks: "/api/top-stocks?limit=100",
  quotes: "/api/quotes?secids=",
};

const STORAGE_KEYS = {
  strategy: "trade_panel_strategy_v1",
  holdings: "trade_panel_holdings_v1",
  operations: "trade_panel_operations_v1",
};

const DEFAULT_STRATEGY = {
  sectors: ["存储", "半导体", "硬科技", "科创板", "贵金属", "算力"],
  maxGain: 6,
  minTurnover: 2,
  maxPosition: 0.72,
  refreshInterval: 0,
};

const DEFAULT_HOLDINGS = [
  { code: "600900", name: "长江电力", cost: 28.5857, quantity: 5800 },
  { code: "09988", name: "阿里巴巴-W", cost: 144.3682, quantity: 1700 },
  { code: "00700", name: "腾讯控股", cost: 582.1024, quantity: 300 },
  { code: "600111", name: "北方稀土", cost: 47.7057, quantity: 2000 },
  { code: "688111", name: "XD金山办", cost: 335.7912, quantity: 200 },
  { code: "000938", name: "紫光股份", cost: 30.745, quantity: 1000 },
  { code: "002299", name: "圣农发展", cost: 14.7768, quantity: 1800 },
];

const INDUSTRY_KEYWORDS = new Map([
  ["贵金属", ["贵金属", "黄金", "白银"]],
  ["半导体", ["半导体", "电子化学品", "其他电子"]],
  ["存储", ["半导体", "存储"]],
  ["硬科技", ["半导体", "元件", "光学光电子", "自动化设备"]],
  ["算力", ["通信设备", "计算机设备", "IT服务", "软件开发"]],
  ["科创板", ["半导体", "软件开发", "计算机设备"]],
]);

const ACTION_CLASS = new Map([
  ["可小仓", "buy"],
  ["等回踩", "wait"],
  ["禁止追", "block"],
  ["只观察", "watch"],
  ["放弃", "block"],
]);

const state = {
  plan: null,
  strategy: loadJson(STORAGE_KEYS.strategy, DEFAULT_STRATEGY),
  holdings: loadJson(STORAGE_KEYS.holdings, DEFAULT_HOLDINGS),
  operations: loadJson(STORAGE_KEYS.operations, []),
  quotes: new Map(),
  topStocks: [],
  refreshTimer: 0,
};

const elements = {
  statusText: document.querySelector("#statusText"),
  refreshButton: document.querySelector("#refreshButton"),
  exportButton: document.querySelector("#exportButton"),
  importInput: document.querySelector("#importInput"),
  planMeta: document.querySelector("#planMeta"),
  planSummary: document.querySelector("#planSummary"),
  disciplineBadge: document.querySelector("#disciplineBadge"),
  marketMeta: document.querySelector("#marketMeta"),
  marketBadge: document.querySelector("#marketBadge"),
  executionList: document.querySelector("#executionList"),
  strategyForm: document.querySelector("#strategyForm"),
  sectorInput: document.querySelector("#sectorInput"),
  maxGainInput: document.querySelector("#maxGainInput"),
  minTurnoverInput: document.querySelector("#minTurnoverInput"),
  maxPositionInput: document.querySelector("#maxPositionInput"),
  refreshIntervalInput: document.querySelector("#refreshIntervalInput"),
  resetStrategyButton: document.querySelector("#resetStrategyButton"),
  holdingForm: document.querySelector("#holdingForm"),
  holdingCodeInput: document.querySelector("#holdingCodeInput"),
  holdingNameInput: document.querySelector("#holdingNameInput"),
  holdingCostInput: document.querySelector("#holdingCostInput"),
  holdingQuantityInput: document.querySelector("#holdingQuantityInput"),
  holdingsBody: document.querySelector("#holdingsBody"),
  holdingSummary: document.querySelector("#holdingSummary"),
  operationForm: document.querySelector("#operationForm"),
  operationTypeInput: document.querySelector("#operationTypeInput"),
  operationCodeInput: document.querySelector("#operationCodeInput"),
  operationNameInput: document.querySelector("#operationNameInput"),
  operationPriceInput: document.querySelector("#operationPriceInput"),
  operationQuantityInput: document.querySelector("#operationQuantityInput"),
  operationNoteInput: document.querySelector("#operationNoteInput"),
  syncHoldingInput: document.querySelector("#syncHoldingInput"),
  operationList: document.querySelector("#operationList"),
  logSummary: document.querySelector("#logSummary"),
};

// 读取本地保存的数据，损坏时回到默认值并显式覆盖。
function loadJson(key, fallback) {
  const rawValue = localStorage.getItem(key);
  if (!rawValue) return fallback;
  try {
    return JSON.parse(rawValue);
  } catch {
    localStorage.setItem(key, JSON.stringify(fallback));
    return fallback;
  }
}

// 保存本地状态，确保刷新页面后策略、持仓和操作记录仍保留。
function saveState() {
  localStorage.setItem(STORAGE_KEYS.strategy, JSON.stringify(state.strategy));
  localStorage.setItem(STORAGE_KEYS.holdings, JSON.stringify(state.holdings));
  localStorage.setItem(STORAGE_KEYS.operations, JSON.stringify(state.operations));
}

// 格式化数值展示，空值保留短横线。
function formatNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toFixed(digits);
}

// 将 A 股、港股代码转换成东方财富 secid。
function toSecId(code) {
  const normalized = String(code).trim();
  if (/^\d{5}$/.test(normalized)) return `116.${normalized}`;
  if (/^(6|9)/.test(normalized)) return `1.${normalized}`;
  return `0.${normalized}`;
}

// 包装请求，接口失败时在页面暴露错误。
async function fetchJson(url) {
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requestJsonOnce(url);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await waitForRequestRetry();
    }
  }
  throw lastError;
}

// 执行单次本地接口请求，失败时交给上层决定是否重试。
async function requestJsonOnce(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`请求失败：${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error);
  return payload;
}

// 本地接口失败后短暂停顿，避免远端数据源瞬时抖动。
function waitForRequestRetry() {
  const retryDelayMilliseconds = 1000;
  return new Promise((resolve) => window.setTimeout(resolve, retryDelayMilliseconds));
}

// 从最新计划生成默认策略，用户手动保存后优先使用手动配置。
function mergePlanStrategy(plan) {
  const sectors = plan?.parsed?.sectorHints || [];
  if (!localStorage.getItem(STORAGE_KEYS.strategy) && sectors.length > 0) {
    state.strategy = { ...DEFAULT_STRATEGY, sectors };
    saveState();
  }
}

// 初始化页面，先读取计划，再刷新行情。
async function initializeApp() {
  bindEvents();
  renderStrategyForm();
  renderOperations();
  try {
    state.plan = await fetchJson(API.latestPlan);
    mergePlanStrategy(state.plan);
    renderPlan();
    await refreshAll();
  } catch (error) {
    setStatus(`加载失败：${error.message}`);
  }
  scheduleRefresh();
}

// 绑定页面事件，所有动作只更新本地数据或刷新行情。
function bindEvents() {
  elements.refreshButton.addEventListener("click", refreshAll);
  elements.strategyForm.addEventListener("submit", handleStrategySubmit);
  elements.resetStrategyButton.addEventListener("click", resetStrategy);
  elements.holdingForm.addEventListener("submit", handleHoldingSubmit);
  elements.operationForm.addEventListener("submit", handleOperationSubmit);
  elements.exportButton.addEventListener("click", exportState);
  elements.importInput.addEventListener("change", importState);
}

// 设置顶部状态文案，方便看清当前流程。
function setStatus(message) {
  elements.statusText.textContent = message;
}

// 根据自动刷新秒数设置定时器，0 表示关闭。
function scheduleRefresh() {
  window.clearInterval(state.refreshTimer);
  const seconds = Number(state.strategy.refreshInterval);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  state.refreshTimer = window.setInterval(refreshAll, seconds * 1000);
}

// 刷新持仓行情和成交额前排候选。
async function refreshAll() {
  try {
    setStatus("正在刷新行情和执行提示。");
    await refreshTopStocks();
    await waitForMarketSource();
    await refreshQuotes();
    renderHoldings();
    renderExecution();
    renderMarketMeta();
    setStatus("行情已刷新，执行提示已更新。");
  } catch (error) {
    setStatus(`刷新失败：${error.message}`);
  }
}

// 两类行情接口之间留出短间隔，避免远端接口连续断开。
function waitForMarketSource() {
  const delayMilliseconds = 900;
  return new Promise((resolve) => window.setTimeout(resolve, delayMilliseconds));
}

// 刷新当前持仓和重点候选的批量行情。
async function refreshQuotes() {
  const codes = new Set(state.holdings.map((item) => item.code));
  getManualCandidateCodes().forEach((code) => codes.add(code));
  const secids = [...codes].filter(Boolean).map(toSecId).join(",");
  if (!secids) return;
  const payload = await fetchJson(`${API.quotes}${encodeURIComponent(secids)}`);
  state.quotes = new Map((payload.data?.diff || []).map((item) => [item.f12, normalizeStock(item)]));
}

// 刷新成交额前排股票，用于自动筛选。
async function refreshTopStocks() {
  const payload = await fetchJson(API.topStocks);
  state.topStocks = (payload.data?.diff || []).map(normalizeStock);
}

// 重点候选保底进入批量刷新，便于执行面板稳定展示。
function getManualCandidateCodes() {
  return ["601899", "600489", "000938", "600988", "000975", "300223", "301165", "000426"];
}

// 统一行情字段命名，避免页面逻辑直接依赖 f 字段。
function normalizeStock(item) {
  return {
    code: item.f12,
    name: item.f14,
    price: Number(item.f2),
    changePercent: Number(item.f3),
    turnover: Number(item.f6) / 100000000,
    volumeRatio: Number(item.f10),
    high: Number(item.f15),
    low: Number(item.f16),
    open: Number(item.f17),
    previousClose: Number(item.f18),
    marketCap: Number(item.f20) / 100000000,
    mainFlow: Number(item.f62) / 10000,
    industry: item.f100 || "",
  };
}

// 渲染今日计划摘要，突出纪律信号。
function renderPlan() {
  const parsed = state.plan?.parsed || {};
  elements.planMeta.textContent = `${state.plan.date} 公开盘前计划 | ${getPlanSourceText(state.plan)}`;
  elements.disciplineBadge.textContent = parsed.disciplineHints?.join("、") || "按纪律执行";
  elements.disciplineBadge.className = getConservativeMode() ? "badge danger" : "badge good";
  elements.planSummary.innerHTML = buildPlanSummary(parsed);
  renderStrategyForm();
}

// 显示计划来源，便于识别是否走了 GitHub 兜底。
function getPlanSourceText(plan) {
  const sourceMap = {
    "local-today": "本地当天",
    "github-today": "GitHub 当天",
    "local-latest": "本地最新",
    "empty": "无计划",
  };
  const source = sourceMap[plan?.source] || "未知来源";
  return plan?.warning ? `${source}，${plan.warning}` : source;
}

// 生成策略摘要卡片 HTML。
function buildPlanSummary(parsed) {
  const items = [
    ["板块线索", parsed.sectorHints],
    ["风险线索", parsed.riskHints],
    ["参考线索", parsed.referenceHints],
    ["买入条件", parsed.buyRule],
    ["禁止事项", parsed.forbiddenRule],
    ["核心策略", parsed.coreRule],
  ];
  return items.map(([title, value]) => {
    const text = Array.isArray(value) ? value.join("、") : String(value || "-");
    return `<div class="summary-item"><strong>${title}</strong><span>${escapeHtml(text)}</span></div>`;
  }).join("");
}

// 渲染策略表单，保证用户看到当前实际生效规则。
function renderStrategyForm() {
  elements.sectorInput.value = state.strategy.sectors.join("、");
  elements.maxGainInput.value = state.strategy.maxGain;
  elements.minTurnoverInput.value = state.strategy.minTurnover;
  elements.maxPositionInput.value = state.strategy.maxPosition;
  elements.refreshIntervalInput.value = state.strategy.refreshInterval;
}

// 保存手动策略，并立即按新规则重算。
function handleStrategySubmit(event) {
  event.preventDefault();
  state.strategy = readStrategyForm();
  saveState();
  scheduleRefresh();
  renderExecution();
  setStatus("策略已保存，并已按新规则重算执行提示。");
}

// 从策略表单读取配置，输入都做边界兜底。
function readStrategyForm() {
  return {
    sectors: splitInput(elements.sectorInput.value),
    maxGain: clampNumber(elements.maxGainInput.value, 0, 20, DEFAULT_STRATEGY.maxGain),
    minTurnover: clampNumber(elements.minTurnoverInput.value, 0, 200, DEFAULT_STRATEGY.minTurnover),
    maxPosition: clampNumber(elements.maxPositionInput.value, 0, 1, DEFAULT_STRATEGY.maxPosition),
    refreshInterval: clampNumber(elements.refreshIntervalInput.value, 0, 3600, DEFAULT_STRATEGY.refreshInterval),
  };
}

// 恢复项目计划默认策略，便于每天重新开始。
function resetStrategy() {
  state.strategy = { ...DEFAULT_STRATEGY, sectors: state.plan?.parsed?.sectorHints || DEFAULT_STRATEGY.sectors };
  saveState();
  renderStrategyForm();
  renderExecution();
  scheduleRefresh();
}

// 分割中文输入列表，过滤空项。
function splitInput(value) {
  return String(value).split(/[、,，\n]/).map((item) => item.trim()).filter(Boolean);
}

// 数字输入做显式边界处理，避免异常值污染筛选。
function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

// 判断今天是否处于保守纪律，影响候选票评级。
function getConservativeMode() {
  const parsed = state.plan?.parsed || {};
  const hints = [...(parsed.riskHints || []), ...(parsed.disciplineHints || [])].join("、");
  return /减仓|估值|回调|震荡|风险/.test(hints);
}

// 渲染指数和刷新时间摘要。
function renderMarketMeta() {
  const now = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  elements.marketMeta.textContent = `最后刷新：${now}`;
  elements.marketBadge.textContent = getConservativeMode() ? "保守" : "正常";
  elements.marketBadge.className = getConservativeMode() ? "badge danger" : "badge good";
}

// 渲染执行面板，只显示最相关的前 12 个信号。
function renderExecution() {
  const signals = buildExecutionSignals();
  if (signals.length === 0) {
    elements.executionList.innerHTML = `<div class="empty">当前没有符合策略的候选票。</div>`;
    return;
  }
  elements.executionList.innerHTML = signals.slice(0, 12).map(renderSignalCard).join("");
}

// 生成候选票信号，手动关注票优先展示，成交额前排补充。
function buildExecutionSignals() {
  const manualStocks = getManualCandidateCodes().map((code) => state.quotes.get(code)).filter(Boolean);
  const pool = uniqueStocks([...manualStocks, ...state.topStocks]);
  return pool
    .map((stock) => ({ stock, decision: decideStock(stock) }))
    .filter(({ decision }) => decision.visible)
    .sort(sortSignals);
}

// 按代码去重，保留靠前数据。
function uniqueStocks(stocks) {
  const result = new Map();
  stocks.forEach((stock) => {
    if (stock?.code && !result.has(stock.code)) result.set(stock.code, stock);
  });
  return [...result.values()];
}

// 按动作优先级和成交额排序，方便开盘快速看重点。
function sortSignals(left, right) {
  const rank = { "可小仓": 1, "等回踩": 2, "只观察": 3, "禁止追": 4, "放弃": 5 };
  return (rank[left.decision.action] - rank[right.decision.action]) || (right.stock.turnover - left.stock.turnover);
}

// 判断候选票是否符合当日策略，并生成可执行指示。
function decideStock(stock) {
  const position = getDayPosition(stock);
  if (!matchesSector(stock)) return hiddenDecision();
  if (stock.turnover < state.strategy.minTurnover) return hiddenDecision();
  if (isLimitOrTooHigh(stock, position)) return makeDecision("禁止追", stock, "涨幅或日内位置过高，不符合不追高纪律。");
  if (getConservativeMode() && stock.changePercent > state.strategy.maxGain) {
    return makeDecision("等回踩", stock, "今天纪律偏减仓，当前涨幅偏高，只等回踩。");
  }
  if (isGoodPullback(stock, position)) return makeDecision("可小仓", stock, "方向匹配、成交活跃，价格未贴近日内高点。");
  if (stock.changePercent < -2) return makeDecision("只观察", stock, "方向匹配但当日偏弱，先看承接。");
  return makeDecision("等回踩", stock, "方向匹配，但当前买点不够舒服。");
}

// 非目标股票默认不展示，保持执行面板干净。
function hiddenDecision() {
  return { visible: false, action: "隐藏", reason: "" };
}

// 构建带价格区间和止损位的决策对象。
function makeDecision(action, stock, reason) {
  const buyZone = getBuyZone(stock);
  const stopPrice = Math.min(stock.low, stock.previousClose * 0.985);
  return { visible: true, action, reason, buyZone, stopPrice };
}

// 判断行业是否命中策略方向，使用项目线索到行业的映射。
function matchesSector(stock) {
  const text = `${stock.name}${stock.industry}`;
  return state.strategy.sectors.some((sector) => {
    const keywords = INDUSTRY_KEYWORDS.get(sector) || [sector];
    return keywords.some((keyword) => text.includes(keyword));
  });
}

// 日内位置越接近 1 越靠近日内最高点。
function getDayPosition(stock) {
  const range = Math.max(0.01, stock.high - stock.low);
  return (stock.price - stock.low) / range;
}

// 判断是否已进入追高区，涨停和贴近日内高点都禁止追。
function isLimitOrTooHigh(stock, position) {
  const limitGain = 9.5;
  const highPosition = 0.9;
  return stock.changePercent >= limitGain || (position >= highPosition && stock.changePercent > state.strategy.maxGain);
}

// 判断是否满足小仓试错条件，偏向回踩和承接。
function isGoodPullback(stock, position) {
  const activeVolume = 1.2;
  return stock.changePercent > 0
    && stock.changePercent <= state.strategy.maxGain
    && position <= state.strategy.maxPosition
    && stock.volumeRatio >= activeVolume
    && stock.mainFlow >= 0;
}

// 根据日内区间生成低吸区，不把现价追高当买点。
function getBuyZone(stock) {
  const range = Math.max(0.01, stock.high - stock.low);
  const lowZone = stock.low + range * 0.35;
  const highZone = stock.low + range * 0.55;
  return `${formatNumber(lowZone)} - ${formatNumber(highZone)}`;
}

// 渲染单个候选执行卡片。
function renderSignalCard({ stock, decision }) {
  const actionClass = ACTION_CLASS.get(decision.action) || "watch";
  const position = getDayPosition(stock);
  return `
    <article class="signal-card ${actionClass}">
      <div class="signal-title">
        <strong>${stock.code} ${escapeHtml(stock.name)}</strong>
        <span>${escapeHtml(stock.industry)} | 成交额 ${formatNumber(stock.turnover)} 亿</span>
        <span>现价 ${formatNumber(stock.price)} | 涨跌 ${formatNumber(stock.changePercent)}%</span>
      </div>
      <div class="metric-row">
        <span>量比 ${formatNumber(stock.volumeRatio)}</span>
        <span>日内位置 ${formatNumber(position, 2)}</span>
        <span>主力 ${formatNumber(stock.mainFlow, 0)} 万</span>
      </div>
      <div>
        <div class="action-tag ${actionClass}">${decision.action}</div>
        <p class="signal-detail">买入区间：${decision.buyZone}；止损：${formatNumber(decision.stopPrice)}。${decision.reason}</p>
      </div>
    </article>`;
}

// 渲染持仓表，并按最新价计算浮盈亏。
function renderHoldings() {
  elements.holdingSummary.textContent = `${state.holdings.length} 只`;
  if (state.holdings.length === 0) {
    elements.holdingsBody.innerHTML = `<tr><td colspan="8">暂无持仓。</td></tr>`;
    return;
  }
  elements.holdingsBody.innerHTML = state.holdings.map(renderHoldingRow).join("");
  bindHoldingRowActions();
}

// 渲染单个持仓行，操作指示只作人工决策参考。
function renderHoldingRow(holding) {
  const quote = state.quotes.get(holding.code);
  const price = quote?.price || 0;
  const profit = price ? (price - holding.cost) * holding.quantity : 0;
  const profitClass = profit >= 0 ? "gain" : "loss";
  return `
    <tr>
      <td>${holding.code}</td>
      <td>${escapeHtml(holding.name)}</td>
      <td>${formatNumber(holding.cost, 3)}</td>
      <td>${holding.quantity}</td>
      <td>${price ? formatNumber(price) : "-"}</td>
      <td class="${profitClass}">${price ? formatNumber(profit) : "-"}</td>
      <td>${getHoldingAdvice(holding, quote)}</td>
      <td><div class="row-actions"><button data-edit="${holding.code}">编辑</button><button data-delete="${holding.code}">删除</button></div></td>
    </tr>`;
}

// 根据持仓盈亏和当日强弱给出简洁动作提示。
function getHoldingAdvice(holding, quote) {
  if (!quote) return "等待行情";
  const profitRate = (quote.price - holding.cost) / Math.max(0.01, holding.cost);
  if (profitRate <= -0.08 && quote.changePercent < 0) return "弱势亏损，优先减压";
  if (profitRate > 0 && quote.changePercent < -0.5) return "保护利润";
  if (quote.changePercent > 1 && getDayPosition(quote) > 0.75) return "强势持有，不追加";
  if (getConservativeMode()) return "按减仓纪律观察";
  return "继续观察";
}

// 绑定持仓行编辑和删除动作。
function bindHoldingRowActions() {
  document.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => fillHoldingForm(button.dataset.edit));
  });
  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteHolding(button.dataset.delete));
  });
}

// 保存或更新持仓，输入不足时不写入。
function handleHoldingSubmit(event) {
  event.preventDefault();
  const holding = readHoldingForm();
  if (!holding) return;
  upsertHolding(holding);
  saveState();
  clearHoldingForm();
  refreshAll();
}

// 从持仓表单读取并校验数据。
function readHoldingForm() {
  const code = elements.holdingCodeInput.value.trim();
  const name = elements.holdingNameInput.value.trim();
  const cost = Number(elements.holdingCostInput.value);
  const quantity = Number(elements.holdingQuantityInput.value);
  if (!code || !name || !Number.isFinite(cost) || !Number.isFinite(quantity)) return null;
  return { code, name, cost, quantity };
}

// 新增或替换同代码持仓，避免重复行。
function upsertHolding(holding) {
  const index = state.holdings.findIndex((item) => item.code === holding.code);
  if (index >= 0) state.holdings.splice(index, 1, holding);
  else state.holdings.push(holding);
}

// 把持仓填回表单，方便快速修改成本或数量。
function fillHoldingForm(code) {
  const holding = state.holdings.find((item) => item.code === code);
  if (!holding) return;
  elements.holdingCodeInput.value = holding.code;
  elements.holdingNameInput.value = holding.name;
  elements.holdingCostInput.value = holding.cost;
  elements.holdingQuantityInput.value = holding.quantity;
}

// 删除本地持仓，不影响券商账户。
function deleteHolding(code) {
  state.holdings = state.holdings.filter((item) => item.code !== code);
  saveState();
  renderHoldings();
}

// 清空持仓表单，避免重复提交。
function clearHoldingForm() {
  elements.holdingForm.reset();
}

// 记录操作，并按选择同步持仓。
function handleOperationSubmit(event) {
  event.preventDefault();
  const operation = readOperationForm();
  if (!operation) return;
  state.operations.unshift(operation);
  if (elements.syncHoldingInput.checked) applyOperationToHolding(operation);
  saveState();
  elements.operationForm.reset();
  elements.syncHoldingInput.checked = true;
  renderOperations();
  renderHoldings();
}

// 读取操作记录输入，保证必要字段完整。
function readOperationForm() {
  const code = elements.operationCodeInput.value.trim();
  const name = elements.operationNameInput.value.trim();
  const price = Number(elements.operationPriceInput.value);
  const quantity = Number(elements.operationQuantityInput.value);
  if (!code || !Number.isFinite(price) || !Number.isFinite(quantity)) return null;
  return {
    id: `${Date.now()}`,
    time: new Date().toLocaleString("zh-CN", { hour12: false }),
    type: elements.operationTypeInput.value,
    code,
    name: name || code,
    price,
    quantity,
    note: elements.operationNoteInput.value.trim(),
  };
}

// 根据操作记录更新本地持仓，买入用加权成本，卖出只减数量。
function applyOperationToHolding(operation) {
  const holding = state.holdings.find((item) => item.code === operation.code);
  if (/买入|加仓/.test(operation.type)) applyBuyOperation(holding, operation);
  if (/卖出|减仓|止损/.test(operation.type)) applySellOperation(holding, operation);
}

// 买入时维护加权平均成本，避免直接覆盖旧成本。
function applyBuyOperation(holding, operation) {
  if (!holding) {
    upsertHolding({ code: operation.code, name: operation.name, cost: operation.price, quantity: operation.quantity });
    return;
  }
  const oldAmount = holding.cost * holding.quantity;
  const newAmount = operation.price * operation.quantity;
  holding.quantity += operation.quantity;
  holding.cost = (oldAmount + newAmount) / Math.max(1, holding.quantity);
}

// 卖出时减少数量，数量归零则从本地持仓移除。
function applySellOperation(holding, operation) {
  if (!holding) return;
  holding.quantity = Math.max(0, holding.quantity - operation.quantity);
  if (holding.quantity === 0) deleteHolding(holding.code);
}

// 渲染操作记录，最新记录靠前。
function renderOperations() {
  elements.logSummary.textContent = `${state.operations.length} 条`;
  if (state.operations.length === 0) {
    elements.operationList.innerHTML = `<div class="empty">暂无操作记录。</div>`;
    return;
  }
  elements.operationList.innerHTML = state.operations.slice(0, 40).map(renderOperationItem).join("");
}

// 渲染单条操作记录。
function renderOperationItem(operation) {
  const note = operation.note ? `；备注：${escapeHtml(operation.note)}` : "";
  return `<div class="operation-item"><strong>${operation.time}</strong>${operation.type} ${operation.code} ${escapeHtml(operation.name)}，${operation.quantity} 股，价格 ${formatNumber(operation.price, 3)}${note}</div>`;
}

// 导出当前本地数据，方便备份或换浏览器使用。
function exportState() {
  const payload = {
    strategy: state.strategy,
    holdings: state.holdings,
    operations: state.operations,
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `操盘面板记录-${new Date().toISOString().slice(0, 10)}.json`);
}

// 创建下载链接并自动触发。
function triggerDownload(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// 导入备份数据，只接受结构明确的 JSON。
async function importState(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const payload = JSON.parse(await file.text());
  state.strategy = payload.strategy || state.strategy;
  state.holdings = payload.holdings || state.holdings;
  state.operations = payload.operations || state.operations;
  saveState();
  renderStrategyForm();
  renderOperations();
  await refreshAll();
}

// HTML 转义，避免用户输入备注污染页面结构。
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

initializeApp();
