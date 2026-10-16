/* Tiny dependency-free SVG chart helpers for the admin page.
   Exposed as window.AdminCharts (one global; everything else is private
   to this IIFE). Every builder is a pure function that returns a markup
   STRING, so it can be unit-tested in Node and dropped into innerHTML:

     AdminCharts.lineChart({ width, height, labels, series, ... })  -> <svg>
     AdminCharts.barChart({ width, height, labels, values, ... })    -> <svg>
       (vertical by default; horizontal: true for ranked categories)
     AdminCharts.sparkline(values, { width, height, color })        -> <svg>
     AdminCharts.heatStrip({ labels, values, ... })                 -> <ol>
     AdminCharts.mount(el, (width) => markup)
       renders at the element's real pixel width (so text never shrinks on
       a phone the way a scaled viewBox would), re-renders when that width
       changes, and wires the shared hover/tap tooltip once per element.

   Accessibility: each <svg> is role="img" with a <title>/<desc> (pass
   `title` and `desc`); callers should also offer a data table (the
   Analytics tab puts one in a <details> under each chart). The tooltip is
   aria-hidden — it duplicates what the table already says.

   Colours: pass any CSS colour, including var(--token, #fallback) — marks
   use style="" (SVG presentation attributes can't read custom properties).
   Axis/grid/text colours come from CSS classes (ac-*) in
   css/admin-analytics.css. */
