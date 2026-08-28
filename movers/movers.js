const state = { data: null, period: "hour", basis: "dollar", format: "all", setCode: "", finish: "all", sldQuery: "", loading: false };

const $ = (selector) => document.querySelector(selector);
const labels = { hour: "1 小时", day: "24 小时", week: "7 天" };
const formatLabels = { standard: "标准", pioneer: "先驱", modern: "摩登", legacy: "薪传", special: "特选" };
const usd = (value) => `$${Number(value || 0).toFixed(2)}`;
const pct = (value) => `${value > 0 ? "+" : ""}${Number(value || 0).toFixed(1)}%`;
const escapeHtml = (value) => String(value || "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

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

function rowMarkup(row, index, favorable = false) {
  const print = [row.setCode && row.setCode.toUpperCase(), row.collectorNumber && `#${row.collectorNumber}`, row.foil ? "闪" : "平"]
    .filter(Boolean).join(" ");
  const cardName = row.ckUrl
    ? `<a href="${escapeHtml(row.ckUrl)}" target="_blank" rel="noreferrer">${escapeHtml(row.name)}</a>`
    : escapeHtml(row.name);
  const image = row.image
    ? `<img src="${escapeHtml(row.image)}" alt="" loading="lazy">`
    : `<span class="image-fallback">无图</span>`;
  const delta = state.basis === "percent" ? pct(row.deltaPct) : `${row.deltaUsd > 0 ? "+" : ""}${usd(row.deltaUsd)}`;
  return `<tr>
    <td class="rank">${index + 1}</td>
    <td><div class="card-cell">${image}<div><strong>${cardName}</strong>${row.cn ? `<small>${escapeHtml(row.cn)}</small>` : ""}<small>${escapeHtml(print)} ${row.edition ? `· ${escapeHtml(row.edition)}` : ""}</small></div></div></td>
    <td>${usd(row.previousUsd)}</td><td>${usd(row.currentUsd)}</td>
    <td class="delta ${favorable ? "up" : row.deltaUsd > 0 ? "up" : "down"}">${delta}<small>${state.basis === "percent" ? `${row.deltaUsd > 0 ? "+" : ""}${usd(row.deltaUsd)}` : pct(row.deltaPct)}</small></td>
  </tr>`;
}

function sldCatalogMarkup(row) {
  const print = [row.sku, row.collectorNumber && `#${row.collectorNumber}`, row.foil ? "闪" : "平"].filter(Boolean).join(" · ");
  const cardName = row.ckUrl ? `<a href="${escapeHtml(row.ckUrl)}" target="_blank" rel="noreferrer">${escapeHtml(row.name)}</a>` : escapeHtml(row.name);
  const image = row.image ? `<img src="${escapeHtml(row.image)}" alt="" loading="lazy">` : `<span class="image-fallback">无图</span>`;
  const detail = [row.flavorName, row.variation].filter(Boolean).join(" · ") || "-";
  const change = row.hasBaseline
    ? `<span class="delta ${row.deltaUsd > 0 ? "up" : row.deltaUsd < 0 ? "down" : ""}">${row.deltaUsd > 0 ? "+" : ""}${usd(row.deltaUsd)}<small>${pct(row.deltaPct)}</small></span>`
    : `<span class="muted">基准积累中</span>`;
  return `<tr><td><div class="card-cell">${image}<div><strong>${cardName}</strong>${row.cn ? `<small>${escapeHtml(row.cn)}</small>` : ""}<small>${escapeHtml(print)}</small></div></div></td><td>${escapeHtml(detail)}</td><td>${escapeHtml(row.releasedAt || "-")}</td><td>${Number(row.qtyBuying || 0)}</td><td>${usd(row.currentUsd)}</td><td>${change}</td></tr>`;
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
  $("#sldRows").innerHTML = shown.length ? shown.map(sldCatalogMarkup).join("") : `<tr><td class="empty" colspan="6">没有符合条件的 SLD 当前收购记录。</td></tr>`;
  $("#sldCount").textContent = `显示 ${shown.length.toLocaleString("zh-CN")} / ${rows.length.toLocaleString("zh-CN")} 条。默认按当前 CK 回收价从高到低排序。`;
}

function renderBoard(source, direction, target, countTarget, emptyMessage) {
  const rows = currentRows(source, direction);
  $(countTarget).textContent = `${rows.length} 张`;
  $(target).innerHTML = rows.length
    ? rows.map((row, index) => rowMarkup(row, index, true)).join("")
    : `<tr><td class="empty" colspan="5">${emptyMessage}</td></tr>`;
}

function render() {
  if (!state.data) return;
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
$("#formatSelect").addEventListener("change", (event) => { state.format = event.target.value; render(); });
$("#setSelect").addEventListener("change", (event) => { state.setCode = event.target.value; render(); });
$("#sldSearch").addEventListener("input", (event) => { state.sldQuery = event.target.value; renderSldCatalog(); });
$("#refreshButton").addEventListener("click", () => load({ manual: true }));
load();
