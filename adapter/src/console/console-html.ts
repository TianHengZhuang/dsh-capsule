// 作用：Governance Console 内嵌单文件 HTML（规格第 24 节 Phase 4）——零外部依赖、零图片、
// 原生 JS 只读展示 Plugins / Tools / Capabilities / Leases / Activity / Audit 六个区块；
// 所有动态内容经 textContent 渲染防注入，数据全部来自 /api/snapshot 与 /api/audit（只读 GET）。
export const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DSH Capability Guard Console</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px;background:#f6f7f9;color:#1f2328}
h1{font-size:20px;margin:0 0 16px}
h2{font-size:15px;margin:24px 0 8px}
.cards{display:flex;flex-wrap:wrap;gap:8px}
.card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:8px 14px;min-width:110px}
.card b{display:block;font-size:18px}
.card span{font-size:12px;color:#57606a}
table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #d0d7de;border-radius:8px;font-size:13px}
th,td{border-bottom:1px solid #eaeef2;padding:6px 8px;text-align:left;white-space:nowrap;max-width:340px;overflow:hidden;text-overflow:ellipsis}
th{background:#f6f7f9;position:sticky;top:0}
tr:last-child td{border-bottom:none}
.status-ACTIVE{color:#1a7f37}.status-REVOKED,.status-EXPIRED{color:#cf222e}.decision-LEASE_ISSUED{color:#1a7f37}.decision-LEASE_REUSED{color:#0969da}.decision-PASSTHROUGH_DENY,.decision-APPROVAL_REJECTED,.decision-TOOL_ERROR{color:#cf222e}
form{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
input,select,button{font-size:13px;padding:4px 8px;border:1px solid #d0d7de;border-radius:6px;background:#fff}
button{cursor:pointer;background:#0969da;color:#fff;border-color:#0969da}
#refreshed{font-size:12px;color:#57606a;margin-left:8px}
</style>
</head>
<body>
<h1>DSH Capability Guard Console</h1>
<div class="cards" id="summary"></div>
<h2>Plugins</h2>
<table><thead><tr><th>kind</th><th>id</th><th>credentialRef</th><th>allowedActions</th></tr></thead><tbody id="plugins"></tbody></table>
<h2>Tools</h2>
<table><thead><tr><th>toolName</th><th>invocations</th><th>ask</th><th>issued</th><th>reused</th><th>rejected</th><th>allow</th><th>deny</th><th>success</th><th>error</th><th>last</th></tr></thead><tbody id="tools"></tbody></table>
<h2>Capabilities</h2>
<table><thead><tr><th>toolName</th><th>provider</th><th>action</th><th>ttlSeconds</th></tr></thead><tbody id="capabilities"></tbody></table>
<h2>Leases</h2>
<table><thead><tr><th>id</th><th>kind</th><th>sessionId</th><th>toolName</th><th>scope</th><th>status</th><th>remaining</th></tr></thead><tbody id="leases"></tbody></table>
<h2>Activity<span id="refreshed"></span></h2>
<table><thead><tr><th>time</th><th>decision</th><th>toolName</th><th>sessionId</th><th>callId</th><th>leaseId</th></tr></thead><tbody id="activity"></tbody></table>
<h2>Audit 查询</h2>
<form id="audit-form">
<input name="sessionId" placeholder="sessionId">
<input name="toolName" placeholder="toolName">
<select name="decision">
<option value="">decision: 全部</option>
<option>PASSTHROUGH_ALLOW</option><option>PASSTHROUGH_DENY</option><option>ASK</option>
<option>LEASE_REUSED</option><option>LEASE_ISSUED</option><option>APPROVAL_REJECTED</option>
<option>TOOL_SUCCESS</option><option>TOOL_ERROR</option>
</select>
<input name="limit" placeholder="limit" value="50">
<button type="submit">查询</button>
<button type="button" id="audit-reset">重置</button>
</form>
<table><thead><tr><th>time</th><th>decision</th><th>toolName</th><th>sessionId</th><th>callId</th><th>scopeDisplay</th></tr></thead><tbody id="audit"></tbody></table>
<script>
// 作用：把数据行渲染进表格——全部经 textContent 写入，杜绝任何注入
function renderRows(id, rows, cells) {
  var body = document.getElementById(id);
  body.textContent = "";
  rows.forEach(function (row) {
    var tr = document.createElement("tr");
    cells.forEach(function (cell) {
      var td = document.createElement("td");
      var text = cell(row);
      if (cell.cls) { td.className = cell.cls(row); }
      td.textContent = text === undefined || text === null ? "" : String(text);
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
}
// 作用：时间戳转本地时间串
function fmtTime(ts) { return ts ? new Date(ts).toLocaleTimeString() : ""; }
// 作用：长标识截短展示
function short(value, n) { value = String(value || ""); return value.length > n ? value.slice(0, n) + "…" : value; }
// 作用：渲染全量快照六个区块 + 汇总卡片
function render(snap) {
  var cards = [
    ["leases", snap.summary.leasesTotal], ["active", snap.summary.leasesActive], ["revoked", snap.summary.leasesRevoked],
    ["expired", snap.summary.leasesExpired], ["capabilities", snap.summary.managedCapabilities],
    ["providers", snap.summary.providers], ["audit events", snap.summary.auditedEvents],
  ];
  document.getElementById("summary").innerHTML = "";
  cards.forEach(function (item) {
    var div = document.createElement("div");
    div.className = "card";
    var b = document.createElement("b");
    b.textContent = item[1];
    var span = document.createElement("span");
    span.textContent = item[0];
    div.appendChild(b);
    div.appendChild(span);
    document.getElementById("summary").appendChild(div);
  });
  document.getElementById("refreshed").textContent = "（更新于 " + new Date(snap.generatedAt).toLocaleTimeString() + "）";
  renderRows("plugins", snap.plugins, [
    function (p) { return p.kind; },
    function (p) { return p.id; },
    function (p) { return p.credentialRef || ""; },
    function (p) { return (p.allowedActions || []).join(", "); },
  ]);
  renderRows("tools", snap.tools, [
    function (t) { return t.toolName; },
    function (t) { return t.invocations; },
    function (t) { return t.ask; },
    function (t) { return t.leaseIssued; },
    function (t) { return t.leaseReused; },
    function (t) { return t.approvalRejected; },
    function (t) { return t.passthroughAllow; },
    function (t) { return t.passthroughDeny; },
    function (t) { return t.toolSuccess; },
    function (t) { return t.toolError; },
    function (t) { return fmtTime(t.lastActivityAt); },
  ]);
  renderRows("capabilities", snap.capabilities, [
    function (c) { return c.toolName; },
    function (c) { return c.provider; },
    function (c) { return c.action; },
    function (c) { return c.ttlSeconds + "s"; },
  ]);
  renderRows("leases", snap.leases, [
    function (l) { return short(l.id, 8); },
    function (l) { return l.kind; },
    function (l) { return short(l.sessionId, 8); },
    function (l) { return l.toolName; },
    function (l) { return l.scopeKind + ": " + l.scopeDisplay; },
    function (l) { return l.status; },
    function (l) { return l.status === "ACTIVE" ? Math.ceil(l.remainingMs / 1000) + "s" : "-"; },
  ]);
  var leaseRows = document.querySelectorAll("#leases tr td:nth-child(6)");
  snap.leases.forEach(function (l, i) { if (leaseRows[i]) { leaseRows[i].className = "status-" + l.status; } });
  renderRows("activity", snap.activity, [
    function (e) { return fmtTime(e.timestamp); },
    function (e) { return e.decision; },
    function (e) { return e.toolName; },
    function (e) { return short(e.sessionId, 8); },
    function (e) { return short(e.callId, 8); },
    function (e) { return short(e.leaseId, 8); },
  ]);
  var activityRows = document.querySelectorAll("#activity tr td:nth-child(2)");
  snap.activity.forEach(function (e, i) { if (activityRows[i]) { activityRows[i].className = "decision-" + e.decision; } });
}
// 作用：拉取全量快照并渲染
async function refresh() {
  try {
    var res = await fetch("/api/snapshot");
    if (res.ok) { render(await res.json()); }
  } catch (err) { /* Console 只读，刷新失败静默等待下次轮询 */ }
}
// 作用：按表单条件查询审计事件
async function queryAudit(event) {
  if (event) { event.preventDefault(); }
  var form = document.getElementById("audit-form");
  var params = new URLSearchParams();
  ["sessionId", "toolName", "decision", "limit"].forEach(function (name) {
    if (form.elements[name].value) { params.set(name, form.elements[name].value); }
  });
  var res = await fetch("/api/audit?" + params.toString());
  var body = await res.json();
  if (!res.ok) { body = []; }
  renderRows("audit", body, [
    function (e) { return fmtTime(e.timestamp); },
    function (e) { return e.decision; },
    function (e) { return e.toolName; },
    function (e) { return short(e.sessionId, 8); },
    function (e) { return short(e.callId, 8); },
    function (e) { return e.scopeDisplay || ""; },
  ]);
  var auditRows = document.querySelectorAll("#audit tr td:nth-child(2)");
  body.forEach(function (e, i) { if (auditRows[i]) { auditRows[i].className = "decision-" + e.decision; } });
}
document.getElementById("audit-form").addEventListener("submit", queryAudit);
document.getElementById("audit-reset").addEventListener("click", function () {
  document.getElementById("audit-form").reset();
  queryAudit();
});
// 作用：每 5 秒自动刷新快照 + 首次立即加载
setInterval(refresh, 5000);
refresh();
queryAudit();
</script>
</body>
</html>
`;
