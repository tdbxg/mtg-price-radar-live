const state = {
  data: null,
  period: "hour",
  basis: "dollar",
  format: "all",
  setCode: "",
  finish: "all",
  sldQuery: "",
  watchFilter: "all",
  watchQuery: "",
  rowLookup: new Map(),
  loading: false,
};

const WATCHLIST_STORAGE_KEY = "ck-movers-watchlist-v1";
const $ = (selector) => document.querySelector(selector);
const labels = { hour: "1 小时", day: "24 小时", threeDay: "72 小时", week: "7 天" };
const formatLabels = { standard: "标准", pioneer: "先驱", modern: "摩登", legacy: "薪传", special: "特选" };
const usd = (value) => `$${Number(value || 0).toFixed(2)}`;
const pct = (value) => `${value > 0 ? "+" : ""}${Number(value || 0).toFixed(1)}%`;
const escapeHtml = (value) => String(value || "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

function loadWatchStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WATCHLIST_STORAGE_KEY) || "{}");
    return {
      items: parsed.items && typeof parsed.items === "object" ? parsed.items : {},
      dismissed: parsed.dismissed && typeof parsed.dismissed === "object" ? parsed.dismissed : {},
    };
  } catch (_error) {
    return { items: {}, dismissed: {} };
  }
}

const watchStore = loadWatchStore();

function persistWatchStore(showError = false) {
  try {
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchStore));
    return true;
  } catch (error) {
    if (showError) showRefreshFeedback(`关注名单保存失败：${error.message}`, "error");
    return false;
  }
}

function formatTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function scopedPeriod(source) {
  const period = state.data?.periods?.[state.period] || {};
  const sourcePeriod = source === "retail" ? period.retail || {} : period;
  const setScope = state.setCode ? sourcePeriod.sets?.[state.setCode] : null;
  const formatScope = state.format !== "all" ? sourcePeriod.formats?.[state.format] : null;
  return setScope || formatScope || sourcePeriod;
}

function currentRows(source, direction) {
  const scope = scopedPeriod(source);
  const rows = (scope[direction] || []).filter((row) => (
    (state.format === "all" || row.formatBucket === state.format)
    && (state.finish === "all" || (state.finish === "foil" ? row.foil : !row.foil))
  ));
  return rows.sort((a, b) => state.basis === "percent"
    ? Math.abs(b.deltaPct) - Math.abs(a.deltaPct)
    : Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));
}

function selectedSet() {
  return (state.data?.meta?.setCatalog || []).find((item) => item.code === state.setCode);
}

function populateSetSelect() {
  const select = $("#setSelect");
  const catalog = state.data?.meta?.setCatalog || [];
  select.innerHTML = `<option value="">全部系列</option>${catalog.map((item) => `<option value="${escapeHtml(item.code)}">${escapeHtml(item.code.toUpperCase())} · ${escapeHtml(item.name)}${item.releasedAt ? ` · ${escapeHtml(item.releasedAt)}` : ""}</option>`).join("")}`;
  select.value = state.setCode;
}

function watchKey(metric, sku) {
  return `${metric}:${String(sku || "")}`;
}

function cardCellMarkup(row, includeSku = false) {
  const print = [
    includeSku && row.sku,
    row.setCode && row.setCode.toUpperCase(),
    row.collectorNumber && `#${row.collectorNumber}`,
    row.foil ? "闪" : "平",
  ].filter(Boolean).join(" · ");
  const cardName = row.ckUrl
    ? `<a href="${escapeHtml(row.ckUrl)}" target="_blank" rel="noreferrer">${escapeHtml(row.name)}</a>`
    : escapeHtml(row.name);
  const image = row.image
    ? `<img src="${escapeHtml(row.image)}" alt="" loading="lazy">`
    : `<span class="image-fallback">无图</span>`;
  return `<div class="card-cell">${image}<div><strong>${cardName}</strong>${row.cn ? `<small>${escapeHtml(row.cn)}</small>` : ""}<small>${escapeHtml(print)} ${row.edition ? `· ${escapeHtml(row.edition)}` : ""}</small></div></div>`;
}

