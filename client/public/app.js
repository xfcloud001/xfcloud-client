let state = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

/** 安全写入 DOM 属性：选择器找不到元素时不抛错（0.10.0 注册/套餐码逻辑沿用服务端同款 helper）。 */
function setProp(selector, property, value) {
  const el = $(selector);
  if (el == null) return;
  el[property] = value;
}

function icons() {
  window.lucide?.createIcons();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Console-Request": "1",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求失败 (${response.status})`);
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

function toast(message, error = false) {
  const element = document.createElement("div");
  element.className = `toast${error ? " error" : ""}`;
  element.textContent = message;
  $("#toastStack").append(element);
  setTimeout(() => element.remove(), 3_200);
}

function formatDate(value, fallback = "-") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
}

function trafficMarkup(traffic) {
  if (!traffic?.available) {
    const label = traffic?.error ? "采集异常" : "等待采样";
    return `<span class="traffic-unavailable">${label}</span>`;
  }
  if (!traffic.hasMetrics) {
    return '<span class="traffic-unavailable" title="frps 尚未结算该映射的连接流量">暂无已结算流量</span>';
  }
  const title = `累计入站 ${formatBytes(traffic.incomingBytes)}，累计出站 ${formatBytes(
    traffic.outgoingBytes,
  )}`;
  return `
    <div class="traffic-rates" title="${escapeHtml(title)}">
      <span class="traffic-rate incoming">
        <span>入站</span>
        <strong>${escapeHtml(formatBytes(traffic.incomingBytesPerSecond))}/s</strong>
      </span>
      <span class="traffic-rate outgoing">
        <span>出站</span>
        <strong>${escapeHtml(formatBytes(traffic.outgoingBytesPerSecond))}/s</strong>
      </span>
    </div>
  `;
}

