export const DASHBOARD_PAGE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Харнесс Jira</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f1115; color: #e6e6e6; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 20px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
  .badge.on { background: #1f6f3f; color: #c6f6d5; }
  .badge.off { background: #4a4a4a; color: #ddd; }
  .card { background: #171a21; border: 1px solid #262b36; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .phase { font-size: 13px; color: #9fd3ff; text-transform: uppercase; letter-spacing: 0.05em; }
  .bar-bg { background: #262b36; border-radius: 6px; height: 8px; margin: 8px 0; overflow: hidden; }
  .bar-fg { background: #4c8bf5; height: 100%; transition: width .3s; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #262b36; }
  th { color: #888; font-weight: 500; }
  .outcome-closed { color: #7ee787; }
  .outcome-needs_human { color: #f0b429; }
  .outcome-skipped { color: #888; }
  a { color: #9fd3ff; }
  .empty { color: #666; font-style: italic; }
  .stats { display: flex; gap: 24px; font-size: 13px; color: #aaa; flex-wrap: wrap; }
  .stats b { color: #e6e6e6; }
  .scene-wrap { display: flex; justify-content: center; background: #0b0d11; border-radius: 10px; padding: 8px; margin-bottom: 8px; border: 1px solid #262b36; }
  #scene { image-rendering: pixelated; width: 100%; max-width: 640px; height: auto; }
  .scene-caption { text-align: center; font-size: 12px; color: #777; margin: 0 0 16px; text-transform: uppercase; letter-spacing: 0.08em; }
  .log-panel { background: #0b0d11; border-radius: 6px; padding: 8px 10px; margin-top: 10px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #9fe6a0; height: 140px; overflow-y: auto; white-space: pre-wrap; }
  .log-panel div { padding: 1px 0; }
  .ticket-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #262b36; }
  .ticket-row:last-child { border-bottom: none; }
  .ticket-main { flex: 1; min-width: 0; }
  .ticket-title { font-size: 13px; }
  .ticket-meta { font-size: 12px; color: #888; margin-top: 2px; }
  .ticket-desc { font-size: 12px; color: #999; margin-top: 4px; white-space: pre-wrap; }
  .start-btn { background: #2d5fd1; color: #fff; border: none; border-radius: 6px; padding: 6px 14px; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .start-btn:disabled { background: #333; color: #777; cursor: not-allowed; }
  .repo-tag { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #262b36; color: #aaa; margin-left: 6px; }
  .repo-tag.route-unknown, .repo-tag.route-ambiguous { background: #4a2e1a; color: #f0b429; }
  .tabbar { display: flex; gap: 4px; margin-bottom: 6px; border-bottom: 1px solid #262b36; }
  .tab-btn { background: none; border: none; color: #999; padding: 10px 16px; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; }
  .tab-btn.active { color: #e6e6e6; border-bottom-color: #4c8bf5; }
  .tab-hint { font-size: 12px; color: #666; margin: 8px 0 14px; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
</style>
</head>
<body>
  <h1>Харнесс задач Jira</h1>
  <div class="sub">бот: <span id="bot-status" class="badge off">загрузка…</span></div>

  <div class="scene-wrap"><canvas id="scene" width="640" height="260"></canvas></div>
  <div class="scene-caption" id="scene-caption">слежу за очередью…</div>

  <div class="card">
    <div class="stats">
      <div>всего потрачено: <b id="total-cost">—</b></div>
      <div>сегодня: <b id="today-cost">—</b></div>
      <div>задач обработано: <b id="task-count">—</b></div>
    </div>
  </div>

  <div class="tabbar">
    <button class="tab-btn active" data-tab="task">Текущая задача</button>
    <button class="tab-btn" data-tab="queue">Очередь</button>
    <button class="tab-btn" data-tab="history">История</button>
  </div>
  <div class="tab-hint" id="tab-hint">Что сейчас делает агент и прогресс по текущей задаче</div>

  <div class="tab-panel active" id="panel-task">
    <div class="card" id="current-job-card">
      <div class="empty">сейчас ничего не выполняется</div>
    </div>
  </div>

  <div class="tab-panel" id="panel-queue">
    <div class="card">
      <div id="tickets-body"><div class="empty">загрузка…</div></div>
    </div>
  </div>

  <div class="tab-panel" id="panel-history">
    <div class="card">
      <table>
        <thead><tr><th>Тикет</th><th>Результат</th><th>Детали</th><th>Стоимость</th><th>Когда</th></tr></thead>
        <tbody id="history-body"></tbody>
      </table>
    </div>
  </div>

<script>
var TAB_HINTS = {
  task: "Что сейчас делает агент и прогресс по текущей задаче",
  queue: "Тикеты из Jira, ожидающие запуска — выбери и нажми «Запустить»",
  history: "Последние завершённые задачи и их результат",
};
document.querySelectorAll(".tab-btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.remove("active"); });
    document.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.remove("active"); });
    btn.classList.add("active");
    document.getElementById("panel-" + btn.dataset.tab).classList.add("active");
    document.getElementById("tab-hint").textContent = TAB_HINTS[btn.dataset.tab];
    try { localStorage.setItem("harness-tab", btn.dataset.tab); } catch (e) {}
  });
});
try {
  var savedTab = localStorage.getItem("harness-tab");
  if (savedTab) {
    var btnToClick = document.querySelector('.tab-btn[data-tab="' + savedTab + '"]');
    if (btnToClick) btnToClick.click();
  }
} catch (e) {}

var PHASE_RU = {
  transitioning: "перевод статуса в Jira",
  writing_acceptance_test: "пишу тест приёмки по критериям",
  baseline: "считаю baseline (сколько тестов падает и без фикса)",
  iterating: "работа над кодом",
  verifying: "проверка (тесты)",
  reviewing: "независимое ревью изменений",
  writing_testing_notes: "пишу инструкцию для тестировщика",
  updating_memory: "обновляю project memory",
  pushing: "отправка ветки в репозиторий",
  opening_mr: "открытие MR",
  commenting: "комментирование тикета",
};
var OUTCOME_RU = { closed: "закрыт", needs_human: "нужен человек", skipped: "пропущен" };
var REPO_RU = { backend: "бэкенд", frontend: "фронтенд", cross: "кросс-репо", ambiguous: "кросс-репо", unknown: "не определено" };

function fmtElapsed(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + " с";
  return Math.floor(s / 60) + " мин " + (s % 60) + " с";
}

async function tick() {
  const res = await fetch("/api/state");
  const data = await res.json();

  const botEl = document.getElementById("bot-status");
  botEl.textContent = data.botRunning ? "запущен" : "остановлен";
  botEl.className = "badge " + (data.botRunning ? "on" : "off");

  document.getElementById("total-cost").textContent = "$" + data.totalCostUsd.toFixed(4);
  document.getElementById("today-cost").textContent = "$" + data.costToday.toFixed(4);
  document.getElementById("task-count").textContent = data.history.length + " (показаны последние 20)";

  sceneMode = data.live.currentJob ? "working" : "idle";
  document.getElementById("scene-caption").textContent = data.live.currentJob
    ? "передают файлы: " + data.live.currentJob.issueKey
    : "агенты обедают — очередь пуста";

  const jobCard = document.getElementById("current-job-card");
  const job = data.live.currentJob;
  if (!job) {
    jobCard.innerHTML = '<div class="empty">сейчас ничего не выполняется</div>';
  } else {
    const pct = Math.min(100, Math.round((job.iteration / job.maxIterations) * 100));
    jobCard.innerHTML =
      '<div><b>' + job.issueKey + '</b>: ' + job.title.replace(/</g, "&lt;") + '</div>' +
      '<div class="sub">' + (REPO_RU[job.repo] || job.repo) + ' &middot; прошло ' + fmtElapsed(job.startedAt) + '</div>' +
      '<div class="phase">' + (PHASE_RU[job.phase] || job.phase) + ' (итерация ' + job.iteration + '/' + job.maxIterations + ')</div>' +
      '<div class="bar-bg"><div class="bar-fg" style="width:' + pct + '%"></div></div>' +
      '<div>потрачено: $' + job.costUsd.toFixed(4) + '</div>' +
      (job.description ? '<details style="margin-top:8px"><summary class="sub">описание тикета</summary><div class="sub" style="white-space:pre-wrap;margin-top:4px">' + job.description.slice(0, 1500).replace(/</g, "&lt;") + '</div></details>' : '') +
      '<div class="log-panel" id="log-panel"></div>';
    const panel = document.getElementById("log-panel");
    panel.innerHTML = job.logs.map(function (l) { return '<div>' + l.replace(/</g, "&lt;") + '</div>'; }).join("");
    panel.scrollTop = panel.scrollHeight;
  }

  const body = document.getElementById("history-body");
  body.innerHTML = data.history.map(function (r) {
    const detail = r.outcome === "closed"
      ? '<a href="' + r.detail + '" target="_blank">MR</a>'
      : r.detail.replace(/</g, "&lt;");
    return '<tr><td>' + r.issueKey + '</td>' +
      '<td class="outcome-' + r.outcome + '">' + (OUTCOME_RU[r.outcome] || r.outcome) + '</td>' +
      '<td>' + detail + '</td>' +
      '<td>$' + r.costUsd.toFixed(4) + '</td>' +
      '<td>' + new Date(r.timestamp).toLocaleString("ru-RU") + '</td></tr>';
  }).join("") || '<tr><td colspan="5" class="empty">задач пока нет</td></tr>';
}

async function startTicket(key, btn) {
  btn.disabled = true;
  btn.textContent = "запускается…";
  try {
    const res = await fetch("/api/tickets/" + key + "/start", { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(function () { return {}; });
      alert("Не удалось запустить " + key + ": " + (body.error || res.status));
      btn.disabled = false;
      btn.textContent = "Запустить";
    } else {
      btn.textContent = "запущено";
      setTimeout(loadTickets, 1500);
    }
  } catch (e) {
    alert("Ошибка: " + e.message);
    btn.disabled = false;
    btn.textContent = "Запустить";
  }
}

async function loadTickets() {
  const container = document.getElementById("tickets-body");
  try {
    const res = await fetch("/api/tickets");
    const tickets = await res.json();
    if (!Array.isArray(tickets) || tickets.length === 0) {
      container.innerHTML = '<div class="empty">очередь пуста</div>';
      return;
    }
    container.innerHTML = tickets.map(function (t) {
      const routable = t.repo === "backend" || t.repo === "frontend" || t.repo === "ambiguous";
      const tagClass = routable ? "" : " route-" + t.repo;
      return '<div class="ticket-row">' +
        '<div class="ticket-main">' +
          '<div class="ticket-title"><b>' + t.key + '</b>: ' + t.summary.replace(/</g, "&lt;") + '<span class="repo-tag' + tagClass + '">' + (REPO_RU[t.repo] || t.repo) + '</span></div>' +
          '<div class="ticket-desc">' + t.description.slice(0, 220).replace(/</g, "&lt;") + '</div>' +
        '</div>' +
        '<button class="start-btn" onclick="startTicket(\\'' + t.key + '\\', this)"' + (routable ? '' : ' disabled title="не удаётся определить репозиторий автоматически"') + '>Запустить</button>' +
      '</div>';
    }).join("");
  } catch (e) {
    container.innerHTML = '<div class="empty">не удалось загрузить: ' + e.message + '</div>';
  }
}

tick();
setInterval(tick, 2000);
loadTickets();
setInterval(loadTickets, 15000);
</script>

<script>
// Пиксель-арт пародия на "Тайную вечерю": зал с окнами и гобеленами, длинный
// стол с белой скатертью, фигуры-"агенты" в разноцветных одеждах. В простое —
// каждый в своём ритме подносит кубок ко рту. В работе — по цепочке из рук в
// руки идёт документ, у текущих "держателей" руки вытянуты к соседям.
var sceneMode = "idle";
var canvas = document.getElementById("scene");
var ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

var W = canvas.width, H = canvas.height;
var CEIL_H = 20;
var WALL_BOTTOM = 192;
var TABLE_X0 = 30, TABLE_X1 = W - 30;
var TABLE_Y = 150, TABLE_H = 14;

var FIGURES = 9;
var CENTER = 4;
var SPAN = TABLE_X1 - TABLE_X0 - 40;
function figX(i) { return TABLE_X0 + 20 + (SPAN / (FIGURES - 1)) * i; }

var HAIRS = ["#3b2a1a", "#5c4530", "#8a8a8a", "#2a1f14", "#6b4423", "#3b2a1a", "#8a8a8a", "#5c4530", "#2a1f14"];
var BEARDS = [true, false, true, true, false, true, false, true, true];
var ROBES = ["#7a3b3b", "#3b5c7a", "#4a7a4a", "#6b4a2e", "#2e4a6b", "#5a3b6b", "#4a7a4a", "#8a7a3a", "#7a3b3b"];
var ACCENTS = ["#d8c48a", "#aee0e8", "#d8e8a8", "#e8c48a", "#a8c8e8", "#e8aee0", "#f0e0a0", "#c8a8e8", "#e8d8a0"];
var LEAN = [3, -2, 4, -3, 0, 2, -4, 3, -2];
var SKIN = "#e0ac69";

function drawCeiling() {
  ctx.fillStyle = "#44403a"; ctx.fillRect(0, 0, W, CEIL_H);
  ctx.fillStyle = "#302c27";
  for (var x = 0; x < W; x += 36) ctx.fillRect(x, 0, 3, CEIL_H);
  ctx.fillRect(0, CEIL_H - 3, W, 3);
}

function drawWall() {
  ctx.fillStyle = "#596273"; ctx.fillRect(0, CEIL_H, W, WALL_BOTTOM - CEIL_H);
  ctx.fillStyle = "#4c5564";
  for (var y = CEIL_H + 10; y < WALL_BOTTOM; y += 12) ctx.fillRect(0, y, W, 1);
}

function drawTapestry(x, y, w, h) {
  ctx.fillStyle = "#3a2210"; ctx.fillRect(x, y, w, h);
  var cell = 7;
  for (var yy = 0; yy < h; yy += cell) {
    for (var xx = 0; xx < w; xx += cell) {
      if (((xx / cell + yy / cell) % 2) === 0) {
        ctx.fillStyle = "#8a6a1a";
        ctx.fillRect(x + xx, y + yy, cell - 1, cell - 1);
      }
    }
  }
}

function drawWindow(x, w, topY, botY) {
  ctx.fillStyle = "#2e2a24"; ctx.fillRect(x - 4, topY - 4, w + 8, botY - topY + 8);
  var steps = 4, stepH = 4;
  for (var s = 0; s < steps; s++) {
    var inset = (steps - 1 - s) * (w / 2 / steps);
    ctx.fillStyle = "#cfe3f0";
    ctx.fillRect(x + inset, topY + s * stepH, w - inset * 2, stepH);
  }
  var skyTop = topY + steps * stepH;
  var skyH = (botY - topY) - steps * stepH - 16;
  ctx.fillStyle = "#bcdcee"; ctx.fillRect(x, skyTop, w, skyH * 0.5);
  ctx.fillStyle = "#e9ddb8"; ctx.fillRect(x, skyTop + skyH * 0.5, w, skyH * 0.5);
  ctx.fillStyle = "#8a7a63";
  var mTop = skyTop + skyH - 4;
  ctx.fillRect(x, mTop + 6, w, 6);
  ctx.fillRect(x + w * 0.12, mTop, w * 0.3, 10);
  ctx.fillRect(x + w * 0.55, mTop - 4, w * 0.28, 14);
  ctx.fillStyle = "#c9b98a"; ctx.fillRect(x, botY - 6, w, 6);
}

function drawFloor() {
  ctx.fillStyle = "#8a6a44"; ctx.fillRect(0, WALL_BOTTOM, W, H - WALL_BOTTOM);
  ctx.fillStyle = "#7a5a38";
  for (var x = 0; x < W; x += 22) ctx.fillRect(x, WALL_BOTTOM, 1, H - WALL_BOTTOM);
}

function drawTableBase() {
  ctx.fillStyle = "#4a3220";
  for (var lx = TABLE_X0 + 24; lx < TABLE_X1; lx += 90) ctx.fillRect(lx, TABLE_Y + TABLE_H + 2, 7, 40);
  ctx.fillStyle = "#f2f0e8"; ctx.fillRect(TABLE_X0, TABLE_Y, TABLE_X1 - TABLE_X0, TABLE_H);
  ctx.fillStyle = "#d8d4c4";
  for (var tx = TABLE_X0; tx < TABLE_X1; tx += 14) ctx.fillRect(tx, TABLE_Y, 1, TABLE_H);
  ctx.fillStyle = "#e8e4d8"; ctx.fillRect(TABLE_X0, TABLE_Y + TABLE_H, TABLE_X1 - TABLE_X0, 8);
}

function drawPlate(x) {
  ctx.fillStyle = "#cfcfcf"; ctx.fillRect(x - 7, TABLE_Y - 4, 14, 5);
  ctx.fillStyle = "#a63a3a"; ctx.fillRect(x - 3, TABLE_Y - 3, 3, 2);
}

function drawFigure(i, reach, bob) {
  var x = figX(i), lean = LEAN[i];
  var baseY = 96 + bob;
  var isCenter = i === CENTER;
  var robe = isCenter ? "#b23a3a" : ROBES[i % ROBES.length];
  var accent = isCenter ? "#3b5c9a" : ACCENTS[i % ACCENTS.length];
  var hair = HAIRS[i % HAIRS.length];

  ctx.fillStyle = hair; ctx.fillRect(x - 9 + lean, baseY - 28, 18, 7);
  ctx.fillStyle = SKIN; ctx.fillRect(x - 7 + lean, baseY - 24, 14, 13);
  if (BEARDS[i % BEARDS.length]) { ctx.fillStyle = hair; ctx.fillRect(x - 6 + lean, baseY - 13, 12, 6); }
  ctx.fillStyle = "#f2ead8"; ctx.fillRect(x - 3 + lean, baseY - 11, 6, 5);

  ctx.fillStyle = robe; ctx.fillRect(x - 16 + lean, baseY - 6, 32, 10);
  ctx.fillStyle = robe; ctx.fillRect(x - 20 + lean, baseY + 4, 40, 16);
  ctx.fillStyle = robe; ctx.fillRect(x - 24 + lean, baseY + 20, 48, 24);
  ctx.fillStyle = accent; ctx.fillRect(x - 4 + lean, baseY + 4, 8, 36);

  var reachL = reach === "both" || reach === "left" ? 9 : 0;
  var reachR = reach === "both" || reach === "right" ? 9 : 0;
  ctx.fillStyle = robe;
  ctx.fillRect(x - 25 + lean - reachL, baseY + 8, 9, 18);
  ctx.fillRect(x + 16 + lean + reachR, baseY + 8, 9, 18);
  if (reachL) { ctx.fillStyle = SKIN; ctx.fillRect(x - 27 + lean - reachL, baseY + 20, 6, 6); }
  if (reachR) { ctx.fillStyle = SKIN; ctx.fillRect(x + 21 + lean + reachR, baseY + 20, 6, 6); }
}

function drawIdleCup(i, t) {
  var x = figX(i), lean = LEAN[i];
  var phase = (t + i / FIGURES) % 1;
  var lift = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  var cupY = (TABLE_Y - 6) - lift * 20;
  ctx.fillStyle = "#e4e4e4"; ctx.fillRect(x + lean - 2, cupY, 5, 7);
}

function computeTravel(t) {
  var span = FIGURES - 1;
  var pos = (t * span) % span;
  var i = Math.floor(pos), frac = pos - i;
  var x0 = figX(i), x1 = figX(Math.min(i + 1, FIGURES - 1));
  var x = x0 + (x1 - x0) * frac;
  var y = 112 - Math.sin(frac * Math.PI) * 12;
  return { i: i, frac: frac, x: x, y: y };
}

function drawFileTile(travel) {
  ctx.fillStyle = "#fef3c7"; ctx.fillRect(travel.x - 6, travel.y - 4, 12, 9);
  ctx.fillStyle = "#b08900"; ctx.fillRect(travel.x - 4, travel.y - 1, 8, 1); ctx.fillRect(travel.x - 4, travel.y + 1, 6, 1);
}

var t0 = Date.now();
function drawScene() {
  var t = (Date.now() - t0) / 1000;
  ctx.fillStyle = "#11151c"; ctx.fillRect(0, 0, W, H);

  drawCeiling();
  drawWall();
  drawTapestry(40, 26, 36, 110);
  drawTapestry(W - 76, 26, 36, 110);
  var winW = 50, gap = 16;
  var total = winW * 3 + gap * 2;
  var startX = (W - total) / 2;
  drawWindow(startX, winW, 30, 140);
  drawWindow(startX + winW + gap, winW, 30, 140);
  drawWindow(startX + 2 * (winW + gap), winW, 30, 140);
  drawFloor();
  drawTableBase();

  var holderA = -1, holderB = -1, travel = null;
  if (sceneMode === "working") {
    travel = computeTravel(t * 0.4);
    holderA = travel.i;
    holderB = Math.min(travel.i + 1, FIGURES - 1);
  }

  for (var i = 0; i < FIGURES; i++) {
    var reach = "none";
    if (i === holderA) reach = "right";
    else if (i === holderB) reach = "left";
    var bob = sceneMode === "idle" ? Math.sin(t * 1.2 + i) * 1.5 : 0;
    drawFigure(i, reach, bob);
    drawPlate(figX(i));
  }

  if (sceneMode === "idle") {
    for (var j = 0; j < FIGURES; j++) drawIdleCup(j, t * 0.4);
  } else if (travel) {
    drawFileTile(travel);
  }
}

drawScene();
setInterval(drawScene, 90);
</script>
</body>
</html>
`;