function watchButtonMarkup(row, metric) {
  const key = watchKey(metric, row.sku);
  const active = Boolean(watchStore.items[key]);
  state.rowLookup.set(key, { row, metric });
  const label = active ? "从关注榜单删除" : "加入关注榜单";
  return `<button class="watch-toggle${active ? " active" : ""}" data-watch-action="toggle" data-watch-key="${escapeHtml(key)}" type="button" aria-label="${label}" aria-pressed="${active}" title="${label}"><span aria-hidden="true">${active ? "★" : "☆"}</span></button>`;
}

function rowMarkup(row, index, favorable = false, metric = "cash") {
  const delta = state.basis === "percent" ? pct(row.deltaPct) : `${row.deltaUsd > 0 ? "+" : ""}${usd(row.deltaUsd)}`;
  return `<tr>
    <td class="rank">${index + 1}</td>
    <td>${cardCellMarkup(row)}</td>
    <td>${usd(row.previousUsd)}</td><td>${usd(row.currentUsd)}</td>
    <td class="delta ${favorable ? "up" : row.deltaUsd > 0 ? "up" : "down"}">${delta}<small>${state.basis === "percent" ? `${row.deltaUsd > 0 ? "+" : ""}${usd(row.deltaUsd)}` : pct(row.deltaPct)}</small></td>
    <td class="watch-action">${watchButtonMarkup(row, metric)}</td>
  </tr>`;
}

function sldCatalogMarkup(row) {
  const detail = [row.flavorName, row.variation].filter(Boolean).join(" · ") || "-";
  const change = row.hasBaseline
    ? `<span class="delta ${row.deltaUsd > 0 ? "up" : row.deltaUsd < 0 ? "down" : ""}">${row.deltaUsd > 0 ? "+" : ""}${usd(row.deltaUsd)}<small>${pct(row.deltaPct)}</small></span>`
    : `<span class="muted">基准积累中</span>`;
  return `<tr><td>${cardCellMarkup(row, true)}</td><td>${escapeHtml(detail)}</td><td>${escapeHtml(row.releasedAt || "-")}</td><td>${Number(row.qtyBuying || 0)}</td><td>${usd(row.currentUsd)}</td><td>${change}</td><td class="watch-action">${watchButtonMarkup(row, "cash")}</td></tr>`;
}

function makeWatchItem(row, metric, source) {
  const observedAt = state.data?.meta?.generatedAt || new Date().toISOString();
  const currentUsd = Number(row.currentUsd || 0);
  const startUsd = source === "auto"
    ? Number(row.streakStartUsd ?? row.previousUsd ?? currentUsd)
    : currentUsd;
  return {
    sku: String(row.sku || ""),
    metric,
    source,
    autoQualified: source === "auto",
    name: row.name || row.sku || "",
    cn: row.cn || "",
    edition: row.edition || "",
    setCode: row.setCode || "",
    collectorNumber: row.collectorNumber || "",
    foil: Boolean(row.foil),
    image: row.image || "",
    ckUrl: row.ckUrl || "",
    variation: row.variation || "",
    flavorName: row.flavorName || "",
    startUsd,
    currentUsd,
    lastDeltaUsd: Number(row.deltaUsd || 0),
    lastDeltaPct: Number(row.deltaPct || 0),
    qtyBuying: Number(row.qtyBuying || 0),
    streakCount: Number(row.streakCount || 0),
    streakStartedAt: row.streakStartedAt || "",
    firstRiseAt: row.firstRiseAt || "",
    lastRiseAt: row.lastRiseAt || "",
    addedAt: observedAt,
    lastObservedAt: observedAt,
  };
}

function updateWatchItem(item, row, observedAt) {
  const textFields = ["name", "cn", "edition", "setCode", "collectorNumber", "image", "ckUrl", "variation", "flavorName"];
  textFields.forEach((field) => { if (row[field]) item[field] = row[field]; });
  item.foil = Boolean(row.foil);
  if (Number.isFinite(Number(row.currentUsd))) item.currentUsd = Number(row.currentUsd);
  if (Number.isFinite(Number(row.deltaUsd))) item.lastDeltaUsd = Number(row.deltaUsd);
  if (Number.isFinite(Number(row.deltaPct))) item.lastDeltaPct = Number(row.deltaPct);
  if (Number.isFinite(Number(row.qtyBuying))) item.qtyBuying = Number(row.qtyBuying);
  if (row.streakCount) item.streakCount = Number(row.streakCount);
  if (row.streakStartedAt) item.streakStartedAt = row.streakStartedAt;
  if (row.firstRiseAt) item.firstRiseAt = row.firstRiseAt;
  if (row.lastRiseAt) item.lastRiseAt = row.lastRiseAt;
  item.lastObservedAt = observedAt;
  return item;
}