function remaining(value) {
  const milliseconds = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "已到期";
  const days = Math.floor(milliseconds / 86_400_000);
  const hours = Math.floor((milliseconds % 86_400_000) / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${Math.max(minutes, 1)} 分钟`;
}

const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 52;

function renderGauge(arcId, valueId, textId, { ratio, value, text, level }) {
  const arc = $(`#${arcId}`);
  const pct = Math.max(0, Math.min(1, Number(ratio) || 0));
  arc.style.strokeDasharray = `${GAUGE_CIRCUMFERENCE.toFixed(2)}`;
  arc.style.strokeDashoffset = (GAUGE_CIRCUMFERENCE * (1 - pct)).toFixed(2);
  arc.classList.remove(
    "level-accent",
    "level-ok",
    "level-warn",
    "level-danger",
    "level-muted",
  );
  arc.classList.add(`level-${level || "ok"}`);
  $(`#${valueId}`).textContent = value;
  $(`#${textId}`).textContent = text;
}

function renderDashboard() {
  if (!state?.user) return; // 未登录/异常会话时无用户数据可渲染
  const ports = state.ports;
  const totalPorts = ports?.totalPorts || 0;
  const usedPorts = ports?.usedCount ?? state.proxies.length;
  const portRatio = totalPorts > 0 ? usedPorts / totalPorts : 0;
  renderGauge("gaugePortsArc", "gaugePortsValue", "gaugePortsText", {
    ratio: portRatio,
    value: String(usedPorts),
    text:
      totalPorts > 0
        ? `在线映射 ${usedPorts} 个 · 授权端口共 ${totalPorts} 个`
        : "暂无授权端口范围",
    level: portRatio >= 1 ? "danger" : portRatio >= 0.8 ? "warn" : "accent",
  });

  const usedBytes = Number(state.user.trafficUsedBytes) || 0;
  const limitBytes = Number(state.user.trafficLimitBytes) || 0;
  if (limitBytes > 0) {
    const trafficRatio = usedBytes / limitBytes;
    renderGauge("gaugeTrafficArc", "gaugeTrafficValue", "gaugeTrafficText", {
      ratio: trafficRatio,
      value: `${Math.round(trafficRatio * 100)}%`,
      text: `已用 ${formatBytes(usedBytes)} / 限额 ${formatBytes(limitBytes)}`,
      level: trafficRatio >= 1 ? "danger" : trafficRatio >= 0.8 ? "warn" : "ok",
    });
  } else {
    renderGauge("gaugeTrafficArc", "gaugeTrafficValue", "gaugeTrafficText", {
      ratio: 0,
      value: "不限",
      text: usedBytes > 0 ? `已用 ${formatBytes(usedBytes)} · 未设置限额` : "未设置流量限额",
      level: "muted",
    });
  }

  const expiresAt = Date.parse(state.user.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    renderGauge("gaugeExpiryArc", "gaugeExpiryValue", "gaugeExpiryText", {
      ratio: 0,
      value: "已到期",
      text: Number.isFinite(expiresAt)
        ? `已于 ${formatDate(state.user.expiresAt)} 到期`
        : "账户已到期，请续费",
      level: "danger",
    });
  } else {
    const createdAt = Date.parse(state.user.createdAt);
    const totalSpan = Number.isFinite(createdAt) ? expiresAt - createdAt : 0;
    const remainingMs = expiresAt - now;
    const ratio = totalSpan > 0 ? remainingMs / totalSpan : 1;
    const days = Math.floor(remainingMs / 86_400_000);
    const hours = Math.floor((remainingMs % 86_400_000) / 3_600_000);
    renderGauge("gaugeExpiryArc", "gaugeExpiryValue", "gaugeExpiryText", {
      ratio,
      value: days > 0 ? `${days}天` : `${Math.max(hours, 1)}时`,
      text: `${formatDate(state.user.expiresAt)} 到期`,
      level: days < 3 ? "danger" : days < 7 ? "warn" : "ok",
    });
  }
}

// 端口建议统一由 syncProxyDialogPorts 按对话框承载节点渲染（0.10.1.0）。

function processStatus(status) {
  const map = {
    // 0.10.1.2 规格4：「已连接」改为「服务已开启」；多进程部分运行单独给出状态。
    running: ["服务已开启", "frpc 正在运行", "success"],
    partial: ["部分服务开启", "部分节点 frpc 未运行，可单独启停或统一重启", "warning"],
    starting: ["正在连接", "frpc 进程正在启动", "info"],
    stopped: ["已停止", "frpc 进程未运行", "warning"],
    missing: ["缺少 frpc", "请先下载 frp 二进制程序", "warning"],
    unauthorized: ["授权失效", "账户已停用或到期", "danger"],
    error: ["运行异常", "查看运行日志获取详情", "danger"],
  };
  return map[status] || ["状态未知", "等待进程状态", ""];
}

function setFavicon(href) {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = href;
}

// 登录流程状态：点击「连接服务端」进入登录页后置 true，
// 状态轮询触发 render() 时保持登录页不被拉回，直到登录成功或返回控制台。
let loginFlowActive = false;

let appliedBrandKey = "";
function applyClientBranding() {
  const branding = state?.branding || {
    name: "",
    logoUrl: null,
    icp: "",
    police: "",
    copyright: { text: "XFCloud Tunnel", url: "" },
  };
  const customName = branding.name?.trim();
  const cpText = (branding.copyright?.text || "").trim() || "XFCloud Tunnel";
  const cpUrl = (branding.copyright?.url || "").trim();
  const key = `${customName}|${branding.logoUrl || ""}|${branding.icp || ""}|${branding.police || ""}|${cpText}|${cpUrl}`;
  if (key === appliedBrandKey) return;
  appliedBrandKey = key;
  const brandName = customName || "XFCloud Tunnel";
  document.title = `${brandName} 客户端`;
  $$(".brand-name").forEach((element) => {
    element.textContent = brandName;
  });
  // 备案旁的版权声明：未连接显示授权中心默认，连接后显示服务端下发的版权。
  $$(".footer-brand").forEach((element) => {
    element.textContent = cpText;
    if (element.tagName === "A") {
      if (cpUrl) {
        element.href = cpUrl;
        element.target = "_blank";
        element.rel = "noopener noreferrer";
        element.classList.add("is-link");
      } else {
        element.removeAttribute("href");
        element.removeAttribute("target");
        element.classList.remove("is-link");
      }
    }
  });
  const icpText = (branding.icp || "").trim();
  $$("[data-icp-link]").forEach((link) => {
    if (icpText) {
      link.textContent = icpText;
      link.href = "https://beian.miit.gov.cn/";
      link.classList.remove("hidden");
    } else {
      link.classList.add("hidden");
    }
  });
  const policeText = (branding.police || "").trim();
  $$("[data-police-link]").forEach((link) => {
    if (policeText) {
      link.textContent = policeText;
      link.href = "https://beian.mps.gov.cn/";
      link.classList.remove("hidden");
    } else {
      link.classList.add("hidden");
    }
  });
  const hasRecord = Boolean(icpText) || Boolean(policeText);
  $$(".record-sep").forEach((sep) => {
    sep.classList.toggle("hidden", !hasRecord);
  });
  $$(".brand-symbol").forEach((symbol) => {
    if (branding.logoUrl) {
      symbol.innerHTML = `<img src="${escapeHtml(branding.logoUrl)}" alt="" />`;
    } else {
      symbol.innerHTML = '<i data-lucide="waypoints"></i>';
    }
  });
  setFavicon(branding.logoUrl || "/favicon.svg");
  if (!branding.logoUrl) icons();
}

function render() {
  applyClientBranding();
  // 0.9.3：本地安全告警（旧明文状态文件残留等），登录/未登录视图下均展示。
  const noticeBanner = $("#securityNoticeBanner");
  if (noticeBanner) {
    const notice = state?.securityNotice || "";
    $("#securityNoticeText").textContent = notice;
    noticeBanner.classList.toggle("hidden", !notice);
  }
  // 0.9.0：已连接但待激活（首次登录/管理员重置密码）——只显示激活页，不进入控制台。
  if (state?.connected && state?.user?.mustChangePassword) {
    loginFlowActive = false;
    $("#loginView").classList.add("hidden");
    $("#appView").classList.add("hidden");
    $("#activateView").classList.remove("hidden");
    return;
  }
  $("#activateView").classList.add("hidden");
  if (!state?.connected || !state?.user) {
    // 免登录直用：部署后直接进入控制台管理本地 frpc，显眼位置提供“连接服务端”入口。
    // 用户主动点击「连接服务端」后处于登录流程中：保持登录页，避免轮询拉回控制台。
    // 会话存在但用户信息缺失（异常会话/服务端踢下线等异步竞态）同样按未连接渲染，
    // 避免后续读取 state.user 时空指针报错。
    if (loginFlowActive) {
      $("#loginView").classList.remove("hidden");
      $("#appView").classList.add("hidden");
      $("#connectError").textContent = state?.sessionError || "";
      return;
    }
    $("#loginView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    $("#connectError").textContent = state?.sessionError || "";
    $("#openConnectBtn").classList.remove("hidden");
    // 未登录仅开放「设置」菜单：隐藏端口映射/运行日志入口。
    $$(".nav-button[data-connect-only]").forEach((button) =>
      button.classList.add("hidden"),
    );
    renderSharedSettings();
    syncFrpcConfigTextarea();
    // 仅在当前停留在需登录的页面（或初始无可见页面）时才回到引导页；
    // 用户已进入「设置」页时保持不动，避免每次状态刷新都被跳回。
    const visible = $(".page-view:not(.hidden)");
    if (!visible || (visible.id !== "settingsView" && visible.id !== "disconnectView")) {
      showDisconnectView();
    }
    return;
  }
  // 已登录：退出登录流程，恢复全部功能菜单。
  loginFlowActive = false;
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  $("#openConnectBtn").classList.add("hidden");
  $$(".nav-button[data-connect-only]").forEach((button) =>
    button.classList.remove("hidden"),
  );
  // 已连接：若仍停留在“未连接引导页”，自动回到端口映射页。
  if (!$("#disconnectView").classList.contains("hidden")) {
    switchView("tunnels");
  }

  $("#accountName").textContent = state.user.username;
  const accountUid = $("#accountUid");
  if (accountUid) accountUid.textContent = state.user.uid ? `ID：${state.user.uid}` : "";
  const settingsUid = $("#settingsUid");
  if (settingsUid) settingsUid.textContent = state.user.uid || "-";
  const settingsUsername = $("#settingsUsername");
  if (settingsUsername) settingsUsername.textContent = state.user.username;
  $("#serverName").textContent = state.serverAddress;
  $("#clientVersion").textContent = state.currentVersion ? `v${state.currentVersion}` : "";
  // 0.10.1.1：登录后只读展示全部已绑定节点及其对应端口（映射管理移到「端口映射」节点分块）。
  const nodes = Array.isArray(state.nodes) ? state.nodes : [];
  $("#nodeNames").textContent = nodes.length
    ? nodes
        .map((node) => (node.isMaster ? node.label || "主节点" : node.label || node.name))
        .join("、")
    : "主节点";
  // 0.10.1.1：每条授权端口段标注所属节点（规格1）。
  const allowedPortsEl = $("#allowedPorts");
  if (nodes.length) {
    allowedPortsEl.innerHTML = nodes
      .map((node) => {
        const label = node.isMaster ? node.label || "主节点" : node.label || node.name;
        return `<span class="port-range-line">${escapeHtml(node.rangesText || "无授权端口")}<em>（${escapeHtml(label)}）</em></span>`;
      })
      .join("");
  } else {
    allowedPortsEl.textContent = state.user.portRangesText || "-";
  }
  $("#expiresAt").textContent = formatDate(state.user.expiresAt);
  $("#timeRemaining").textContent = remaining(state.user.expiresAt);
  $("#proxyCount").textContent = `${state.proxies.length} 条映射`;

  const update = state.update;
  const updateBanner = $("#updateBanner");
  if (update?.hasUpdate) {
    updateBanner.classList.remove("hidden");
    $("#updateBannerText").textContent = `当前 v${state.currentVersion || "?"}，最新 v${update.latestVersion || "?"}`;
  } else {
    updateBanner.classList.add("hidden");
  }
  renderDashboard();

  const [title, detail, className] = processStatus(state.frpc.state);
  $("#connectionTitle").textContent = state.sessionError || title;
  $("#connectionDetail").textContent = `${detail} · ${state.serverAddress}`;
  $("#connectionBanner").className = `connection-banner ${
    className === "success" ? "" : "offline"
  }`.trim();
  $("#startButton").disabled = state.frpc.state === "running" || state.frpc.state === "starting";
  $("#stopButton").disabled = state.frpc.state === "stopped" || state.frpc.state === "missing";
  // 0.10.1.2 规格5：统一重启按钮——缺二进制时不可用，其余状态（含 partial）均可重启。
  const restartButton = $("#restartButton");
  if (restartButton) restartButton.disabled = state.frpc.state === "missing";

  renderSharedSettings();

  // 0.10.1.1：仪表盘（可用节点+端口 / 映射列表）、端口映射（节点分块）、运行日志（多进程页）。
  renderNodePorts();
  renderDashboardProxies();
  renderMappingBlocks();
  renderLogsView();
  // 0.10.2.8：信息中心——侧边栏未读徽标、公告/提醒列表、未读公告自动弹窗。
  renderMessagesCenter();
  icons();
}

// ---------- 0.10.1.1：仪表盘——可用节点 + 各节点可用端口 ----------
function nodeLabel(node) {
  if (!node) return "未知节点";
  return node.isMaster ? node.label || "主节点" : node.label || node.name;
}

function nodePortTotal(node) {
  return (node?.ranges || []).reduce(
    (sum, range) => sum + (Number(range.end) - Number(range.start) + 1),
    0,
  );
}

// 某节点端口占用（本地口径：该节点上已建映射的远程端口集合，含停用映射占位）。
function nodeUsedPorts(nodeName) {
  const used = new Set(
    (state.proxies || [])
      .filter((proxy) => (proxy.node || "master") === nodeName && proxy.remotePort)
      .map((proxy) => proxy.remotePort),
  );
  return used.size;
}

function renderNodePorts() {
  const grid = $("#nodePortsGrid");
  const summary = $("#nodePortsSummary");
  if (!grid) return;
  const nodes = Array.isArray(state.nodes) ? state.nodes : [];
  const online = nodes.filter((node) => node.online !== false).length;
  if (summary) {
    summary.textContent = nodes.length
      ? `${nodes.length} 个可用节点（${online} 个在线） · 共 ${state.proxies.length} 条映射`
      : "当前连接节点的授权端口";
  }
  const list = nodes.length
    ? nodes
    : [
        {
          name: "master",
          isMaster: true,
          label: "主节点",
          host: state.serverAddress,
          rangesText: state.user.portRangesText,
        },
      ];
  grid.innerHTML = list
    .map((node) => {
      const total = nodePortTotal(node);
      const used = nodeUsedPorts(node.name || "master");
      const onlineDot =
        node.online === false
          ? '<span class="node-state-dot offline" title="离线"></span>'
          : '<span class="node-state-dot online" title="在线"></span>';
      const badge = node.isMaster ? '<span class="badge master">主节点</span>' : "";
      const location = node.location ? ` · ${escapeHtml(node.location)}` : "";
      return `
        <article class="node-port-card">
          <div class="node-port-head">
            <div class="node-port-title">
              ${onlineDot}
              <strong>${escapeHtml(nodeLabel(node))}</strong>
              ${badge}
            </div>
            <span class="node-port-host mono">${escapeHtml(node.host || "-")}</span>
          </div>
          <div class="node-port-ranges mono" title="授权端口段">${escapeHtml(node.rangesText || "无授权端口")}</div>
          <div class="node-port-stats">
            <span>映射 ${used} 个</span>
            <span>授权 ${total || "-"} 个端口</span>
            <span>${escapeHtml(location.replace(/^ · /, "")) || ""}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

// ---------- 0.10.1.1：仪表盘——所有映射列表（仅开启中的隧道，点击行跳转定位） ----------
function accessCellMarkup(proxy) {
  const isDomain = proxy.type === "http" || proxy.type === "https";
  if (isDomain) {
    return `<div class="domain-chip-list">${(proxy.domains || [])
      .map(
        (domain) => `
      <button
        type="button"
        class="port-chip port-copy-chip"
        data-copy-domain="${escapeHtml(domain)}"
        data-proxy-scheme="${proxy.type}"
        title="点击复制 ${proxy.type}://${escapeHtml(domain)}"
        aria-label="复制域名访问地址"
      >
        ${escapeHtml(domain)}
        <i data-lucide="copy" class="icon copy-hint"></i>
      </button>`,
      )
      .join("")}</div>`;
  }
  const host = proxy.nodeHost || state.serverAddress || "";
  return `
    <button
      type="button"
      class="port-chip port-copy-chip"
      data-copy-port="${proxy.remotePort}"
      data-copy-host="${escapeHtml(host)}"
      title="点击复制 ${escapeHtml(host)}:${proxy.remotePort}"
      aria-label="复制远程访问地址"
    >
      ${proxy.remotePort}
      <i data-lucide="copy" class="icon copy-hint"></i>
    </button>`;
}

function renderDashboardProxies() {
  const enabled = state.proxies.filter((proxy) => proxy.enabled);
  $("#proxyEmpty").classList.toggle("hidden", enabled.length !== 0);
  $("#dashboardProxyRows").innerHTML = enabled
    .map((proxy) => {
      const nodeEntry = (state.nodes || []).find(
        (node) => node.name === (proxy.node || "master"),
      );
      return `
        <tr class="dashboard-proxy-row" data-jump-proxy="${escapeHtml(proxy.id)}" title="点击前往「端口映射」定位该隧道">
          <td><strong>${escapeHtml(proxy.name)}</strong></td>
          <td><span class="badge info">${escapeHtml(proxy.type.toUpperCase())}</span></td>
          <td class="mono">${escapeHtml(proxy.localIP)}:${proxy.localPort}</td>
          <td>${accessCellMarkup(proxy)}</td>
          <td class="traffic-cell">${trafficMarkup(proxy.traffic)}</td>
          <td>${escapeHtml(nodeEntry ? nodeLabel(nodeEntry) : proxy.node || "master")}</td>
        </tr>
      `;
    })
    .join("");
}

// ---------- 0.10.1.1：端口映射——每台节点一个独立块（规格5-6） ----------
function mappingNodeList() {
  // 有节点列表按节点分块；旧服务端无 nodes 时兜底一个主节点块。
  const nodes = Array.isArray(state?.nodes) ? state.nodes : [];
  if (nodes.length) {
    // 归属节点已从授权中移除的映射，追加一个「已移除节点」块避免映射凭空消失。
    const known = new Set(nodes.map((node) => node.name));
    const orphans = [
      ...new Set(
        state.proxies
          .map((proxy) => proxy.node || "master")
          .filter((name) => !known.has(name)),
      ),
    ];
    return [
      ...nodes,
      ...orphans.map((name) => ({ name, label: `${name}（已移除）`, offline: true })),
    ];
  }
  return [
    {
      name: "master",
      isMaster: true,
      label: "主节点",
      host: state.serverAddress,
      rangesText: state.user.portRangesText,
    },
  ];
}

function mappingRowMarkup(proxy) {
  return `
    <tr data-proxy-row="${escapeHtml(proxy.id)}">
      <td><strong>${escapeHtml(proxy.name)}</strong></td>
      <td><span class="badge info">${escapeHtml(proxy.type.toUpperCase())}</span></td>
      <td class="mono">${escapeHtml(proxy.localIP)}:${proxy.localPort}</td>
      <td>${accessCellMarkup(proxy)}</td>
      <td class="traffic-cell">${trafficMarkup(proxy.traffic)}</td>
      <td>
        <label class="check-row">
          <input
            type="checkbox"
            data-proxy-toggle="${proxy.id}"
            ${proxy.enabled ? "checked" : ""}
            aria-label="启用 ${escapeHtml(proxy.name)}"
          />
          ${proxy.enabled ? "启用" : "停用"}
        </label>
      </td>
      <td>
        <div class="row-actions">
          <button class="button ghost icon-only" data-proxy-action="edit" data-id="${proxy.id}" title="编辑">
            <i data-lucide="pencil" class="icon"></i>
          </button>
          <button class="button ghost icon-only" data-proxy-action="delete" data-id="${proxy.id}" title="删除">
            <i data-lucide="trash-2" class="icon"></i>
          </button>
        </div>
      </td>
    </tr>
  `;
}

function renderMappingBlocks() {
  const wrap = $("#mappingBlocks");
  if (!wrap) return;
  const proxies = state.proxies;
  // 0.10.1.2 规格6：每个节点的 frpc 进程状态（节点块单独启停/重启按钮用）。
  const processByKey = new Map(
    (Array.isArray(state?.frpc?.nodes) ? state.frpc.nodes : []).map((item) => [item.key, item]),
  );
  wrap.innerHTML = mappingNodeList()
    .map((node) => {
      const nodeName = node.name || "master";
      const blockProxies = proxies.filter((proxy) => (proxy.node || "master") === nodeName);
      const rows = blockProxies.map(mappingRowMarkup).join("");
      const onlineDot =
        node.online === false
          ? '<span class="node-state-dot offline" title="离线"></span>'
          : '<span class="node-state-dot online" title="在线"></span>';
      const badge = node.isMaster ? '<span class="badge master">主节点</span>' : "";
      // 规格6：节点有对应 frpc 进程时展示单独管理按钮（无进程的节点无可管理对象）。
      const nodeProcess = processByKey.get(nodeName);
      const nodeState = nodeProcess?.state || "";
      const frpcControls = nodeProcess
        ? `
            <div class="node-frpc-controls" title="该节点 frpc 进程：${escapeHtml(
              { running: "运行中", starting: "启动中", stopped: "已停止", error: "异常", unauthorized: "未授权", missing: "缺 frpc" }[nodeState] || nodeState || "未知",
            )}">
              <span class="node-frpc-state">${escapeHtml(
                { running: "frpc 运行中", starting: "frpc 启动中", stopped: "frpc 已停止", error: "frpc 异常", unauthorized: "frpc 未授权", missing: "缺 frpc" }[nodeState] || "frpc 未知",
              )}</span>
              <button class="button ghost icon-only" type="button" data-node-frpc="start" data-node-key="${escapeHtml(nodeName)}" title="启动该节点 frpc"${
                nodeState === "running" || nodeState === "starting" ? " disabled" : ""
              }>
                <i data-lucide="play" class="icon"></i>
              </button>
              <button class="button ghost icon-only" type="button" data-node-frpc="stop" data-node-key="${escapeHtml(nodeName)}" title="停止该节点 frpc"${
                nodeState === "stopped" || nodeState === "missing" ? " disabled" : ""
              }>
                <i data-lucide="square" class="icon"></i>
              </button>
              <button class="button ghost icon-only" type="button" data-node-frpc="restart" data-node-key="${escapeHtml(nodeName)}" title="重启该节点 frpc"${
                nodeState === "missing" ? " disabled" : ""
              }>
                <i data-lucide="rotate-cw" class="icon"></i>
              </button>
            </div>`
        : "";
      return `
        <section class="panel mapping-node-block" data-node-block="${escapeHtml(nodeName)}">
          <div class="mapping-node-head">
            <div>
              <h3>
                ${onlineDot}
                ${escapeHtml(nodeLabel(node))}
                ${badge}
              </h3>
              <p class="mapping-node-meta">
                <span class="mono">${escapeHtml(node.host || state.serverAddress || "-")}</span>
                · 授权端口 <span class="mono">${escapeHtml(node.rangesText || "无")}</span>
              </p>
            </div>
            <div class="mapping-node-actions">
              ${frpcControls}
              <button class="button" type="button" data-node-add="${escapeHtml(nodeName)}">
                <i data-lucide="plus" class="icon"></i>
                添加映射
              </button>
            </div>
          </div>
          <div class="table-wrap">
            <table class="client-mapping-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>协议</th>
                  <th>本地服务</th>
                  <th>访问方式</th>
                  <th>实时流量</th>
                  <th>状态</th>
                  <th aria-label="操作"></th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
            ${blockProxies.length ? "" : `<div class="empty">该节点暂无映射</div>`}
          </div>
        </section>
      `;
    })
    .join("");
}

// ---------- 0.10.1.1：运行日志——每个 frpc 进程一个页签（规格4） ----------
let activeLogKey = null;

function logTabLabel(entry) {
  if (entry.key === "custom") return "自定义配置";
  const node = (state?.nodes || []).find((item) => item.name === entry.key);
  if (!node) return entry.key;
  return nodeLabel(node);
}

function renderLogsView() {
  const tabs = $("#frpcLogTabs");
  const pre = $("#frpcLogs");
  if (!tabs || !pre) return;
  const processes = Array.isArray(state?.frpc?.nodes) ? state.frpc.nodes : [];
  if (!processes.length) {
    tabs.classList.add("hidden");
    tabs.innerHTML = "";
    pre.textContent = state?.frpc?.logs?.join("\n") || "暂无日志";
    return;
  }
  if (!processes.some((item) => item.key === activeLogKey)) {
    activeLogKey = processes[0].key;
  }
  tabs.classList.remove("hidden");
  tabs.innerHTML = processes
    .map((item) => {
      const stateName = {
        running: "运行中",
        starting: "启动中",
        stopped: "已停止",
        error: "异常",
        unauthorized: "未授权",
        missing: "缺 frpc",
      }[item.state] || item.state;
      return `
        <button
          type="button"
          class="log-tab${item.key === activeLogKey ? " active" : ""}"
          data-log-tab="${escapeHtml(item.key)}"
          title="${escapeHtml(stateName)}"
        >
          ${escapeHtml(logTabLabel(item))}
          <span class="log-tab-state">${escapeHtml(stateName)}</span>
        </button>
      `;
    })
    .join("");
  const active = processes.find((item) => item.key === activeLogKey);
  pre.textContent = active?.logs.join("\n") || "暂无日志";
}

// 规格9：仪表盘点击隧道 → 跳转「端口映射」对应节点块并高亮定位。
function jumpToProxy(proxyId) {
  const proxy = state.proxies.find((item) => item.id === proxyId);
  if (!proxy) return;
  switchView("mapping");
  requestAnimationFrame(() => {
    const row = document.querySelector(`[data-proxy-row="${CSS.escape(proxyId)}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.remove("highlight-row");
    void row.offsetWidth; // 重启动画
    row.classList.add("highlight-row");
  });
}

// 设置页在“已连接 / 未连接”两种状态下都可见，其中的版本、frpc 状态统一在此渲染。
function renderSharedSettings() {
  // 0.9.0：账户卡片仅已连接且已激活时显示。
  const accountReady = Boolean(state?.connected && state?.user && !state.user.mustChangePassword);
  $("#accountCard").classList.toggle("hidden", !accountReady);
  $("#settingsUsername").textContent = state?.user?.username || "-";
  $("#settingsCurrentVersion").textContent = state?.currentVersion
    ? `v${state.currentVersion}`
    : "-";
  const update = state?.update;
  const banner = $("#settingsUpdateBanner");
  if (update?.hasUpdate) {
    banner.classList.remove("hidden");
    $("#settingsUpdateText").textContent = `当前 v${state?.currentVersion || "?"}，最新 v${update.latestVersion || "?"}`;
  } else {
    banner.classList.add("hidden");
  }
  // 授权中心填写的更新日志随更新信息下发，有新版本且有日志时展示。
  const changelogWrap = $("#settingsUpdateChangelogWrap");
  if (changelogWrap) {
    const changelog = String(update?.changelog || "").trim();
    $("#settingsUpdateChangelog").textContent = changelog;
    changelogWrap.classList.toggle("hidden", !(update?.hasUpdate && changelog));
  }

  const frpcState = state?.frpc?.state;
  const frpcStatusText = {
    running: "运行中",
    stopped: "已安装，未启动",
    missing: "未安装",
    error: "启动失败",
    starting: "启动中",
    unauthorized: "账号未授权",
  }[frpcState] || frpcState || "检测中...";
  $("#frpcCurrentStatus").textContent = frpcStatusText;
  $("#frpcCurrentVersion").textContent = state?.frpc?.version || "-";
  $("#frpcBinaryPath").textContent = state?.frpc?.binary || "-";
  const pullBtn = $("#pullFrpcButton");
  const serverFrpc = state?.serverFrpc;
  if (serverFrpc?.available) {
    pullBtn.disabled = false;
    pullBtn.textContent = `从服务端拉取${serverFrpc.version ? ` (v${serverFrpc.version})` : ""}`;
  } else {
    pullBtn.disabled = true;
    pullBtn.textContent = "服务端暂未提供 frpc";
  }

  // 未连接时显示“frpc 配置文件”卡片；连接后配置由服务端自动生成。
  $("#frpcConfigCard").classList.toggle("hidden", Boolean(state?.connected));
  // 0.10.0.1：frpc 本机锁面板——仅未登录时展示，按解锁状态切换表单。
  const lockPanel = $("#frpcLockPanel");
  if (lockPanel) {
    lockPanel.classList.toggle("hidden", Boolean(state?.connected));
    const unlocked = Boolean(state?.frpcLock?.unlocked) || Boolean(state?.connected);
    $("#frpcLockLockedArea").classList.toggle("hidden", unlocked);
    $("#frpcLockUnlockedArea").classList.toggle("hidden", !unlocked);
  }
  // 未登录且未解锁时禁用 frpc 变更操作（后端同样拦截，双保险）。
  const frpcLocked = !state?.connected && !state?.frpcLock?.unlocked;
  $("#saveFrpcConfigButton").disabled = frpcLocked;
  $("#startCustomFrpcButton").disabled =
    frpcLocked ||
    frpcState === "running" ||
    frpcState === "starting" ||
    frpcState === "missing";
  $("#stopCustomFrpcButton").disabled =
    frpcLocked ||
    frpcState === "stopped" ||
    frpcState === "missing";
  const configStateText = {
    running: "运行中",
    starting: "启动中",
    stopped: "已停止",
    missing: "缺少 frpc（请先在下方安装）",
    error: "启动出错，请查看运行日志",
    unauthorized: "等待授权",
  }[frpcState] || frpcState || "检测中...";
  const configStateEl = $("#frpcConfigState");
  if (configStateEl) configStateEl.textContent = configStateText;
  // 未连接时在配置卡片内展示 frpc 日志，配置错误（如 TOML 格式、端口占用）能直接看到原因。
  const logsWrap = $("#frpcConfigLogsWrap");
  const logsPre = $("#frpcConfigLogs");
  if (logsWrap && logsPre) {
    const logs = state?.frpc?.logs || [];
    logsWrap.classList.toggle("hidden", logs.length === 0);
    logsPre.textContent = logs.slice(-30).join("\n");
  }
}

// 拉取未登录自定义 frpc 配置填入文本框；用户正在编辑时不覆盖。
let loadedFrpcConfig = null;
async function syncFrpcConfigTextarea() {
  if (state?.connected) return;
  const textarea = $("#frpcConfigText");
  // 0.10.0.1：锁定时清空并禁用配置编辑框（后端同样拦截读取，双保险）。
  if (!state?.frpcLock?.unlocked) {
    textarea.value = "";
    textarea.disabled = true;
    loadedFrpcConfig = "";
    return;
  }
  textarea.disabled = false;
  if (document.activeElement === textarea) return;
  if (loadedFrpcConfig !== null && textarea.value === loadedFrpcConfig) return;
  if (loadedFrpcConfig !== null) return; // 用户已手动修改，不再覆盖
  try {
    const data = await api("/api/frpc/config");
    loadedFrpcConfig = data.custom || "";
    textarea.value = loadedFrpcConfig;
  } catch {
    // 拉取失败时保留空文本框，不打断界面。
  }
}

async function loadState() {
  try {
    state = await api("/api/state");
    render();
  } catch (error) {
    toast(error.message, true);
  }
}

function syncProxyTypeFields() {
  const type = $("#proxyType").value;
  const isDomain = type === "http" || type === "https";
  $("#remotePortField").classList.toggle("hidden", isDomain);
  $("#domainsField").classList.toggle("hidden", !isDomain);
  // hidden 字段不参与表单原生必填校验，避免 tcp/udp 时空域名拦截提交。
  $("#remotePort").required = !isDomain;
  $("#proxyDomains").required = isDomain;
}

function openProxyDialog(proxy = null, nodeKey = null) {
  $("#proxyDialogTitle").textContent = proxy ? "编辑映射" : "新建映射";
  $("#proxyId").value = proxy?.id || "";
  $("#proxyName").value = proxy?.name || "";
  // 0.10.1.1：承载节点由入口决定（节点块「添加映射」/编辑时归属节点），只读锁定。
  const dialogNode = proxy?.node || nodeKey || state.selectedNode || "master";
  $("#proxyNode").value = dialogNode;
  $("#proxyNodeName").textContent = nodeLabel(
    currentNodeEntry(dialogNode) || { name: dialogNode, label: dialogNode },
  );
  // 0.9.3：未获 HTTP/HTTPS 授权时置灰域名隧道选项。
  const httpAllowed = Boolean(state.user?.httpAllowed);
  const typeSelect = $("#proxyType");
  for (const option of typeSelect.options) {
    if (option.value === "http" || option.value === "https") {
      option.disabled = !httpAllowed;
      option.textContent = `${option.value === "http" ? "HTTP" : "HTTPS"}（域名）${
        httpAllowed ? "" : " · 未授权"
      }`;
    }
  }
  $("#proxyTypeHint").classList.toggle("hidden", httpAllowed);
  const initialType = proxy?.type || "tcp";
  typeSelect.value =
    !httpAllowed && (initialType === "http" || initialType === "https") ? "tcp" : initialType;
  $("#localIP").value = proxy?.localIP || "127.0.0.1";
  $("#localPort").value = proxy?.localPort || "";
  $("#remotePort").value = proxy?.remotePort || "";
  $("#proxyDomains").value = Array.isArray(proxy?.domains) ? proxy.domains.join(", ") : "";
  $("#proxyEnabled").checked = proxy?.enabled ?? true;
  $("#proxyFormError").textContent = "";
  $("#remotePortPick").value = "";
  syncProxyTypeFields();
  syncProxyDialogPorts(dialogNode);
  $("#proxyDialog").showModal();
}

async function saveProxy(event) {
  event.preventDefault();
  const id = $("#proxyId").value;
  const type = $("#proxyType").value;
  const isDomain = proxyTypeIsDomain(type);
  const payload = {
    name: $("#proxyName").value,
    type,
    localIP: $("#localIP").value,
    localPort: Number($("#localPort").value),
    remotePort: isDomain ? null : Number($("#remotePort").value),
    domains: isDomain ? $("#proxyDomains").value : [],
    enabled: $("#proxyEnabled").checked,
    // 0.10.1.1：映射归属节点 = 对话框锁定的承载节点（端口映射页节点分块入口）。
    node: $("#proxyNode").value || "master",
  };
  $("#proxyFormError").textContent = "";
  const submitButtons = $$("#proxyForm button[type='submit']");
  submitButtons.forEach((button) => (button.disabled = true));
  try {
    await api(id ? `/api/proxies/${id}` : "/api/proxies", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    $("#proxyDialog").close();
    toast(id ? "映射已更新" : "映射已创建");
    await loadState();
  } catch (error) {
    $("#proxyFormError").textContent = error.message;
    await loadState();
  } finally {
    submitButtons.forEach((button) => (button.disabled = false));
  }
}

function proxyTypeIsDomain(type) {
  return type === "http" || type === "https";
}

async function updateProxy(proxy, patch) {
  try {
    await api(`/api/proxies/${proxy.id}`, {
      method: "PUT",
      body: JSON.stringify({ ...proxy, ...patch }),
    });
    await loadState();
  } catch (error) {
    toast(error.message, true);
    await loadState();
  }
}

$("#connectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#connectError").textContent = "";
  const button = event.submitter;
  button.disabled = true;
  try {
    state = await api("/api/connect", {
      method: "POST",
      body: JSON.stringify({
        serverAddress: $("#serverAddress").value,
        username: $("#username").value,
        password: $("#password").value,
      }),
    });
    $("#password").value = "";
    render();
    // 登录成功后跳转到仪表盘；待激活用户由 render() 留在激活页。
    if (state?.connected && !state.user?.mustChangePassword) switchView("tunnels");
  } catch (error) {
    // 规格11：连接失败（原主节点 IP 失效等）提示可重输新 IP 或点「登录集群」自动获取新主节点。
    $("#connectError").textContent = `${error.message}（可重新输入节点 IP，或在右侧服务器列表点「登录集群」自动获取最新主节点地址）`;
  } finally {
    button.disabled = false;
  }
});