(function () {
  "use strict";

  let uid = 0;
  const nextId = (p) => `${p}-${++uid}`;

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const r1 = (n) => Math.round(n * 10) / 10;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const defaultFormat = (v) => Number(v).toLocaleString();

  /* "Nice" axis: ticks at 1/2/2.5/5 x 10^n steps from 0 up to >= max.
     Returns { max, step, ticks }. max <= 0 gets a 0..1 axis. */
  function niceScale(maxValue, maxTicks) {
    const target = Math.max(2, maxTicks || 4);
    const max = num(maxValue);
    if (max <= 0) return { max: 1, step: 1, ticks: [0, 1] };
    const raw = max / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw - 1e-12);
    const top = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let t = 0; t <= top + step / 2; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
    return { max: top, step, ticks };
  }

  /* Which x indexes get a label: always first and last, then evenly spaced
     so labels are at least minGap px apart. */
  function xLabelIndexes(n, plotWidth, minGap) {
    if (n <= 0) return [];
    if (n === 1) return [0];
    const fit = Math.max(2, Math.floor(plotWidth / (minGap || 64)) + 1);
    if (n <= fit) return Array.from({ length: n }, (_, i) => i);
    const every = Math.ceil((n - 1) / (fit - 1));
    const out = [];
    for (let i = 0; i < n; i += every) out.push(i);
    if (out[out.length - 1] !== n - 1) {
      // Drop the last regular label if it would crowd the final one.
      if ((n - 1 - out[out.length - 1]) < every / 2) out.pop();
      out.push(n - 1);
    }
    return out;
  }

  // Bar path with a 6px (--a-radius-xs) rounded data-end (top, or right when
  // horizontal), square at the baseline.
  function barPath(x, y, w, h, horizontal) {
    if (w <= 0 || h <= 0) return "";
    if (horizontal) {
      const r = Math.min(6, h / 2, w);
      return `M${r1(x)},${r1(y)}h${r1(w - r)}a${r},${r} 0 0 1 ${r},${r}v${r1(h - 2 * r)}a${r},${r} 0 0 1 -${r},${r}h-${r1(w - r)}z`;
    }
    const r = Math.min(6, w / 2, h);
    return `M${r1(x)},${r1(y + h)}v-${r1(h - r)}a${r},${r} 0 0 1 ${r},-${r}h${r1(w - 2 * r)}a${r},${r} 0 0 1 ${r},${r}v${r1(h - r)}z`;
  }

  function svgOpen(width, height, title, desc, extraClass) {
    const tid = nextId("act");
    const did = nextId("acd");
    return {
      open: `<svg class="ac-svg ${extraClass || ""}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${tid} ${did}" xmlns="http://www.w3.org/2000/svg"><title id="${tid}">${esc(title || "Chart")}</title><desc id="${did}">${esc(desc || "")}</desc>`,
      close: "</svg>"
    };
  }

  function emptyChart(width, height, title, message) {
    const s = svgOpen(width, height, title, message);
    return `${s.open}<text class="ac-empty" x="${width / 2}" y="${height / 2}" text-anchor="middle">${esc(message)}</text>${s.close}`;
  }

  /* Approximate text width for the 11px axis font — good enough to size the
     y-axis gutter and truncate category labels without measuring the DOM. */
  const textWidth = (s, px) => String(s).length * (px || 11) * 0.58;

  function truncate(s, maxPx, px) {
    const str = String(s == null ? "" : s);
    const maxChars = Math.max(3, Math.floor(maxPx / ((px || 11) * 0.58)));
    return str.length > maxChars ? str.slice(0, maxChars - 1) + "…" : str;
  }

  /* Line / area chart. One y axis only — put measures of different scale in
     separate charts.
       labels:   x labels (short, shown on the axis)
       tipLabels (optional): longer x labels for the tooltip
       series:   [{ name, values, color, area }]
       format:   value -> string (tooltip + y ticks; yFormat overrides ticks)
       title/desc: accessible name/description */
  function lineChart(opts) {
    const o = opts || {};
    const width = Math.max(200, Math.round(o.width || 600));
    const height = Math.max(120, Math.round(o.height || 200));
    const labels = o.labels || [];
    const series = (o.series || []).filter((s) => s && s.values);
    const n = labels.length;
    const fmt = o.format || defaultFormat;
    const yFmt = o.yFormat || fmt;
    if (!n || !series.length) return emptyChart(width, height, o.title, o.emptyText || "No data in this range.");

    const maxV = Math.max(0, ...series.flatMap((s) => s.values.map(num)));
    const scale = niceScale(maxV, height < 160 ? 3 : 4);
    const legend = series.length > 1;
    const padTop = legend ? 30 : 12;
    const padBottom = 24;
    const padLeft = Math.ceil(Math.max(...scale.ticks.map((t) => textWidth(yFmt(t))))) + 12;
    const padRight = 12;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    const x = (i) => padLeft + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v) => padTop + plotH - (num(v) / scale.max) * plotH;
    const s = svgOpen(width, height, o.title, o.desc, "ac-line");
    const parts = [s.open];

    // Grid + y ticks (recessive).
    scale.ticks.forEach((t) => {
      const yy = r1(y(t));
      parts.push(`<line class="ac-grid${t === 0 ? " ac-baseline" : ""}" x1="${padLeft}" x2="${width - padRight}" y1="${yy}" y2="${yy}"/>`);
      parts.push(`<text class="ac-tick" x="${padLeft - 6}" y="${yy}" dy="0.32em" text-anchor="end">${esc(yFmt(t))}</text>`);
    });
    // X labels.
    xLabelIndexes(n, plotW, o.minLabelGap || 70).forEach((i) => {
      const anchor = n === 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle";
      parts.push(`<text class="ac-tick" x="${r1(x(i))}" y="${height - 6}" text-anchor="${anchor}">${esc(labels[i])}</text>`);
    });
    // Legend (only for 2+ series): swatch + name in text ink.
    if (legend) {
      let lx = padLeft;
      series.forEach((ser) => {
        // Swatch repeats the line's dash so series differ by more than colour.
        parts.push(`<line x1="${lx}" x2="${lx + 14}" y1="9.5" y2="9.5" stroke-width="2" stroke-linecap="round"${ser.dash ? ` stroke-dasharray="${esc(ser.dash)}"` : ""} style="stroke:${ser.color}"/><text class="ac-legend" x="${lx + 19}" y="10" dy="0.32em">${esc(ser.name)}</text>`);
        lx += 19 + textWidth(ser.name, 12) + 18;
      });
    }
    // Areas (a soft gradient from the series colour to nothing) then lines.
    series.forEach((ser) => {
      const pts = ser.values.map((v, i) => `${r1(x(i))},${r1(y(v))}`);
      if (ser.area !== false && n > 1) {
        const gid = nextId("acg");
        parts.push(`<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${ser.color}" stop-opacity="0.28"/><stop offset="1" style="stop-color:${ser.color}" stop-opacity="0.02"/></linearGradient></defs>`);
        parts.push(`<path class="ac-area" d="M${r1(x(0))},${r1(y(0))}L${pts.join("L")}L${r1(x(n - 1))},${r1(y(0))}Z" fill="url(#${gid})"/>`);
      }
      if (n > 1) parts.push(`<path class="ac-path" d="M${pts.join("L")}"${ser.dash ? ` stroke-dasharray="${esc(ser.dash)}"` : ""} style="stroke:${ser.color}"/>`);
    });
    // Static markers only when sparse enough to read (or a lone point).
    const showDots = n <= 16;
    series.forEach((ser, si) => {
      ser.values.forEach((v, i) => {
        parts.push(`<circle class="ac-dot${showDots ? " is-static" : ""}" data-i="${i}" data-s="${si}" cx="${r1(x(i))}" cy="${r1(y(v))}" r="4" style="fill:${ser.color}"/>`);
      });
    });
    // Crosshair + one full-height hit column per x (bigger than the mark).
    parts.push(`<line class="ac-cross" x1="0" x2="0" y1="${padTop}" y2="${padTop + plotH}" visibility="hidden"/>`);
    const colW = n === 1 ? plotW : plotW / (n - 1);
    const tipLabels = o.tipLabels || labels;
    for (let i = 0; i < n; i++) {
      const left = Math.max(padLeft, x(i) - colW / 2);
      const right = Math.min(width - padRight, x(i) + colW / 2);
      const tip = [tipLabels[i], ...series.map((ser) => `${ser.name}: ${fmt(num(ser.values[i]))}`)].join("\n");
      parts.push(`<rect class="ac-hit" x="${r1(left)}" y="${padTop}" width="${r1(Math.max(1, right - left))}" height="${plotH}" data-i="${i}" data-cx="${r1(x(i))}" data-tip="${esc(tip)}"/>`);
    }
    parts.push(s.close);
    return parts.join("");
  }

  /* Bar chart.
       vertical (default): labels along x, one bar per label — for time
         buckets (months, weeks, weekdays).
       horizontal: true — ranked categories, label left / value right,
         height grows with the row count (rowHeight, default 28).
     A 2px gap separates adjacent bars; values are formatted with format(). */
  function barChart(opts) {
    const o = opts || {};
    const width = Math.max(200, Math.round(o.width || 600));
    const labels = o.labels || [];
    const values = (o.values || []).map(num);
    const n = labels.length;
    const fmt = o.format || defaultFormat;
    const color = o.color || "currentColor";
    const tipLabels = o.tipLabels || labels;

    if (o.horizontal) {
      const rowH = o.rowHeight || 28;
      const height = Math.max(40, n * rowH + 8);
      if (!n) return emptyChart(width, 60, o.title, o.emptyText || "No data in this range.");
      const max = Math.max(0, ...values) || 1;
      const valueLabels = values.map((v) => fmt(v));
      const valueW = Math.ceil(Math.max(...valueLabels.map((v) => textWidth(v, 12)))) + 10;
      const labelW = Math.min(Math.round(width * 0.42), Math.ceil(Math.max(...labels.map((l) => textWidth(l, 12)))) + 10);
      const plotW = Math.max(20, width - labelW - valueW);
      const s = svgOpen(width, height, o.title, o.desc, "ac-bars ac-bars-h");
      const parts = [s.open];
      labels.forEach((label, i) => {
        const top = 4 + i * rowH;
        const barH = Math.min(14, rowH - 10);
        const by = top + (rowH - barH) / 2;
        const w = (values[i] / max) * plotW;
        const tip = `${tipLabels[i]}\n${o.valueName ? o.valueName + ": " : ""}${valueLabels[i]}`;
        parts.push(`<text class="ac-cat" x="0" y="${r1(top + rowH / 2)}" dy="0.32em">${esc(truncate(label, labelW - 8, 12))}</text>`);
        if (w > 0) parts.push(`<path class="ac-bar" d="${barPath(labelW, by, Math.max(w, 2), barH, true)}" style="fill:${color}"/>`);
        parts.push(`<text class="ac-val" x="${width}" y="${r1(top + rowH / 2)}" dy="0.32em" text-anchor="end">${esc(valueLabels[i])}</text>`);
        parts.push(`<rect class="ac-hit" x="0" y="${top}" width="${width}" height="${rowH}" data-tip="${esc(tip)}"/>`);
      });
      parts.push(s.close);
      return parts.join("");
    }

    const height = Math.max(120, Math.round(o.height || 180));
    if (!n) return emptyChart(width, height, o.title, o.emptyText || "No data in this range.");
    const yFmt = o.yFormat || fmt;
    const scale = niceScale(Math.max(0, ...values), height < 160 ? 3 : 4);
    const padTop = 20; // room for value labels above the tallest bar
    const padBottom = 24;
    const padLeft = Math.ceil(Math.max(...scale.ticks.map((t) => textWidth(yFmt(t))))) + 12;
    const padRight = 8;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    const slot = plotW / n;
    const gap = Math.max(2, Math.min(slot * 0.3, 12));
    const barW = Math.max(1, slot - gap);
    const y = (v) => padTop + plotH - (v / scale.max) * plotH;
    const s = svgOpen(width, height, o.title, o.desc, "ac-bars");
    const parts = [s.open];
    scale.ticks.forEach((t) => {
      const yy = r1(y(t));
      parts.push(`<line class="ac-grid${t === 0 ? " ac-baseline" : ""}" x1="${padLeft}" x2="${width - padRight}" y1="${yy}" y2="${yy}"/>`);
      parts.push(`<text class="ac-tick" x="${padLeft - 6}" y="${yy}" dy="0.32em" text-anchor="end">${esc(yFmt(t))}</text>`);
    });
    const labelIdx = new Set(xLabelIndexes(n, plotW, o.minLabelGap || 44));
    labels.forEach((label, i) => {
      const bx = padLeft + i * slot + gap / 2;
      const h = (values[i] / scale.max) * plotH;
      if (h > 0) parts.push(`<path class="ac-bar" d="${barPath(bx, y(values[i]), barW, Math.max(h, 1.5), false)}" style="fill:${color}"/>`);
      // Value above the bar where it fits inside the bar's slot.
      if (values[i] > 0 && o.valueLabels !== false && textWidth(fmt(values[i]), 11) <= slot - 2) {
        parts.push(`<text class="ac-val-sm" x="${r1(bx + barW / 2)}" y="${r1(y(values[i]) - 5)}" text-anchor="middle">${esc(fmt(values[i]))}</text>`);
      }
      if (labelIdx.has(i)) parts.push(`<text class="ac-tick" x="${r1(bx + barW / 2)}" y="${height - 6}" text-anchor="middle">${esc(label)}</text>`);
      const tip = `${tipLabels[i]}\n${o.valueName ? o.valueName + ": " : ""}${fmt(values[i])}`;
      parts.push(`<rect class="ac-hit" x="${r1(padLeft + i * slot)}" y="${padTop}" width="${r1(slot)}" height="${plotH}" data-tip="${esc(tip)}"/>`);
    });
    parts.push(s.close);
    return parts.join("");
  }

  /* Decorative trend line for a stat tile (aria-hidden: the tile's text
     carries the number). Flat zero series draws a baseline. */
  function sparkline(values, opts) {
    const o = opts || {};
    const width = o.width || 120;
    const height = o.height || 28;
    const vals = (values || []).map(num);
    const color = o.color || "currentColor";
    if (vals.length < 2) return `<svg class="ac-spark" width="${width}" height="${height}" aria-hidden="true" focusable="false"></svg>`;
    const max = Math.max(...vals);
    const min = Math.min(0, ...vals);
    const span = max - min || 1;
    const pad = 3;
    const pts = vals.map((v, i) => `${r1(pad + (i / (vals.length - 1)) * (width - 2 * pad))},${r1(height - pad - ((v - min) / span) * (height - 2 * pad))}`);
    const last = pts[pts.length - 1].split(",");
    const first = pts[0].split(",");
    return `<svg class="ac-spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false"><path d="M${first[0]},${height - pad}L${pts.join("L")}L${last[0]},${height - pad}Z" stroke="none" opacity="0.12" style="fill:${color}"/><path d="M${pts.join("L")}" fill="none" style="stroke:${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${last[0]}" cy="${last[1]}" r="2.5" style="fill:${color}"/></svg>`;
  }

  /* One row of cells, shade = value / max (single hue, light -> dark), and
     every cell also prints its number, so colour is never the only cue.
     Returns an <ol> (HTML, not SVG) so it wraps/shrinks with CSS grid.
       labels, values, tipLabels?, format?, title (aria-label of the list) */
  function heatStrip(opts) {
    const o = opts || {};
    const labels = o.labels || [];
    const values = (o.values || []).map(num);
    const fmt = o.format || defaultFormat;
    const max = Math.max(0, ...values);
    const tipLabels = o.tipLabels || labels;
    const cells = labels.map((label, i) => {
      const t = max > 0 ? values[i] / max : 0;
      // 0..4 shade step; CSS maps each step to a token.
      const step = values[i] <= 0 ? 0 : Math.min(4, 1 + Math.floor(t * 3.999));
      return `<li class="ac-heat-cell ac-heat-${step}" data-tip="${esc(`${tipLabels[i]}\n${o.valueName ? o.valueName + ": " : ""}${fmt(values[i])}`)}"><span class="ac-heat-label">${esc(label)}</span><span class="ac-heat-value">${esc(fmt(values[i]))}</span></li>`;
    }).join("");
    return `<ol class="ac-heat" aria-label="${esc(o.title || "Heat strip")}">${cells}</ol>`;
  }

  /* ---- Tooltip (one per mounted element, shared by every chart in it) ---- */
  function showTip(host, target, clientX) {
    let tip = host.querySelector(":scope > .ac-tip");
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "ac-tip";
      tip.setAttribute("aria-hidden", "true");
      host.appendChild(tip);
    }
    const lines = String(target.getAttribute("data-tip") || "").split("\n");
    tip.textContent = "";
    lines.forEach((line, i) => {
      const div = document.createElement("div");
      if (i === 0) div.className = "ac-tip-title";
      div.textContent = line;
      tip.appendChild(div);
    });
    tip.hidden = false;

    // Crosshair + highlight the hovered column's dots (line charts).
    const svg = target.closest("svg");
    host.querySelectorAll(".ac-dot.is-active").forEach((d) => d.classList.remove("is-active"));
    host.querySelectorAll(".ac-cross").forEach((c) => c.setAttribute("visibility", "hidden"));
    if (svg && target.hasAttribute("data-cx")) {
      const cross = svg.querySelector(".ac-cross");
      if (cross) {
        cross.setAttribute("x1", target.getAttribute("data-cx"));
        cross.setAttribute("x2", target.getAttribute("data-cx"));
        cross.setAttribute("visibility", "visible");
      }
      svg.querySelectorAll(`.ac-dot[data-i="${target.getAttribute("data-i")}"]`).forEach((d) => d.classList.add("is-active"));
    }

    const hostRect = host.getBoundingClientRect();
    const tRect = target.getBoundingClientRect();
    const anchorX = target.hasAttribute("data-cx") && svg
      ? svg.getBoundingClientRect().left + Number(target.getAttribute("data-cx"))
      : (typeof clientX === "number" && tRect.width > 160 ? clientX : tRect.left + tRect.width / 2);
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    let left = anchorX - hostRect.left - tipW / 2;
    left = Math.max(0, Math.min(left, hostRect.width - tipW));
    let top = tRect.top - hostRect.top - tipH - 8;
    if (top < 0) top = tRect.bottom - hostRect.top + 8;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function hideTip(host) {
    const tip = host.querySelector(":scope > .ac-tip");
    if (tip) tip.hidden = true;
    host.querySelectorAll(".ac-dot.is-active").forEach((d) => d.classList.remove("is-active"));
    host.querySelectorAll(".ac-cross").forEach((c) => c.setAttribute("visibility", "hidden"));
  }

  function wireTooltips(host) {
    if (host.__acTips) return;
    host.__acTips = true;
    host.classList.add("ac-host");
    const onPoint = (e) => {
      const target = e.target.closest && e.target.closest("[data-tip]");
      if (target && host.contains(target)) showTip(host, target, e.clientX);
      else hideTip(host);
    };
    host.addEventListener("pointermove", onPoint);
    host.addEventListener("pointerdown", onPoint); // tap on touch screens
    host.addEventListener("pointerleave", () => hideTip(host));
  }

  /* Renders render(width) into el now and whenever el's width changes. */
  function redraw(el) {
    // A hidden element (closed <details>, inactive tab) measures 0: draw at
    // a phone-ish width for now; the observer redraws once it's visible.
    const measured = Math.floor(el.clientWidth || 0);
    if (measured === el.__acWidth) return;
    el.__acWidth = measured;
    const tip = el.querySelector(":scope > .ac-tip");
    el.innerHTML = el.__acRender(measured || 320);
    if (tip) { tip.hidden = true; el.appendChild(tip); }
  }

  function mount(el, render) {
    if (!el) return;
    wireTooltips(el);
    el.__acRender = render; // a later mount() on the same element swaps it
    el.__acWidth = -1;
    redraw(el);
    if (typeof ResizeObserver === "function" && !el.__acObserver) {
      let frame = 0;
      el.__acObserver = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          // Replaced by a re-render of the page: stop watching it.
          if (!el.isConnected) { el.__acObserver.disconnect(); el.__acObserver = null; return; }
          redraw(el);
        });
      });
      el.__acObserver.observe(el);
    }
  }

  const api = { lineChart, barChart, sparkline, heatStrip, mount, niceScale, xLabelIndexes, escape: esc };
  if (typeof window !== "undefined") window.AdminCharts = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
