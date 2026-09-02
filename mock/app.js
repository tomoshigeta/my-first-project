/* ============================================================
   共通ロジック — 集計・整形・描画ヘルパ
   ============================================================ */
(function () {
  "use strict";
  const D = window.ASSET_DATA;

  /* ---------- 整形 ---------- */
  const yen = n => "¥ " + Math.round(n).toLocaleString("ja-JP");
  const plain = n => Math.round(n).toLocaleString("ja-JP");

  /* 損益の整形（日本式）: 益 = "+123" / 損 = "▲123"（▲は会計慣行のマイナス） */
  function pl(n) {
    const v = Math.round(n);
    if (v === 0) return { text: "±0", cls: "" };
    return v > 0
      ? { text: "+" + v.toLocaleString("ja-JP"), cls: "gain" }
      : { text: "▲" + Math.abs(v).toLocaleString("ja-JP"), cls: "loss" };
  }
  function plHTML(n, suffix) {
    const p = pl(n);
    return '<span class="' + p.cls + ' num">' + p.text + (suffix || "") + "</span>";
  }

  const pct = (a, b) => b === 0 ? "0.0%" : (a / b * 100).toFixed(1) + "%";

  /* 損益率も日本式で表す（+x.x% / ▲x.x%）。文字色は損益色。 */
  function plPctHTML(n, base) {
    if (!base) return '<span class="num">\u2014</span>';
    const v = n / base * 100;
    const s = Math.abs(v).toFixed(1) + "%";
    if (Math.round(v * 10) === 0) return '<span class="num">\u00b10.0%</span>';
    return v > 0
      ? '<span class="gain num">+' + s + "</span>"
      : '<span class="loss num">\u25b2' + s + "</span>";
  }
  const rate = cur => D.rates[cur] != null ? D.rates[cur] : 1;

  /* ---------- 集計 ---------- */
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

  const RE = {
    totalInvestment:  sum(D.realEstate, p => p.totalInvestment),
    ownFunds:         sum(D.realEstate, p => p.ownFunds),
    principal:        sum(D.realEstate, p => p.loan.principal),
    balance:          sum(D.realEstate, p => p.loan.balance),
    cumulativeRepaid: sum(D.realEstate, p => p.loan.cumulativeRepaid)
  };
  RE.progress = RE.cumulativeRepaid / RE.principal;

  /* 月次収支: 家賃 − ローン返済 − 経費（管理費・修繕積立・固都税） */
  function cashflow(p) {
    const m = p.monthly;
    const expenses = m.managementFee + m.repairReserve + m.propertyTaxMonthly;
    return {
      rentIncome: m.rentIncome,
      repayment: p.loan.monthlyRepayment,
      managementFee: m.managementFee,
      repairReserve: m.repairReserve,
      propertyTax: m.propertyTaxMonthly,
      expenses,
      net: m.rentIncome - p.loan.monthlyRepayment - expenses
    };
  }
  const CF_TOTAL = D.realEstate.map(cashflow).reduce((a, c) => ({
    rentIncome: a.rentIncome + c.rentIncome,
    repayment:  a.repayment  + c.repayment,
    expenses:   a.expenses   + c.expenses,
    net:        a.net        + c.net
  }), { rentIncome: 0, repayment: 0, expenses: 0, net: 0 });

  /* 有価証券を円換算 */
  const SEC = D.securities.map(s => {
    const r = rate(s.currency);
    return Object.assign({}, s, {
      costJPY: s.cost * r,
      valueJPY: s.marketValue * r,
      plNative: s.marketValue - s.cost,
      plJPY: (s.marketValue - s.cost) * r
    });
  });

  const SEC_VALUE = sum(SEC, s => s.valueJPY);
  const SEC_COST  = sum(SEC, s => s.costJPY);
  const SEC_PL    = SEC_VALUE - SEC_COST;
  const DEPOSITS  = sum(D.deposits, d => d.amount * rate(d.currency));

  /* 金融資産 = 有価証券評価額 + 預貯金（不動産を含まない / Q24） */
  const FINANCIAL_ASSETS = SEC_VALUE + DEPOSITS;

  /* 総負債 = 不動産ローン残債 + その他ローン残債（Q24） */
  const OTHER_DEBT = sum(D.otherLoans, l => l.balance);
  const TOTAL_DEBT = RE.balance + OTHER_DEBT;

  /* ---------- 描画ヘルパ ---------- */

  /** 積み上げ横棒 1本。segs = [{cls, value, label}] */
  function stackedBar(segs, scaleMax) {
    const total = sum(segs, s => s.value);
    const max = scaleMax || total;
    const html = segs.filter(s => s.value > 0).map(s =>
      '<div class="seg ' + s.cls + '" style="flex:' + s.value + ' 0 0"' +
      ' data-tip="' + s.label + '<br><b>' + yen(s.value) + '</b>（' + pct(s.value, total) + '）"></div>'
    ).join("");
    const restW = max - total;
    const rest = restW > 0 ? '<div class="seg seg-rest" style="flex:' + restW + ' 0 0"></div>' : "";
    return '<div class="bar-track">' + html + rest + "</div>";
  }

  /** 単色横棒（預貯金など、損益の概念がないもの） */
  function valueBar(value, max, tip) {
    const w = max === 0 ? 0 : value / max;
    return '<div class="bar-track">' +
      '<div class="seg seg-equity" style="flex:' + w + ' 0 0" data-tip="' + tip + '"></div>' +
      (1 - w > 0 ? '<div class="seg seg-rest" style="flex:' + (1 - w) + ' 0 0"></div>' : "") +
      "</div>";
  }

  /**
   * 含み損益バー。緑 = 元本のうち失われていない部分。
   *   含み益: [緑 取得原価][赤ハッチ 含み益]  → 棒の全長 = 評価額
   *   含み損: [緑 評価額  ][青ハッチ 含み損]  → 棒の全長 = 取得原価
   * どちらも棒の全長は max(取得原価, 評価額)。max を渡して行間で同じ縮尺にする。
   */
  function plBar(cost, value, max, label) {
    if (cost <= 0 && value <= 0) {
      return '<div class="bar-track"><div class="seg seg-rest" style="flex:1 0 0"></div></div>';
    }
    const gain = value - cost;
    const base = Math.min(cost, value);
    const segs = [{
      cls: "seg-equity", value: base,
      label: label + "<br>" + (gain >= 0 ? "取得原価" : "評価額（残っている元本）")
    }];
    if (gain > 0) segs.push({ cls: "seg-gain", value: gain,  label: label + "<br>含み益" });
    if (gain < 0) segs.push({ cls: "seg-loss", value: -gain, label: label + "<br>含み損" });
    return stackedBar(segs, max);
  }

  /* ---------- サイドバー ---------- */
  function sidebar(current) {
    const pages = [
      ["index.html",      "① サマリー"],
      ["realestate.html", "② 不動産"],
      ["accounts.html",   "③ 資産・負債明細"]
    ];
    const nav = pages.map(([href, label]) =>
      '<a href="' + href + '"' + (href === current ? ' aria-current="page"' : "") + ">" + label + "</a>"
    ).join("");
    return '' +
      '<div class="owner">' +
        '<div class="owner-label">保有者</div>' +
        '<div class="owner-name">' + D.owner.name + "</div>" +
        '<div class="owner-asof num">' + D.asOf + " 時点</div>" +
      "</div>" +
      '<nav class="nav">' + nav + "</nav>" +
      '<div class="sidebar-foot">' +
        '<button class="btn-future" disabled title="将来のアプリ化で実装します">' +
          "物件追加<small>準備中</small>" +
        "</button>" +
      "</div>";
  }

  /* ---------- ツールチップ ---------- */
  function initTooltip() {
    const tip = document.createElement("div");
    tip.id = "tip";
    document.body.appendChild(tip);
    document.addEventListener("mouseover", e => {
      const t = e.target.closest("[data-tip]");
      if (!t) return;
      tip.innerHTML = t.dataset.tip;
      tip.classList.add("on");
    });
    document.addEventListener("mousemove", e => {
      if (!tip.classList.contains("on")) return;
      const pad = 14;
      let x = e.clientX + pad, y = e.clientY + pad;
      const r = tip.getBoundingClientRect();
      if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
      if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
      tip.style.left = x + "px";
      tip.style.top = y + "px";
    });
    document.addEventListener("mouseout", e => {
      if (e.target.closest("[data-tip]")) tip.classList.remove("on");
    });
  }

  window.APP = {
    D, RE, SEC, SEC_VALUE, SEC_COST, SEC_PL, DEPOSITS,
    FINANCIAL_ASSETS, OTHER_DEBT, TOTAL_DEBT, CF_TOTAL,
    yen, plain, pl, plHTML, plPctHTML, pct, sum, cashflow,
    stackedBar, valueBar, plBar, sidebar, initTooltip
  };
})();