// 0.10.1.0：节点选择移入「新建映射」对话框——授权多个节点时才显示选择器；
// 单节点免选直接展示该节点可用端口。切换选项时同步刷新端口建议。
function currentNodeEntry(name) {
  const nodes = Array.isArray(state?.nodes) ? state.nodes : [];
  return nodes.find((node) => node.name === name) || null;
}

// 目标节点的可用端口（本地计算：该节点授权段 - 该节点已建映射端口），用于映射对话框端口建议。
function nodeAvailablePorts(nodeEntry) {
  const nodeName = nodeEntry?.name || "master";
  const used = new Set(
    (state.proxies || [])
      .filter(
        (proxy) => (proxy.node || "master") === nodeName && proxy.remotePort,
      )
      .map((proxy) => proxy.remotePort),
  );
  const result = [];
  for (const range of nodeEntry?.ranges || []) {
    for (let port = Number(range.start); port <= Number(range.end) && result.length < 200; port += 1) {
      if (!used.has(port)) result.push(port);
    }
  }
  return result;
}

// 按对话框锁定的承载节点刷新端口建议（规格6：添加/修改只能用该节点对应端口）。
function syncProxyDialogPorts(dialogNode) {
  const nodeKey = dialogNode || state.selectedNode || "master";
  const isCurrent = nodeKey === (state.selectedNode || "master");
  const available = isCurrent
    ? state.ports?.availablePorts || []
    : nodeAvailablePorts(currentNodeEntry(nodeKey) || { name: nodeKey, ranges: [] });
  $("#remotePortOptions").innerHTML = available
    .map((port) => `<option value="${port}"></option>`)
    .join("");
  $("#remotePortPick").innerHTML =
    `<option value="">可用端口 ▾</option>` +
    available
      .slice(0, 50)
      .map((port) => `<option value="${port}">${port}</option>`)
      .join("");
  const chips = $("#portSuggestions");
  if (available.length === 0) {
    chips.innerHTML = '<span class="port-suggest-empty">该节点授权范围内暂无可用端口</span>';
    return;
  }
  const estimated = isCurrent ? state.ports?.estimated : true;
  chips.innerHTML =
    `<span class="port-suggest-label">${estimated ? "推荐（本机数据）：" : "推荐："}</span>` +
    available
      .slice(0, 8)
      .map(
        (port) =>
          `<button type="button" class="port-chip" data-port="${port}">${port}</button>`,
      )
      .join("");
}

