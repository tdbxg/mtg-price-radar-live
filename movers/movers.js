const state = { data: null, period: "hour", basis: "dollar", format: "all", setCode: "", sldQuery: "" };

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

function currentRows(direction) {
  const period = state.data?.periods?.[state.period] || {};
  const setScope = state.setCode ? period.sets?.[state.setCode] : null;
  const rows = (setScope?.[direction] || period[direction] || []).filter((row) => state.format === "all" || row.formatBucket === state.format);
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

function rowMarkup(row, index) {
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
    <td class="delta ${row.deltaUsd > 0 ? "up" : "down"}">${delta}<small>${state.basis === "percent" ? `${row.deltaUsd > 0 ? "+" : ""}${usd(row.deltaUsd)}` : pct(row.deltaPct)}</small></td>
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
    return !query || text.includes(query);
  });
  const shown = rows.slice(0, 120);
  $("#sldRows").innerHTML = shown.length ? shown.map(sldCatalogMarkup).join("") : `<tr><td class="empty" colspan="6">没有符合条件的 SLD 当前收购记录。</td></tr>`;
  $("#sldCount").textContent = `显示 ${shown.length.toLocaleString("zh-CN")} / ${rows.length.toLocaleString("zh-CN")} 条。默认按当前 CK 回收价从高到低排序。`;
}

function renderBoard(direction, target, countTarget) {
  const rows = currentRows(direction);
  $(countTarget).textContent = `${rows.length} 张`;
  $(target).innerHTML = rows.length
    ? rows.map(rowMarkup).join("")
    : `<tr><td class="empty" colspan="5">暂无可比较的${direction === "winners" ? "上涨" : "下跌"}记录。首次采样后，价格发生变化才会进入榜单。</td></tr>`;
}

function render() {
  if (!state.data) return;
  const meta = state.data.meta || {};
  const period = state.data.periods?.[state.period] || {};
  const setScope = state.setCode ? period.sets?.[state.setCode] : null;
  $("#statusLine").textContent = `每小时采样 · 数据源：${meta.source || "Card Kingdom"} · 追踪开始于 ${formatTime(meta.trackedSince)}`;
  $("#sampleAt").textContent = formatTime(meta.generatedAt);
  $("#activeRows").textContent = Number(meta.activeRows || 0).toLocaleString("zh-CN");
  $("#availableRows").textContent = Number(setScope?.available ?? period.available ?? 0).toLocaleString("zh-CN");
  const baselineMissing = !(setScope?.available ?? period.available);
  $("#notice").hidden = !baselineMissing;
  const setName = selectedSet()?.name || "";
  $("#notice").textContent = baselineMissing ? `${setName ? `${setName} 的` : ""}${labels[state.period]}可比较基准仍在积累。页面已保存首次采样，后续采样发生价格变化时会自动进入榜单。` : "";
  const suffix = state.basis === "percent" ? "按变动比例" : "按美元变动";
  const scopeName = setName ? `${state.setCode.toUpperCase()} · ${setName}` : labels[state.period];
  $("#winnerTitle").textContent = `${scopeName} 上涨榜 · ${suffix}`;
  $("#loserTitle").textContent = `${scopeName} 下跌榜 · ${suffix}`;
  renderBoard("winners", "#winners", "#winnerCount");
  renderBoard("losers", "#losers", "#loserCount");
  renderSldCatalog();
}

async function load() {
  const response = await fetch(`./live.json?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  state.data = await response.json();
  populateSetSelect();
  render();
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
$("#formatSelect").addEventListener("change", (event) => { state.format = event.target.value; render(); });
$("#setSelect").addEventListener("change", (event) => { state.setCode = event.target.value; render(); });
$("#sldSearch").addEventListener("input", (event) => { state.sldQuery = event.target.value; renderSldCatalog(); });
$("#refreshButton").addEventListener("click", () => load().catch((error) => { $("#statusLine").textContent = `刷新失败：${error.message}`; }));
load().catch((error) => { $("#statusLine").textContent = `数据加载失败：${error.message}`; });