function feedRowLookup() {
  const lookup = new Map();
  const add = (row, metric) => {
    const key = watchKey(metric, row?.sku);
    if (row?.sku && !lookup.has(key)) lookup.set(key, row);
  };
  ["hour", "day", "threeDay", "week"].forEach((periodName) => {
    const period = state.data?.periods?.[periodName] || {};
    ["winners", "losers"].forEach((direction) => (period[direction] || []).forEach((row) => add(row, "cash")));
    ["winners", "losers"].forEach((direction) => (period.retail?.[direction] || []).forEach((row) => add(row, "retail")));
  });
  (state.data?.catalogs?.sld || []).forEach((row) => add(row, "cash"));
  (state.data?.watchlist?.auto || []).forEach((row) => add(row, "cash"));
  return lookup;
}

function syncWatchlistFromFeed() {
  const observedAt = state.data?.meta?.generatedAt || new Date().toISOString();
  (state.data?.watchlist?.auto || []).forEach((row) => {
    const key = watchKey("cash", row.sku);
    if (watchStore.dismissed[key]) return;
    if (!watchStore.items[key]) watchStore.items[key] = makeWatchItem(row, "cash", "auto");
    updateWatchItem(watchStore.items[key], row, observedAt);
    watchStore.items[key].autoQualified = true;
  });

  const lookup = feedRowLookup();
  Object.entries(watchStore.items).forEach(([key, item]) => {
    const row = lookup.get(key);
    if (row) updateWatchItem(item, row, observedAt);
  });
  persistWatchStore();
}

function removeWatchItem(key) {
  const item = watchStore.items[key];
  if (!item) return;
  if (item.source === "auto" || item.autoQualified) watchStore.dismissed[key] = true;
  delete watchStore.items[key];
  persistWatchStore(true);
  render();
}

function toggleWatchItem(key) {
  if (watchStore.items[key]) {
    removeWatchItem(key);
    return;
  }
  const source = state.rowLookup.get(key);
  if (!source) return;
  delete watchStore.dismissed[key];
  watchStore.items[key] = makeWatchItem(source.row, source.metric, "manual");
  persistWatchStore(true);
  render();
}

function watchlistMarkup(item) {
  const totalDelta = Number(item.currentUsd || 0) - Number(item.startUsd || 0);
  const totalPct = item.startUsd ? totalDelta / item.startUsd * 100 : 0;
  const sourceLabel = item.source === "auto"
    ? `自动 · 连涨 ${Number(item.streakCount || 2)} 次`
    : `手动 · ${item.metric === "retail" ? "CK 售价" : "回收价"}`;
  const sourceClass = item.source === "auto" ? "auto" : "manual";
  const recentLabel = item.lastRiseAt ? `上涨 ${formatTime(item.lastRiseAt)}` : `采样 ${formatTime(item.lastObservedAt)}`;
  const key = watchKey(item.metric, item.sku);
  return `<tr>
    <td>${cardCellMarkup(item, true)}</td>
    <td><span class="watch-badge ${sourceClass}">${sourceLabel}</span></td>
    <td>${usd(item.startUsd)}</td>
    <td>${usd(item.currentUsd)}</td>
    <td class="delta ${totalDelta > 0 ? "up" : totalDelta < 0 ? "down" : ""}">${totalDelta > 0 ? "+" : ""}${usd(totalDelta)}<small>${pct(totalPct)}</small></td>
    <td class="watch-time">${escapeHtml(recentLabel)}</td>
    <td class="watch-action"><button class="watch-remove" data-watch-action="remove" data-watch-key="${escapeHtml(key)}" type="button" aria-label="从关注榜单删除" title="从关注榜单删除"><span aria-hidden="true">×</span></button></td>
  </tr>`;
}