$("#logoutButton").addEventListener("click", async () => {
  if (!confirm("退出并停止当前连接？")) return;
  state = await api("/api/disconnect", { method: "POST" });
  render();
});

$("#renewButton").addEventListener("click", () => {
  const url = state?.renewalUrl;
  if (!url) {
    toast("管理员未设置续费地址", true);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
});

$("#applyClientUpdateButton").addEventListener("click", () => applyClientUpdate());

async function applyClientUpdate() {
  if (!confirm("确认在线更新？客户端将下载并替换文件后自动重启。")) return;
  const buttons = [$("#applyClientUpdateButton"), $("#applySettingsUpdateButton")].filter(Boolean);
  buttons.forEach((button) => (button.disabled = true));
  try {
    await api("/api/update", { method: "POST", body: "{}" });
    toast("更新已启动，约 5 秒后客户端重启；如长时间无响应请手动启动");
  } catch (error) {
    toast(error.message, true);
    buttons.forEach((button) => (button.disabled = false));
  }
}

// 检测版本更新：已连接时读取服务端心跳下发的信息；未连接时直接向授权中心查询。
$("#checkUpdateButton").addEventListener("click", async () => {
  const button = $("#checkUpdateButton");
  const message = $("#updateCheckMessage");
  button.disabled = true;
  message.textContent = "正在检测版本更新...";
  try {
    const data = await api("/api/update/check", { method: "POST", body: "{}" });
    state = data.state || state;
    render();
    const info = data.info;
    if (info?.hasUpdate) {
      message.textContent = `发现新版本 v${info.latestVersion || "?"}，可点击“在线更新”立即升级。`;
      toast(`发现新版本 v${info.latestVersion || "?"}`);
    } else {
      message.textContent = info?.latestVersion
        ? `当前已是最新版本（v${info.currentVersion || state.currentVersion}）。`
        : "当前已是最新版本。";
      toast("当前已是最新版本");
    }
  } catch (error) {
    message.textContent = `检测失败：${error.message}`;
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#applySettingsUpdateButton").addEventListener("click", () => applyClientUpdate());

// 未登录自定义 frpc 配置文件：保存 / 启动 / 停止。
$("#saveFrpcConfigButton").addEventListener("click", async () => {
  const button = $("#saveFrpcConfigButton");
  const msg = $("#frpcConfigMessage");
  msg.textContent = "";
  const config = $("#frpcConfigText").value;
  if (!config.trim()) {
    msg.textContent = "请填写 frpc 配置内容（TOML 格式）";
    return;
  }
  button.disabled = true;
  try {
    const data = await api("/api/frpc/config", {
      method: "POST",
      body: JSON.stringify({ config }),
    });
    loadedFrpcConfig = config;
    state = data.state || state;
    render();
    toast("frpc 配置已保存");
  } catch (error) {
    msg.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#startCustomFrpcButton").addEventListener("click", async () => {
  const button = $("#startCustomFrpcButton");
  const msg = $("#frpcConfigMessage");
  msg.textContent = "";
  const config = $("#frpcConfigText").value;
  if (!config.trim()) {
    msg.textContent = "请先填写 frpc 配置内容（TOML 格式）";
    return;
  }
  button.disabled = true;
  try {
    // 启动前先保存当前编辑的配置：此前必须手动点「保存配置」再启动，
    // 否则后端拿到的仍是旧配置（或空配置），导致“填写后无法运行”。
    const saved = await api("/api/frpc/config", {
      method: "POST",
      body: JSON.stringify({ config }),
    });
    loadedFrpcConfig = config;
    state = saved.state || state;
    state = await api("/api/frpc/start", { method: "POST" });
    render();
    toast("frpc 启动指令已下发");
  } catch (error) {
    msg.textContent = error.message;
  } finally {
    // 以最新状态恢复按钮可用性（运行中/启动中保持禁用）。
    const frpcState = state?.frpc?.state;
    button.disabled =
      frpcState === "running" || frpcState === "starting" || frpcState === "missing";
  }
});

$("#stopCustomFrpcButton").addEventListener("click", async () => {
  state = await api("/api/frpc/stop", { method: "POST" });
  render();
});

// 0.10.0.1：frpc 本机锁——解锁 / 重新锁定。
$("#frpcUnlockButton").addEventListener("click", async () => {
  const button = $("#frpcUnlockButton");
  const msg = $("#frpcLockMessage");
  msg.textContent = "";
  const password = $("#frpcLockPassword").value;
  if (!password) {
    msg.textContent = "请输入锁密码";
    return;
  }
  button.disabled = true;
  try {
    const data = await api("/api/frpc/unlock", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    $("#frpcLockPassword").value = "";
    state = data.state || state;
    render();
    loadedFrpcConfig = null;
    await syncFrpcConfigTextarea();
    toast("frpc 已解锁");
  } catch (error) {
    msg.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#frpcLockPassword").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    $("#frpcUnlockButton").click();
  }
});

$("#frpcRelockButton").addEventListener("click", async () => {
  const button = $("#frpcRelockButton");
  button.disabled = true;
  try {
    const data = await api("/api/frpc/lock", { method: "POST" });
    state = data.state || state;
    render();
    toast("frpc 已重新锁定");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

// ---------- 0.10.2.8：信息中心（服务端公告 + 本地运行提醒） ----------
function noticeCardHtml(item) {
  return `
    <article class="message-item ${item.level === "warn" ? "warn" : "info"}">
      <div class="message-item-head">
        <span class="message-level">${escapeHtml(item.level === "warn" ? "重要" : "公告")}</span>
        <time class="mono">${escapeHtml(formatDate(item.createdAt))}</time>
      </div>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.content)}</p>
    </article>`;
}

function runtimeMessageCardHtml(item) {
  const count = Number(item.count) > 1 ? ` · 共 ${item.count} 次` : "";
  return `
    <article class="message-item ${item.level === "warn" ? "warn" : "error"}">
      <div class="message-item-head">
        <span class="message-level">${escapeHtml((item.level === "warn" ? "警告" : "错误") + count)}</span>
        <time class="mono">${escapeHtml(formatDate(item.createdAt))}</time>
      </div>
      <p>${escapeHtml(item.text)}</p>
    </article>`;
}

function renderMessagesCenter() {
  // 侧边栏未读徽标（主流站模式：有未读显示数字，查看后消失）。
  const unread = state?.unread || {};
  const total = Number(unread.total) || 0;
  const badge = $("#messagesNavBadge");
  if (badge) {
    badge.textContent = total > 99 ? "99+" : String(total);
    badge.classList.toggle("hidden", total === 0);
  }
  const notices = Array.isArray(state?.notices) ? state.notices : [];
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  const noticeList = $("#noticeList");
  if (noticeList) {
    setProp("#noticeListMeta", "textContent", notices.length ? `${notices.length} 条` : "");
    noticeList.innerHTML = notices.length
      ? notices.map(noticeCardHtml).join("")
      : '<p class="empty">暂无公告</p>';
  }
  const messageList = $("#runtimeMessageList");
  if (messageList) {
    setProp("#runtimeMessageMeta", "textContent", messages.length ? `${messages.length} 条` : "");
    messageList.innerHTML = messages.length
      ? messages.map(runtimeMessageCardHtml).join("")
      : '<p class="empty">暂无运行提醒</p>';
  }
  maybeShowNoticeDialog();
}

// 未读公告自动弹窗：发现未读公告时弹出一次；同一批未关闭前不重复打扰，关闭后有新公告再弹。
let noticeDialogShownKey = "";

function maybeShowNoticeDialog() {
  const dialog = $("#noticeDialog");
  if (!dialog || dialog.open) return;
  const ids = state?.unread?.noticeIds || [];
  if (!ids.length) return;
  const key = ids.join(",");
  if (key === noticeDialogShownKey) return;
  noticeDialogShownKey = key;
  const byId = new Map((state?.notices || []).map((item) => [String(item.id), item]));
  const items = ids.map((id) => byId.get(id)).filter(Boolean);
  const list = $("#noticeDialogList");
  if (list) list.innerHTML = items.map(noticeCardHtml).join("");
  icons();
  dialog.showModal();
}

// 标记已读：scope=notices 仅公告；scope=all 连同本地运行提醒（进入信息中心即全部已读）。
async function markMessagesRead(scope = "all") {
  try {
    state = await api("/api/messages/read", {
      method: "POST",
      body: JSON.stringify({ scope }),
    });
    render();
  } catch (error) {
    toast(error.message, true);
  }
}

function switchView(name) {
  $$(".page-view").forEach((element) => element.classList.add("hidden"));
  const target = $(`#${name}View`);
  if (target) target.classList.remove("hidden");
  $$(".nav-button").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === name);
  });
  // 0.10.2.8：进入信息中心即全部已读（徽标随之消失，参考主流站行为）。
  if (name === "messages") void markMessagesRead("all");
}

// 未连接引导页：替代端口映射/日志页，提示先连接服务端。
function showDisconnectView() {
  $$(".page-view").forEach((element) => element.classList.add("hidden"));
  $("#disconnectView").classList.remove("hidden");
  $$(".nav-button").forEach((item) => item.classList.remove("active"));
}

function openLoginView() {
  // 进入登录流程：后续状态轮询保持登录页，登录成功或返回控制台时结束流程。
  loginFlowActive = true;
  render();
  loadServerDirectory();
}

function backToConsole() {
  loginFlowActive = false;
  render();
}

// ---------- 0.9.5：登录页「服务器列表」 ----------
// 数据来自授权中心公开目录（客户端本地后端代理）：仅含已激活许可/免费额度的服务端，
// 展示 IP / 服务器位置 / 优惠信息，点击卡片自动填入服务器地址。
// 0.10.1.0：集群卡片紧凑化——只显示集群名与在线节点数，不逐台列出节点。
const SERVERS_PAGE_SIZE = 9;
let serversList = [];
let serversPage = 1;

// 将目录拆分为集群组与单机条目：集群组含主节点（目录条目）及其从节点主机列表。
function buildServerEntries() {
  const clusters = new Map();
  const standalones = [];
  for (const server of serversList) {
    if (server.clusterName) {
      if (!clusters.has(server.clusterName)) {
        clusters.set(server.clusterName, { name: server.clusterName, servers: [] });
      }
      clusters.get(server.clusterName).servers.push(server);
    } else {
      standalones.push(server);
    }
  }
  return [...clusters.values(), ...standalones];
}

function renderServerCard(server) {
  const meta = [];
  if (server.location) {
    meta.push(
      `<span class="server-location"><i data-lucide="map-pin" class="icon"></i>${escapeHtml(server.location)}</span>`,
    );
  }
  if (server.promo) meta.push(`<span class="server-promo">${escapeHtml(server.promo)}</span>`);
  const statusDot =
    server.online === null
      ? ""
      : `<span class="server-status ${server.online ? "online" : ""}" title="${server.online ? "在线" : "离线"}"></span>`;
  return `
    <div class="server-card" data-server-address="${escapeHtml(server.ip || "")}" role="button" tabindex="0"
      title="点击填入 ${escapeHtml(server.ip)}">
      <span class="server-card-row">
        <span class="server-icon"><i data-lucide="server" class="icon"></i></span>
        <span class="server-main">
          <span class="server-ip">${escapeHtml(server.ip)}</span>
          <span class="server-meta">${meta.join("") || "<span>点击选择此服务器</span>"}</span>
        </span>
        ${statusDot}
      </span>
    </div>`;
}

// 0.10.1.0：集群卡片紧凑化——只展示集群名与在线节点数，不再逐台列出节点；
// 「去集群注册」改为「登录集群」：点击后自动填入该集群主节点 IP 并聚焦登录表单。
function renderClusterBlock(cluster) {
  const master = cluster.servers[0];
  const slaves = Array.isArray(master?.clusterNodes) ? master.clusterNodes : [];
  const hostRows = [
    ...cluster.servers.map((server) => ({ online: server.online })),
    ...slaves.map((node) => ({ online: Boolean(node.online) })),
  ];
  const totalCount = hostRows.length;
  const onlineCount = hostRows.filter((row) => row.online === true).length;
  const location = master?.location || "";
  // 0.10.2.0：「登录集群」优先用集群 id——主节点切换后客户端凭 id 自动跟随新主；
  // 旧授权中心无集群 id 时回退主节点地址。
  const clusterId = master?.clusterId || "";
  const clusterLoginAddress = clusterId || master?.clusterMasterAddress || master?.ip || "";
  return `
    <div class="cluster-block">
      <div class="cluster-block-head cluster-compact">
        <span class="cluster-block-title">
          <i data-lucide="network" class="icon"></i>${escapeHtml(cluster.name)}${location ? `<span class="cluster-host-location">${escapeHtml(location)}</span>` : ""}
        </span>
        <span class="cluster-block-meta">
          <span class="server-status ${onlineCount ? "online" : ""}" title="${onlineCount ? "有节点在线" : "暂无节点在线"}"></span>
          ${totalCount} 节点 · ${onlineCount} 在线${
            // 0.10.0.2：集群信息处展示集群优惠信息（主节点 promo 字段）。
            master?.promo ? ` · <span class="server-promo">${escapeHtml(master.promo)}</span>` : ""
          }${clusterId ? ` · <span class="server-promo mono">ID ${escapeHtml(clusterId)}</span>` : ""}
        </span>
        ${
          clusterLoginAddress
            ? `<button type="button" class="server-register-btn" data-cluster-login="${escapeHtml(clusterLoginAddress)}" title="${clusterId ? "用集群 ID 登录（主节点切换自动跟随）" : "填入集群主节点地址并登录"}">
                <i data-lucide="log-in" class="icon"></i>登录集群
              </button>`
            : ""
        }
      </div>
    </div>`;
}

function renderServersPage() {
  const grid = $("#serverDirectoryGrid");
  const pager = $("#serverDirectoryPager");
  const info = $("#serversPageInfo");
  const prev = $("#serversPrevBtn");
  const next = $("#serversNextBtn");
  const entries = buildServerEntries();
  const totalPages = Math.max(1, Math.ceil(entries.length / SERVERS_PAGE_SIZE));
  serversPage = Math.min(Math.max(1, serversPage), totalPages);
  const start = (serversPage - 1) * SERVERS_PAGE_SIZE;
  grid.innerHTML = entries
    .slice(start, start + SERVERS_PAGE_SIZE)
    .map((entry) => (entry.name ? renderClusterBlock(entry) : renderServerCard(entry)))
    .join("");
  const showPager = entries.length > SERVERS_PAGE_SIZE;
  pager.classList.toggle("hidden", !showPager);
  if (showPager) {
    info.textContent = `${serversPage} / ${totalPages} 页`;
    prev.disabled = serversPage <= 1;
    next.disabled = serversPage >= totalPages;
  }
  icons();
}

function serverHostTotal(entries) {
  return entries.reduce((sum, entry) => {
    if (!entry.name) return sum + 1;
    const slaves = entry.servers[0]?.clusterNodes;
    return sum + entry.servers.length + (Array.isArray(slaves) ? slaves.length : 0);
  }, 0);
}

// 0.10.1.0：目录统计口径——集群分组时显示集群数与在线节点数，不再统计「台主机」。
function directoryTotalText(entries) {
  const clusters = entries.filter((entry) => entry.name);
  const standalones = entries.length - clusters.length;
  const nodeTotal = serverHostTotal(entries);
  const onlineTotal = entries.reduce((sum, entry) => {
    if (!entry.name) return sum + (entry.servers[0]?.online === true ? 1 : 0);
    const master = entry.servers[0];
    const slaves = Array.isArray(master?.clusterNodes) ? master.clusterNodes : [];
    return (
      sum +
      entry.servers.filter((server) => server.online === true).length +
      slaves.filter((node) => Boolean(node.online)).length
    );
  }, 0);
  if (clusters.length && !standalones) {
    return `${clusters.length} 个集群 · ${nodeTotal} 节点 · ${onlineTotal} 在线`;
  }
  if (clusters.length && standalones) {
    return `${clusters.length} 个集群 · ${standalones} 单机 · ${onlineTotal} 在线`;
  }
  return `${nodeTotal} 台服务器 · ${onlineTotal} 在线`;
}

async function loadServerDirectory() {
  const aside = $("#serverDirectory");
  const hint = $("#serverDirectoryHint");
  const shell = $("#loginView");
  if (!aside || !shell) return;
  try {
    const response = await fetch("/api/servers/directory");
    const data = await response.json().catch(() => ({}));
    serversList = Array.isArray(data.servers) ? data.servers : [];
    if (!serversList.length) {
      // 无可用服务端：隐藏列表，登录页恢复两栏布局。
      aside.classList.add("hidden");
      shell.classList.remove("has-directory");
      return;
    }
    const entries = buildServerEntries();
    $("#serverDirectoryTotal").textContent = directoryTotalText(entries);
    serversPage = 1;
    renderServersPage();
    aside.classList.remove("hidden");
    shell.classList.add("has-directory");
    hint.classList.add("hidden");
  } catch {
    aside.classList.remove("hidden");
    shell.classList.add("has-directory");
    $("#serverDirectoryGrid").innerHTML = "";
    $("#serverDirectoryTotal").textContent = "共 0 台主机";
    $("#serverDirectoryPager").classList.add("hidden");
    hint.textContent = "服务端列表暂时无法获取，可手动输入服务器地址";
    hint.classList.remove("hidden");
  }
}

$("#serverDirectoryGrid")?.addEventListener("click", (event) => {
  // 0.10.1.0：「登录集群」——填入集群主节点地址并聚焦登录表单（替代原「去集群注册」）。
  const loginButton = event.target.closest("[data-cluster-login]");
  if (loginButton) {
    event.stopPropagation();
    $("#serverAddress").value = loginButton.dataset.clusterLogin;
    $("#username").focus();
    probeAuthConfig();
    return;
  }
  const target = event.target.closest("[data-server-address]");
  if (!target) return;
  const address = target.dataset.serverAddress;
  if (!address) return;
  // 自动填入服务器地址，聚焦用户 ID 输入框继续登录。
  $("#serverAddress").value = address;
  $("#username").focus();
  probeAuthConfig();
});

// 键盘可达性：目录卡片 / 登录集群按钮支持 Enter / 空格触发。
$("#serverDirectoryGrid")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target.closest("[role='button'], [data-cluster-login]");
  if (!target) return;
  event.preventDefault();
  target.click();
});

$("#serversPrevBtn")?.addEventListener("click", () => {
  serversPage -= 1;
  renderServersPage();
});
$("#serversNextBtn")?.addEventListener("click", () => {
  serversPage += 1;
  renderServersPage();
});

// ---------- 0.10.0：注册 / 忘记密码 / 套餐码 ----------
// 登录页三视图切换（登录 / 注册 / 忘记密码），注册与忘记密码入口按服务端开关显示。
const captchaState = { register: null, forgot: null };

function showLoginForm(name) {
  $("#connectForm")?.classList.toggle("hidden", name !== "connect");
  $("#registerForm")?.classList.toggle("hidden", name !== "register");
  $("#forgotForm")?.classList.toggle("hidden", name !== "forgot");
}

function syncLoginLinks() {
  const row = $("#loginLinksRow");
  if (!row) return;
  // 默认隐藏入口；探测到服务端（或集群主节点）开启注册/忘记密码后才展示。
  const config = window.__authConfig;
  const hasRegister = Boolean(config?.registerEnabled);
  const hasForgot = Boolean(config?.forgotEnabled);
  row.classList.toggle("hidden", !hasRegister && !hasForgot);
  $("#gotoRegisterBtn").hidden = !hasRegister;
  $("#gotoForgotBtn").hidden = !hasForgot;
}

// 探测服务端注册能力：填写/切换服务器地址后异步查询（静默失败，仅隐藏入口）。
async function probeAuthConfig(serverAddress) {
  const address = String(serverAddress ?? $("#serverAddress")?.value ?? "").trim();
  if (!address) {
    window.__authConfig = null;
    syncLoginLinks();
    return;
  }
  try {
    const config = await api("/api/auth-config", {
      method: "POST",
      body: JSON.stringify({ serverAddress: address }),
    });
    window.__authConfig = config;
    if (config.clusterName) {
      $("#registerServerHint").textContent = `集群「${config.clusterName}」注册由主节点提供，注册后可登录集群任意节点`;
    } else {
      $("#registerServerHint").textContent = "注册后将获得用户 ID，使用套餐码即可开通端口";
    }
  } catch {
    window.__authConfig = null;
  }
  syncLoginLinks();
}

// 注册/忘记密码的目标服务端地址：优先使用对应表单内的地址，未填则回落登录页地址。
function relayServerAddress(kind) {
  const specific = $(`#${kind}ServerAddress`)?.value?.trim();
  return specific || $("#serverAddress")?.value?.trim() || "";
}

// 统一注册中继调用：浏览器 → 客户端后端 → 注册提供方（集群场景为主节点）。
function authRelay(action, payload, kind) {
  return api("/api/auth/relay", {
    method: "POST",
    body: JSON.stringify({ serverAddress: relayServerAddress(kind), action, payload }),
  });
}

// ---------- 0.10.0.1：滑动验证码弹窗（发送邮箱验证码前的人机验证） ----------
let sliderChallenge = null;
let sliderKind = "register";
let sliderResolve = null;

function openSliderCaptcha(kind) {
  sliderKind = kind;
  $("#sliderCaptchaDialog").showModal();
  void loadSliderChallenge();
  return new Promise((resolve) => {
    sliderResolve = resolve;
  });
}

async function loadSliderChallenge() {
  const bg = $("#sliderBgWrap");
  const piece = $("#sliderPiece");
  sliderChallenge = null;
  $("#sliderError").textContent = "";
  resetSliderVisual();
  bg.textContent = "加载中...";
  piece.classList.add("hidden");
  try {
    sliderChallenge = await authRelay("sliderCaptcha", undefined, sliderKind);
    bg.innerHTML = sliderChallenge.background || "";
    piece.innerHTML = sliderChallenge.piece || "";
    piece.style.top = `${sliderChallenge.pieceY || 0}px`;
    piece.style.left = "0px";
    piece.classList.remove("hidden");
    $("#sliderTrackHint").textContent = "按住滑块拖动";
  } catch (error) {
    bg.textContent = "加载失败";
    $("#sliderError").textContent = error.message;
  }
}

function resetSliderVisual() {
  $("#sliderHandle").style.left = "0px";
  $("#sliderProgress").style.width = "0px";
}

function setupSliderDrag() {
  const handle = $("#sliderHandle");
  const piece = $("#sliderPiece");
  const progress = $("#sliderProgress");
  let dragging = false;
  let originX = 0;
  let baseX = 0;
  let currentX = 0;

  const maxTravel = () =>
    sliderChallenge
      ? Math.max(0, Number(sliderChallenge.width) - Number(sliderChallenge.pieceSize))
      : 0;

  const apply = (x) => {
    currentX = Math.max(0, Math.min(Math.round(x), maxTravel()));
    piece.style.left = `${currentX}px`;
    handle.style.left = `${currentX}px`;
    progress.style.width = `${currentX}px`;
  };

  handle.addEventListener("pointerdown", (event) => {
    if (!sliderChallenge) return;
    dragging = true;
    originX = event.clientX;
    baseX = currentX;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // 某些浏览器对按钮元素捕获失败时仍可拖动。
    }
    $("#sliderTrackHint").textContent = "";
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    apply(baseX + (event.clientX - originX));
  });
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    if (sliderChallenge && currentX > 0) {
      const resolve = sliderResolve;
      sliderResolve = null;
      $("#sliderCaptchaDialog").close();
      resolve?.({ sliderToken: sliderChallenge.token, sliderX: currentX });
    } else {
      apply(0);
      $("#sliderTrackHint").textContent = "按住滑块拖动";
    }
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}
setupSliderDrag();

$("#sliderRefreshBtn")?.addEventListener("click", () => void loadSliderChallenge());
$("#sliderBgWrap")?.addEventListener("click", () => void loadSliderChallenge());
$("#sliderCancelBtn")?.addEventListener("click", () => $("#sliderCaptchaDialog").close());
$("#sliderCaptchaDialog")?.addEventListener("close", () => {
  // Esc / 取消关闭时以 null 结算，调用方据此中止发送。
  if (sliderResolve) {
    const resolve = sliderResolve;
    sliderResolve = null;
    resolve(null);
  }
});

// ---------- 0.10.0.1：图形验证码弹窗（注册 / 重置密码提交前的二次验证） ----------
let imageCaptchaResolve = null;
let imageCaptchaKind = "register";

function openImageCaptcha(kind) {
  imageCaptchaKind = kind;
  captchaState[kind] = "";
  $("#dialogCaptchaError").textContent = "";
  $("#dialogCaptchaAnswer").value = "";
  $("#imageCaptchaDialog").showModal();
  void loadDialogCaptcha();
  return new Promise((resolve) => {
    imageCaptchaResolve = resolve;
  });
}

async function loadDialogCaptcha() {
  const box = $("#dialogCaptchaBox");
  box.textContent = "加载中...";
  captchaState[imageCaptchaKind] = "";
  try {
    const data = await authRelay("captcha", undefined, imageCaptchaKind);
    captchaState[imageCaptchaKind] = data.token || "";
    box.innerHTML = data.svg || "";
  } catch (error) {
    box.textContent = "加载失败";
    $("#dialogCaptchaError").textContent = error.message;
  }
}

function confirmImageCaptcha() {
  const answer = $("#dialogCaptchaAnswer").value.trim();
  if (!answer) {
    $("#dialogCaptchaError").textContent = "请输入图形验证码结果";
    return;
  }
  if (!captchaState[imageCaptchaKind]) {
    $("#dialogCaptchaError").textContent = "验证码未加载，请点击图片刷新";
    return;
  }
  const resolve = imageCaptchaResolve;
  imageCaptchaResolve = null;
  const payload = { captchaToken: captchaState[imageCaptchaKind], captchaAnswer: answer };
  captchaState[imageCaptchaKind] = "";
  $("#imageCaptchaDialog").close();
  resolve?.(payload);
}

$("#dialogCaptchaConfirmBtn")?.addEventListener("click", confirmImageCaptcha);
$("#dialogCaptchaAnswer")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    confirmImageCaptcha();
  }
});
$("#dialogCaptchaRefreshBtn")?.addEventListener("click", () => void loadDialogCaptcha());
$("#dialogCaptchaBox")?.addEventListener("click", () => void loadDialogCaptcha());
$("#dialogCaptchaCancelBtn")?.addEventListener("click", () => $("#imageCaptchaDialog").close());
$("#imageCaptchaDialog")?.addEventListener("close", () => {
  if (imageCaptchaResolve) {
    const resolve = imageCaptchaResolve;
    imageCaptchaResolve = null;
    resolve(null);
  }
});

