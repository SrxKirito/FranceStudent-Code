"use strict";

let accountActivity = null;
let activityLoading = false;
const activityNumber = value => new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const activityExact = value => new Intl.NumberFormat("fr-FR").format(value);

function summarizeActivity(data) {
  const days = new Map();
  for (const row of Array.isArray(data.last7DaysTokenUsage) ? data.last7DaysTokenUsage : []) {
    const date = String(row.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const n = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
    days.set(date, { date, input: n(row.inputTokens), output: n(row.outputTokens), reasoning: n(row.reasoningTokens), total: row.totalTokens != null ? n(row.totalTokens) : n(row.inputTokens) + n(row.outputTokens) });
  }
  const rows = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const sum = key => rows.reduce((total, row) => total + row[key], 0);
  const peak = rows.reduce((best, row) => row.total > best.total ? row : best, { date: "", total: 0 });
  return { rows, days, total: sum("total"), input: sum("input"), output: sum("output"), reasoning: sum("reasoning"), active: rows.filter(row => row.total > 0).length, average: rows.length ? sum("total") / rows.length : 0, peak, lifetime: Number.isFinite(data.totalTokenCount) ? data.totalTokenCount : null };
}

function activityPair(label, value) {
  const row = settingsEl("div", "activity-pair");
  row.append(settingsEl("span", "", label), settingsEl("strong", "", value));
  return row;
}

function renderAccountActivity(data) {
  const summary = summarizeActivity(data);
  accountActivity = summary;
  const content = $("activity-content");
  content.replaceChildren();
  content.hidden = false;
  const metrics = settingsEl("div", "activity-metrics");
  for (const [label, value] of [["Tokens totaux", summary.lifetime], ["Pic journalier", summary.rows.length ? summary.peak.total : null], ["Jours actifs", summary.rows.length ? summary.active : null], ["Moyenne / jour renseigné", summary.rows.length ? summary.average : null]]) {
    const metric = settingsEl("div");
    metric.append(settingsEl("strong", "", value == null ? "—" : activityNumber(value)), settingsEl("span", "", label));
    metrics.append(metric);
  }
  content.append(metrics);
  if (!summary.rows.length) {
    content.append(settingsEl("p", "settings-hint", "Aucun historique journalier disponible pour cette période."));
    return;
  }
  const calendarBox = settingsEl("div", "activity-calendar-box");
  calendarBox.append(settingsEl("strong", "", activityExact(summary.total) + " tokens · " + summary.rows.length + " jours renseignés"));
  const scroll = settingsEl("div", "activity-calendar-scroll");
  const months = settingsEl("div", "activity-months");
  const calendar = settingsEl("div", "activity-calendar");
  calendar.setAttribute("aria-label", "Activité quotidienne des 343 derniers jours. Chaque case indique sa date et son nombre de tokens.");
  const todayKey = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const end = new Date(todayKey + "T00:00:00Z");
  const start = new Date(end.getTime() - 342 * 86400000);
  let lastMonth = -1;
  for (let index = 0; index < 343; index++) {
    const date = new Date(start.getTime() + index * 86400000);
    const key = date.toISOString().slice(0, 10);
    if (index % 7 === 0) {
      const label = settingsEl("span", "", date.getUTCMonth() !== lastMonth ? new Intl.DateTimeFormat("fr-FR", { month: "short", timeZone: "UTC" }).format(date) : "");
      months.append(label);
      lastMonth = date.getUTCMonth();
    }
    const row = summary.days.get(key);
    const cell = settingsEl("button", "activity-cell");
    cell.type = "button";
    const intensity = row ? (row.total > 0 ? Math.max(1, Math.ceil(row.total / Math.max(summary.peak.total, 1) * 4)) : 0) : 0;
    cell.dataset.level = String(intensity);
    if (!row) cell.classList.add("unreported");
    cell.title = key + " : " + (row ? activityExact(row.total) + " tokens" : "aucune donnée reçue");
    cell.setAttribute("aria-label", cell.title);
    cell.addEventListener("click", () => { $("activity-status").textContent = cell.title; });
    calendar.append(cell);
  }
  scroll.append(months, calendar);
  calendarBox.append(scroll, settingsEl("p", "settings-hint", "Clair = activité élevée · cases en pointillés = aucune donnée reçue."));
  content.append(calendarBox);
  const insights = settingsEl("div", "activity-insights");
  const totals = settingsEl("section");
  totals.append(settingsEl("h4", "", "Insights d’activité"), activityPair("Total période", activityNumber(summary.total)), activityPair("Pic journalier", (summary.peak.date ? summary.peak.date + " · " : "") + activityNumber(summary.peak.total)), activityPair("Jours actifs", String(summary.active)));
  const breakdown = settingsEl("section");
  breakdown.append(settingsEl("h4", "", "Répartition tokens"), activityPair("🔵 Input", activityNumber(summary.input)), activityPair("🟢 Output", activityNumber(summary.output)), activityPair("🟠 Reasoning", activityNumber(summary.reasoning)));
  insights.append(totals, breakdown);
  content.append(insights);
}

async function loadAccountActivity() {
  if (activityLoading) return;
  activityLoading = true;
  const session = store.session;
  $("activity-refresh").disabled = true;
  $("activity-share").disabled = true;
  $("activity-content").hidden = true;
  $("activity-status").textContent = "Chargement de l’activité…";
  try {
    const data = await settingsApi("/user/tokenusage?tokenUsageDays=343");
    if (store.session !== session) return;
    if (!data || typeof data !== "object") throw new Error("Réponse du serveur illisible.");
    renderAccountActivity(data);
    $("activity-share").disabled = false;
    $("activity-status").textContent = "Historique journalier disponible sur les 343 derniers jours.";
  } catch (err) { $("activity-status").textContent = "Activité indisponible : " + err.message; }
  finally { activityLoading = false; $("activity-refresh").disabled = false; }
}

function setupAccountActivity() {
  $("activity-refresh").addEventListener("click", loadAccountActivity);
  $("activity-share").addEventListener("click", async () => {
    if (!accountActivity) return;
    const text = "Mon activité FranceStudent : " + activityExact(accountActivity.total) + " tokens sur " + accountActivity.rows.length + " jours renseignés, " + accountActivity.active + " jours actifs.";
    try {
      if (navigator.share) await navigator.share({ title: "Mon activité FranceStudent", text });
      else {
        await saveFile("activite-francestudent.csv", new TextEncoder().encode("Date;Input;Output;Reasoning;Total\n" + accountActivity.rows.map(row => [row.date, row.input, row.output, row.reasoning, row.total].join(";")).join("\n")));
        $("activity-status").textContent = "Historique téléchargé au format CSV.";
      }
    } catch (err) { if (err.name !== "AbortError") $("activity-status").textContent = "Partage impossible : " + err.message; }
  });
}