function renderWatchlist() {
  const rule = state.data?.watchlist?.rule || { windowHours: 72, minConsecutiveRises: 2 };
  $("#watchRule").textContent = `自动关注：${Number(rule.windowHours || 72)} 小时内连续上涨至少 ${Number(rule.minConsecutiveRises || 2)} 次`;
  const query = state.watchQuery.trim().toLowerCase();
  const allItems = Object.values(watchStore.items).filter((item) => item?.sku);
  const filtered = allItems.filter((item) => {
    const matchesSource = state.watchFilter === "all" || item.source === state.watchFilter;
    const text = [item.name, item.cn, item.sku, item.edition, item.setCode, item.collectorNumber, item.variation, item.flavorName].join(" ").toLowerCase();
    return matchesSource && (!query || text.includes(query));
  }).sort((a, b) => {
    const sourceOrder = Number(b.source === "auto") - Number(a.source === "auto");
    if (sourceOrder) return sourceOrder;
    const aDelta = Number(a.currentUsd || 0) - Number(a.startUsd || 0);
    const bDelta = Number(b.currentUsd || 0) - Number(b.startUsd || 0);
    return bDelta - aDelta;
  });
  $("#watchRows").innerHTML = filtered.length
    ? filtered.map(watchlistMarkup).join("")
    : `<tr><td class="empty" colspan="7">暂无符合条件的关注单卡。</td></tr>`;
  $("#watchCount").textContent = `显示 ${filtered.length.toLocaleString("zh-CN")} / ${allItems.length.toLocaleString("zh-CN")} 张`;
}

function renderSldCatalog() {
  const section = $("#sldCatalog");
  const isSld = state.setCode === "sld";
  section.hidden = !isSld;
  if (!isSld) return;
  const query = state.sldQuery.trim().toLowerCase();
  const rows = (state.data?.catalogs?.sld || []).filter((row) => {
    const text = [row.name, row.cn, row.sku, row.collectorNumber, row.variation, row.flavorName].join(" ").toLowerCase();
    const matchesFinish = state.finish === "all" || (state.finish === "foil" ? row.foil : !row.foil);
    return matchesFinish && (!query || text.includes(query));
  });
  const shown = rows.slice(0, 120);
  $("#sldRows").innerHTML = shown.length ? shown.map(sldCatalogMarkup).join("") : `<tr><td class="empty" colspan="7">没有符合条件的 SLD 当前收购记录。</td></tr>`;
  $("#sldCount").textContent = `显示 ${shown.length.toLocaleString("zh-CN")} / ${rows.length.toLocaleString("zh-CN")} 条。默认按当前 CK 回收价从高到低排序。`;
}

function renderBoard(source, direction, target, countTarget, emptyMessage) {
  const rows = currentRows(source, direction);
  $(countTarget).textContent = `${rows.length} 张`;
  $(target).innerHTML = rows.length
    ? rows.map((row, index) => rowMarkup(row, index, true, source)).join("")
    : `<tr><td class="empty" colspan="6">${emptyMessage}</td></tr>`;
}

function render() {
  if (!state.data) return;
  state.rowLookup.clear();
  const meta = state.data.meta || {};
  const cashScope = scopedPeriod("cash");
  const retailScope = scopedPeriod("retail");
  $("#statusLine").textContent = `每小时采样 · 数据源：${meta.source || "Card Kingdom"} · 追踪开始于 ${formatTime(meta.trackedSince)}`;
  $("#sampleAt").textContent = formatTime(meta.generatedAt);
  $("#activeRows").textContent = Number(meta.activeRows || 0).toLocaleString("zh-CN");
  $("#cashUps").textContent = currentRows("cash", "winners").length.toLocaleString("zh-CN");
  $("#retailDrops").textContent = currentRows("retail", "losers").length.toLocaleString("zh-CN");
  const baselineMissing = !cashScope.available && !retailScope.available;
  $("#notice").hidden = !baselineMissing;
  const setName = selectedSet()?.name || "";
  const formatName = state.format !== "all" ? formatLabels[state.format] : "";
  const scopeLabel = setName || formatName;
  $("#notice").textContent = baselineMissing ? `${scopeLabel ? `${scopeLabel} 的` : ""}${labels[state.period]}可比较基准仍在积累。回收价和 CK 售价会分别在后续采样出现实际变化时进入榜单。` : "";
  const suffix = state.basis === "percent" ? "按变动比例" : "按美元变动";
  const scopeName = setName ? `${state.setCode.toUpperCase()} · ${setName}` : (formatName || labels[state.period]);
  $("#winnerTitle").textContent = `${scopeName} · CK 回收价上涨 · ${suffix}`;
  $("#loserTitle").textContent = `${scopeName} · CK 正常售价下跌 · ${suffix}`;
  renderBoard("cash", "winners", "#winners", "#winnerCount", "暂无符合条件的 CK 回收价上涨记录。");
  renderBoard("retail", "losers", "#losers", "#loserCount", "CK 售价降价基准已建立，后续采样出现实际降价时会进入榜单。");
  renderSldCatalog();
  renderWatchlist();
}