// 邮箱验证码发送按钮：60 秒倒计时防止连点。
function startCodeCountdown(button) {
  if (!button) return;
  let seconds = 60;
  const original = button.textContent;
  button.disabled = true;
  const timer = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(timer);
      button.textContent = original;
      button.disabled = false;
    } else {
      button.textContent = `${seconds} 秒后重发`;
    }
  }, 1_000);
}

$("#registerSendCodeBtn")?.addEventListener("click", async () => {
  const button = $("#registerSendCodeBtn");
  const email = $("#registerEmail")?.value?.trim();
  if (!email) return toast("请先填写绑定邮箱", true);
  // 0.10.0.1：发送验证码前先通过滑动验证（拖动拼图）。
  const slider = await openSliderCaptcha("register");
  if (!slider) return;
  try {
    await authRelay("registerSendCode", {
      email,
      sliderToken: slider.sliderToken,
      sliderX: slider.sliderX,
    }, "register");
    toast("验证码已发送，请查收邮箱（注意垃圾箱）");
    startCodeCountdown(button);
  } catch (error) {
    toast(error.message, true);
  }
});

$("#registerForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setProp("#registerError", "textContent", "");
  const password = $("#registerPassword")?.value || "";
  const confirm = $("#registerPasswordConfirm")?.value || "";
  if (password !== confirm) {
    setProp("#registerError", "textContent", "两次输入的密码不一致");
    return;
  }
  const button = $("#registerForm button[type='submit']");
  if (button) button.disabled = true;
  try {
    // 0.10.0.1：提交注册前弹出图形验证码（二次验证）。
    const captcha = await openImageCaptcha("register");
    if (!captcha) return;
    const data = await authRelay("register", {
      email: $("#registerEmail")?.value?.trim() || "",
      code: $("#registerCode")?.value?.trim() || "",
      username: $("#registerUsername")?.value?.trim() || "",
      password,
      captchaToken: captcha.captchaToken,
      captchaAnswer: captcha.captchaAnswer,
    }, "register");
    toast(data.message || "注册成功，请使用用户 ID 或邮箱登录");
    // 注册成功自动切回登录视图，并把用户 ID / 邮箱带入登录框。
    $("#serverAddress").value = $("#registerServerAddress")?.value || $("#serverAddress")?.value || "";
    const identifier = $("#username");
    if (identifier) identifier.value = data.uid || $("#registerEmail")?.value || "";
    showLoginForm("connect");
    identifier?.focus();
  } catch (error) {
    setProp("#registerError", "textContent", error.message);
  } finally {
    if (button) button.disabled = false;
  }
});

$("#forgotSendCodeBtn")?.addEventListener("click", async () => {
  const button = $("#forgotSendCodeBtn");
  const email = $("#forgotEmail")?.value?.trim();
  if (!email) return toast("请先填写注册邮箱", true);
  // 0.10.0.1：发送验证码前先通过滑动验证（拖动拼图）。
  const slider = await openSliderCaptcha("forgot");
  if (!slider) return;
  try {
    await authRelay("forgotSendCode", {
      email,
      sliderToken: slider.sliderToken,
      sliderX: slider.sliderX,
    }, "forgot");
    toast("验证码已发送，请查收邮箱（注意垃圾箱）");
    startCodeCountdown(button);
  } catch (error) {
    toast(error.message, true);
  }
});

$("#forgotForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setProp("#forgotError", "textContent", "");
  const password = $("#forgotNewPassword")?.value || "";
  const confirm = $("#forgotNewPasswordConfirm")?.value || "";
  if (password !== confirm) {
    setProp("#forgotError", "textContent", "两次输入的新密码不一致");
    return;
  }
  const button = $("#forgotForm button[type='submit']");
  if (button) button.disabled = true;
  try {
    // 0.10.0.1：提交重置前弹出图形验证码（二次验证）。
    const captcha = await openImageCaptcha("forgot");
    if (!captcha) return;
    const data = await authRelay("forgotReset", {
      email: $("#forgotEmail")?.value?.trim() || "",
      code: $("#forgotCode")?.value?.trim() || "",
      newPassword: password,
      captchaToken: captcha.captchaToken,
      captchaAnswer: captcha.captchaAnswer,
    }, "forgot");
    toast(data.message || "密码已重置，请使用新密码登录");
    const identifier = $("#username");
    if (identifier) identifier.value = data.uid || $("#forgotEmail")?.value || "";
    showLoginForm("connect");
    identifier?.focus();
  } catch (error) {
    setProp("#forgotError", "textContent", error.message);
  } finally {
    if (button) button.disabled = false;
  }
});