function setRefreshState(loading) {
  state.loading = loading;
  const button = $("#refreshButton");
  button.disabled = loading;
  button.setAttribute("aria-busy", String(loading));
  button.classList.toggle("is-loading", loading);
  $("#refreshLabel").textContent = loading ? "正在刷新" : "刷新最新数据";
}

function showRefreshFeedback(message, type = "success") {
  const feedback = $("#refreshFeedback");
  feedback.hidden = false;
  feedback.className = `refresh-feedback ${type}`;
  feedback.textContent = message;
}

async function load({ manual = false } = {}) {
  if (state.loading) return;
  const previousSample = state.data?.meta?.generatedAt || "";
  setRefreshState(true);
  if (manual) showRefreshFeedback("正在获取最新发布的价格数据…", "loading");
  try {
    const response = await fetch(`./live.json?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const nextData = await response.json();
    if (!nextData?.meta?.generatedAt) throw new Error("数据缺少采样时间");
    state.data = nextData;
    syncWatchlistFromFeed();
    populateSetSelect();
    render();
    if (manual) {
      const sample = formatTime(nextData.meta.generatedAt);
      const checked = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      const message = previousSample && previousSample === nextData.meta.generatedAt
        ? `已检查，当前已是最新数据 · 采样 ${sample} · 检查 ${checked}`
        : `已更新到最新数据 · 采样 ${sample} · 检查 ${checked}`;
      showRefreshFeedback(message);
    }
  } catch (error) {
    if (!state.data) $("#statusLine").textContent = `数据加载失败：${error.message}`;
    showRefreshFeedback(`刷新失败，已保留当前榜单：${error.message}`, "error");
  } finally {
    setRefreshState(false);
  }
}

document.querySelectorAll("[data-period]").forEach((button) => button.addEventListener("click", () => {
  state.period = button.dataset.period;
  document.querySelectorAll("[data-period]").forEach((item) => item.classList.toggle("active", item === button));
  render();
}));
document.querySelectorAll("[data-basis]").forEach((button) => button.addEventListener("click", () => {
  state.basis = button.dataset.basis;
  document.querySelectorAll("[data-basis]").forEach((item) => item.classList.toggle("active", item === button));
  render();
}));
document.querySelectorAll("[data-finish]").forEach((button) => button.addEventListener("click", () => {
  state.finish = button.dataset.finish;
  document.querySelectorAll("[data-finish]").forEach((item) => item.classList.toggle("active", item === button));
  render();
}));
document.querySelectorAll("[data-watch-filter]").forEach((button) => button.addEventListener("click", () => {
  state.watchFilter = button.dataset.watchFilter;
  document.querySelectorAll("[data-watch-filter]").forEach((item) => item.classList.toggle("active", item === button));
  renderWatchlist();
}));
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-watch-action]");
  if (!button) return;
  const key = button.dataset.watchKey;
  if (button.dataset.watchAction === "remove") removeWatchItem(key);
  else toggleWatchItem(key);
});
$("#formatSelect").addEventListener("change", (event) => { state.format = event.target.value; render(); });
$("#setSelect").addEventListener("change", (event) => { state.setCode = event.target.value; render(); });
$("#sldSearch").addEventListener("input", (event) => { state.sldQuery = event.target.value; renderSldCatalog(); });
$("#watchSearch").addEventListener("input", (event) => { state.watchQuery = event.target.value; renderWatchlist(); });
$("#refreshButton").addEventListener("click", () => load({ manual: true }));
load();