$("#gotoRegisterBtn")?.addEventListener("click", () => {
  $("#registerServerAddress").value = $("#serverAddress")?.value || "";
  openRegisterView($("#serverAddress")?.value || "");
});
$("#gotoForgotBtn")?.addEventListener("click", () => {
  $("#forgotServerAddress").value = $("#serverAddress")?.value || "";
  showLoginForm("forgot");
});
$("#registerBackBtn")?.addEventListener("click", () => showLoginForm("connect"));
$("#forgotBackBtn")?.addEventListener("click", () => showLoginForm("connect"));

// 「去集群注册」统一入口：填主节点地址 → 探测开关 → 打开注册视图。
function openRegisterView(serverAddress) {
  const address = String(serverAddress || "").trim();
  if (address) $("#serverAddress").value = address;
  $("#registerServerAddress").value = address || $("#serverAddress")?.value || "";
  showLoginForm("register");
  if (address) void probeAuthConfig(address);
}

// 服务器地址变更后重新探测注册/忘记密码开关（失焦或回车触发）。
$("#serverAddress")?.addEventListener("change", () => void probeAuthConfig());
$("#registerServerAddress")?.addEventListener("change", () =>
  void probeAuthConfig($("#registerServerAddress")?.value),
);

// 使用套餐码：0.10.1.1 入口移到仪表盘「续费」旁，点击弹出兑换弹窗。
$("#openRedeemButton")?.addEventListener("click", () => {
  setProp("#redeemError", "textContent", "");
  setProp("#redeemMsg", "textContent", "");
  $("#redeemDialog").showModal();
});

// 兑换成功后刷新状态（frpc 由后端按需自动重启以应用新端口段）。
$("#redeemForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setProp("#redeemError", "textContent", "");
  setProp("#redeemMsg", "textContent", "");
  const code = $("#redeemCode")?.value?.trim() || "";
  const button = $("#redeemSubmit");
  if (button) button.disabled = true;
  try {
    const data = await api("/api/account/redeem", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    state = await api("/api/state");
    render();
    const ranges = (data.addedRanges || []).join("、");
    setProp(
      "#redeemMsg",
      "textContent",
      `${data.message}${data.plan ? `（套餐：${data.plan.name}）` : ""}${ranges ? `，新增端口：${ranges}` : ""}`,
    );
    setProp("#redeemCode", "value", "");
    toast("套餐码兑换成功");
    setTimeout(() => $("#redeemDialog")?.close(), 1_200);
  } catch (error) {
    setProp("#redeemError", "textContent", error.message);
  } finally {
    if (button) button.disabled = false;
  }
});

$(".nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  // 未登录时仅「设置」「运行日志」「信息」可访问（信息中心可查看本地 frpc 报错提醒）。
  const allowed = ["settings", "logs", "messages"];
  if (!state?.connected && !allowed.includes(button.dataset.view)) return;
  switchView(button.dataset.view);
});

// 0.10.2.4：手机端侧边栏抽屉——点菜单项/遮罩自动收起，左上角按钮手动展开收起
$(".nav").addEventListener("click", () => {
  if (window.matchMedia("(max-width: 760px)").matches) {
    $("#appView")?.classList.add("sidebar-collapsed");
  }
});

$("#sidebarBackdrop")?.addEventListener("click", () =>
  $("#appView")?.classList.add("sidebar-collapsed"),
);

$("#sidebarToggle")?.addEventListener("click", () => {
  const collapsed = $("#appView")?.classList.toggle("sidebar-collapsed") ?? false;
  $("#sidebarToggle")?.setAttribute("aria-expanded", String(!collapsed));
  $("#sidebarToggle")?.setAttribute("aria-label", collapsed ? "展开菜单" : "收起菜单");
});

$("#openConnectBtn").addEventListener("click", openLoginView);
$("#connectNowBtn").addEventListener("click", openLoginView);
$("#backToAppBtn").addEventListener("click", backToConsole);
$("#gotoSettingsBtn").addEventListener("click", () => switchView("settings"));

// 0.10.1.1：新建映射入口 = 「端口映射」各节点块的「添加映射」（节点只读锁定）。
$("#proxyForm").addEventListener("submit", saveProxy);
$("#proxyType").addEventListener("change", syncProxyTypeFields);

$("#remotePortPick").addEventListener("change", (event) => {
  if (!event.target.value) return;
  $("#remotePort").value = event.target.value;
  event.target.value = "";
  $("#remotePort").focus();
});

$("#portSuggestions").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-port]");
  if (!chip) return;
  $("#remotePort").value = chip.dataset.port;
  $("#remotePort").focus();
});

$("#mappingBlocks")?.addEventListener("click", async (event) => {
  const addButton = event.target.closest("[data-node-add]");
  if (addButton) {
    openProxyDialog(null, addButton.dataset.nodeAdd);
    return;
  }
  // 0.10.1.2 规格6：节点块单独管理 frpc 进程（启/停/重启）。
  const frpcButton = event.target.closest("[data-node-frpc]");
  if (frpcButton) {
    if (frpcButton.disabled) return;
    const action = frpcButton.dataset.nodeFrpc;
    const key = frpcButton.dataset.nodeKey || "master";
    frpcButton.disabled = true;
    try {
      const data = await api("/api/frpc/node", {
        method: "POST",
        body: JSON.stringify({ key, action }),
      });
      state = data.state || state;
      toast(
        action === "stop"
          ? `已停止 ${key === "master" ? "主节点" : key} 的 frpc 进程`
          : `已下发${action === "restart" ? "重启" : "启动"}指令：${key === "master" ? "主节点" : key} 的 frpc 进程`,
      );
    } catch (error) {
      toast(error.message, true);
    } finally {
      render();
    }
    return;
  }
  await handleProxyRowEvent(event);
});

$("#mappingBlocks")?.addEventListener("change", (event) => {
  const input = event.target.closest("[data-proxy-toggle]");
  if (!input) return;
  const proxy = state.proxies.find((item) => item.id === input.dataset.proxyToggle);
  if (proxy) updateProxy(proxy, { enabled: input.checked });
});

// 仪表盘映射列表：点击行跳转「端口映射」定位（规格9）；复制按钮单独处理。
$("#dashboardProxyRows")?.addEventListener("click", async (event) => {
  if (event.target.closest("[data-copy-domain], [data-copy-port]")) {
    await copyAccessChip(event);
    return;
  }
  const row = event.target.closest("[data-jump-proxy]");
  if (row) jumpToProxy(row.dataset.jumpProxy);
});

// 通用复制：域名 / 节点IP+端口（规格8：访问方式点击可复制）。
async function copyAccessChip(event) {
  const copyText = async (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    toast(`已复制 ${text}`);
  };
  const domainTarget = event.target.closest("[data-copy-domain]");
  if (domainTarget) {
    const address = `${domainTarget.dataset.proxyScheme}://${domainTarget.dataset.copyDomain}`;
    try {
      await copyText(address);
    } catch (error) {
      toast(`复制失败：${error.message}`, true);
    }
    return;
  }
  const copyTarget = event.target.closest("[data-copy-port]");
  if (copyTarget) {
    const port = copyTarget.dataset.copyPort;
    // 0.10.1.1：复制内容 = 该映射归属节点 IP + 端口。
    const host =
      copyTarget.dataset.copyHost ||
      (state.nodes || []).find((node) => node.name === (proxyNodeOfChip(copyTarget) || "master"))
        ?.host ||
      state.serverAddress ||
      "";
    if (!host) {
      toast("未连接服务器，无法复制访问地址", true);
      return;
    }
    const address = `${host}:${port}`;
    try {
      await copyText(address);
    } catch (error) {
      toast(`复制失败：${error.message}`, true);
    }
  }
}

function proxyNodeOfChip(chip) {
  return chip.closest("tr")?.dataset.proxyRow
    ? (state.proxies.find((item) => item.id === chip.closest("tr").dataset.proxyRow)?.node ??
        "master")
    : "master";
}

// 端口映射节点块内的行操作：编辑 / 删除 / 启停 / 复制。
async function handleProxyRowEvent(event) {
  if (event.target.closest("[data-copy-domain], [data-copy-port]")) {
    await copyAccessChip(event);
    return;
  }
  const button = event.target.closest("[data-proxy-action]");
  if (!button) return;
  const proxy = state.proxies.find((item) => item.id === button.dataset.id);
  if (!proxy) return;
  if (button.dataset.proxyAction === "edit") {
    openProxyDialog(proxy);
    return;
  }
  if (button.dataset.proxyAction === "delete") {
    if (!confirm(`删除映射 ${proxy.name}？`)) return;
    try {
      await api(`/api/proxies/${proxy.id}`, { method: "DELETE" });
      toast("映射已删除");
      await loadState();
    } catch (error) {
      toast(error.message, true);
    }
  }
}

$$("[data-close-dialog]").forEach((button) =>
  button.addEventListener("click", () => button.closest("dialog")?.close()),
);

// 0.9.0：首次登录强制激活（改密，可选改用户名）。
$("#activateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#activateError").textContent = "";
  const currentPassword = $("#activateCurrentPassword").value;
  const newPassword = $("#activateNewPassword").value;
  if (newPassword !== $("#activateConfirmPassword").value) {
    $("#activateError").textContent = "两次输入的新密码不一致";
    return;
  }
  try {
    state = await api("/api/account/activate", {
      method: "POST",
      body: JSON.stringify({
        currentPassword,
        newPassword,
        newUsername: $("#activateNewUsername").value.trim(),
      }),
    });
    $("#activateForm").reset();
    toast("账户已激活");
    render();
    if (state?.connected && !state.user?.mustChangePassword) switchView("tunnels");
  } catch (error) {
    $("#activateError").textContent = error.message;
  }
});

// 设置页：修改密码 / 修改用户名 / 修改用户 ID 共用一个对话框。
function openAccountDialog(mode) {
  const titles = { password: "修改密码", username: "修改用户名", uid: "修改用户 ID" };
  $("#accountDialogTitle").textContent = titles[mode] || "修改密码";
  $("#accountPasswordForm").classList.toggle("hidden", mode !== "password");
  $("#accountUsernameForm").classList.toggle("hidden", mode !== "username");
  $("#accountUidForm").classList.toggle("hidden", mode !== "uid");
  $("#accountPasswordForm").reset();
  $("#accountUsernameForm").reset();
  $("#accountUidForm").reset();
  $("#acctPwdError").textContent = "";
  $("#acctUserError").textContent = "";
  $("#acctUidError").textContent = "";
  $("#accountDialog").showModal();
}

$("#changePasswordButton").addEventListener("click", () => openAccountDialog("password"));
$("#changeUsernameButton").addEventListener("click", () => openAccountDialog("username"));
$("#changeUidButton")?.addEventListener("click", () => openAccountDialog("uid"));

$("#accountPasswordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#acctPwdError").textContent = "";
  const currentPassword = $("#acctPwdCurrent").value;
  const newPassword = $("#acctPwdNew").value;
  if (newPassword !== $("#acctPwdConfirm").value) {
    $("#acctPwdError").textContent = "两次输入的新密码不一致";
    return;
  }
  try {
    state = await api("/api/account/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    $("#accountDialog").close();
    toast("密码已修改");
    render();
  } catch (error) {
    $("#acctPwdError").textContent = error.message;
  }
});

$("#accountUsernameForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#acctUserError").textContent = "";
  try {
    state = await api("/api/account/username", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: $("#acctUserCurrent").value,
        newUsername: $("#acctUserNew").value.trim(),
      }),
    });
    $("#accountDialog").close();
    toast("用户名已修改");
    render();
  } catch (error) {
    $("#acctUserError").textContent = error.message;
  }
});

$("#accountUidForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#acctUidError").textContent = "";
  const newUid = $("#acctUidNew").value.trim();
  if (!/^\d{6}$/.test(newUid)) {
    $("#acctUidError").textContent = "用户 ID 必须是 6 位数字";
    return;
  }
  try {
    state = await api("/api/account/uid", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: $("#acctUidCurrent").value,
        newUid,
      }),
    });
    $("#accountDialog").close();
    toast("用户 ID 已修改，隧道正在重建");
    render();
  } catch (error) {
    $("#acctUidError").textContent = error.message;
  }
});

$("#startButton").addEventListener("click", async () => {
  state = await api("/api/frpc/start", { method: "POST" });
  render();
});

$("#stopButton").addEventListener("click", async () => {
  state = await api("/api/frpc/stop", { method: "POST" });
  render();
});

// 0.10.1.2 规格5：统一 frpc 管理——重启全部 frpc 进程。
$("#restartButton")?.addEventListener("click", async () => {
  const button = $("#restartButton");
  if (button) button.disabled = true;
  try {
    state = await api("/api/frpc/restart", { method: "POST" });
    toast("已下发重启指令，全部 frpc 进程将自动重启");
  } catch (error) {
    toast(error.message, true);
  } finally {
    render();
  }
});

$("#refreshButton").addEventListener("click", loadState);

// 0.10.1.1：运行日志页签切换（每个 frpc 进程一页）。
$("#frpcLogTabs")?.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-log-tab]");
  if (!tab) return;
  activeLogKey = tab.dataset.logTab;
  renderLogsView();
});

$("#pullFrpcButton").addEventListener("click", async () => {
  const msg = $("#frpcMessage");
  msg.textContent = "正在从服务端拉取 frpc...";
  msg.classList.remove("error-text");
  try {
    const data = await api("/api/frpc/pull", { method: "POST" });
    msg.textContent = `已拉取 frpc v${data.version || "?"}（${(data.size / 1024 / 1024).toFixed(1)} MB），可在端口映射页启动`;
    await loadState();
  } catch (error) {
    msg.textContent = error.message;
    msg.classList.add("error-text");
  }
});

$("#uploadFrpcButton").addEventListener("click", () => $("#frpcFileInput").click());
$("#frpcFileInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const msg = $("#frpcMessage");
  msg.textContent = `正在安装 ${file.name}...`;
  msg.classList.remove("error-text");
  try {
    await api("/api/frpc/install", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    msg.textContent = `已安装 frpc（${(file.size / 1024 / 1024).toFixed(1)} MB），可在端口映射页启动`;
    await loadState();
  } catch (error) {
    msg.textContent = error.message;
    msg.classList.add("error-text");
  } finally {
    event.target.value = "";
  }
});

icons();
loadState();
setInterval(loadState, 3_000);

// 0.10.2.8：公告弹窗「全部标记已读」。
$("#noticeDialogReadAll")?.addEventListener("click", async () => {
  await markMessagesRead("notices");
  $("#noticeDialog")?.close();
  toast("公告已全部标记为已读");
});
setInterval(() => {
  if (state?.connected && state?.user) {
    $("#timeRemaining").textContent = remaining(state.user.expiresAt);
  }
}, 30_000);
