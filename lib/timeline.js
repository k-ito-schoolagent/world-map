// 年表つきスライダー（SVG）。時代の帯と出来事の印の上を、つまみで動かす。
// scale = { toTrack(value) → 0..1, toValue(track) → value, format(value) → 文字,
//           ticks: [{ value, label }], min, max, step }。値は年代（Ma）でも西暦でもよい。
// periods / eras は { name, start, end, color } で、start が左（古い側）、end が右。

const NS = "http://www.w3.org/2000/svg";
function el(name, attrs = {}, text) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 帯の色が暗ければ true（文字を白にする） */
function darkBand(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || "")) return false;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 140;
}

export function createTimeline(svg, { eras, periods, events, scale, onChange }) {
  const { toTrack, toValue, format, ticks, min, max } = scale;
  const key = (ev) => ev.age ?? ev.year;
  const H = { era: 14, period: 24, gap: 4, events: 22, ticks: 14 };
  const PAD = 10;
  let width = 600;
  let age = max;
  let dragging = false;

  const gEra = el("g");
  const gPeriod = el("g");
  const gEvents = el("g");
  const gTicks = el("g");
  const gHandle = el("g", { class: "handle", tabindex: "0", role: "slider", "aria-label": "年代", "aria-valuemin": String(min), "aria-valuemax": String(max), "aria-orientation": "horizontal" });
  const handleLine = el("line", { class: "handle-line" });
  const handleKnob = el("circle", { class: "handle-knob", r: 9 });
  gHandle.append(handleLine, handleKnob);
  svg.append(gEra, gPeriod, gEvents, gTicks, gHandle);

  const x = (a) => PAD + toTrack(a) * (width - 2 * PAD);
  const toAge = (px) => Math.round(toValue((px - PAD) / (width - 2 * PAD)) * 10) / 10;

  function layout() {
    width = svg.getBoundingClientRect().width || svg.clientWidth || 600;
    const yEra = 0;
    const yPeriod = H.era + 2;
    const yEvents = yPeriod + H.period + H.gap;
    const yTicks = yEvents + H.events;
    gEra.replaceChildren();
    gPeriod.replaceChildren();
    gEvents.replaceChildren();
    gTicks.replaceChildren();
    for (const e of eras) {
      const x0 = x(e.start);
      const x1 = x(e.end);
      if (x1 - x0 < 28) continue;
      gEra.append(el("text", { class: "era-label", x: (x0 + x1) / 2, y: yEra + 10, "text-anchor": "middle" }, e.name));
    }
    for (const p of periods) {
      const x0 = x(p.start);
      const x1 = x(p.end);
      gPeriod.append(el("rect", { class: "period", x: x0, y: yPeriod, width: Math.max(1, x1 - x0), height: H.period, fill: p.color, rx: 2 }));
      const w = x1 - x0;
      const label = w >= p.name.length * 11 + 8 ? p.name : w >= 26 ? p.name.slice(0, 1) : "";
      if (label) gPeriod.append(el("text", { class: "period-label", x: (x0 + x1) / 2, y: yPeriod + 16, "text-anchor": "middle", fill: darkBand(p.color) ? "#f4efe5" : "#1f1b18" }, label));
    }
    for (const ev of events) {
      const xe = x(key(ev));
      const g = el("g", { class: "ev", "data-age": key(ev) });
      g.append(el("path", { d: `M${xe},${yEvents + 2} l4,7 h-8 z` }));
      g.append(el("title", {}, `${format(key(ev))}: ${ev.title}`));
      gEvents.append(g);
    }
    // 目盛りは右から置き、重なるものは省く
    let lastX = Infinity;
    for (const t of [...ticks].sort((a, b) => toTrack(b.value) - toTrack(a.value))) {
      const xt = x(t.value);
      gTicks.append(el("line", { x1: xt, x2: xt, y1: yTicks, y2: yTicks + 3, stroke: "currentColor", opacity: ".4" }));
      if (lastX - xt < 40) continue;
      lastX = xt;
      const tr = toTrack(t.value);
      const anchor = tr <= 0.001 ? "start" : tr >= 0.999 ? "end" : "middle";
      gTicks.append(el("text", { class: "tick", x: xt, y: yTicks + 13, "text-anchor": anchor }, t.label));
    }
    svg.setAttribute("viewBox", `0 0 ${width} ${yTicks + 16}`);
    handleLine.setAttribute("y1", yPeriod - 3);
    handleLine.setAttribute("y2", yTicks + 2);
    handleKnob.setAttribute("cy", yPeriod + H.period / 2);
    render();
  }

  function render() {
    const xa = x(age);
    handleLine.setAttribute("x1", xa);
    handleLine.setAttribute("x2", xa);
    handleKnob.setAttribute("cx", xa);
    gHandle.setAttribute("aria-valuenow", String(Math.round(age)));
    gHandle.setAttribute("aria-valuetext", format(age));
    for (const g of gEvents.children) {
      const a = Number(g.dataset.age);
      g.classList.toggle("near", Math.abs(toTrack(a) - toTrack(age)) <= 0.012);
    }
  }

  function set(a, { silent = false } = {}) {
    age = Math.max(min, Math.min(max, a));
    render();
    if (!silent) onChange(age);
  }

  function pointerAge(ev) {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * width;
    return toAge(px);
  }

  svg.addEventListener("pointerdown", (ev) => {
    dragging = true;
    svg.setPointerCapture(ev.pointerId);
    set(pointerAge(ev));
    gHandle.focus({ preventScroll: true });
    ev.preventDefault();
  });
  svg.addEventListener("pointermove", (ev) => {
    if (dragging) set(pointerAge(ev));
  });
  const stop = () => { dragging = false; };
  svg.addEventListener("pointerup", stop);
  svg.addEventListener("pointercancel", stop);
  gHandle.addEventListener("keydown", (ev) => {
    // 左が古い側。scale.step は「→ で進む量」（年代なら -1 Ma、西暦なら +1 年）
    const step = (scale.step ?? 1) * (ev.shiftKey ? 10 : 1);
    const map = { ArrowLeft: -step, ArrowRight: step, ArrowUp: step, ArrowDown: -step, PageUp: -step * 50, PageDown: step * 50, Home: (toValue(0)) - age, End: (toValue(1)) - age };
    if (!(ev.key in map)) return;
    ev.preventDefault();
    set(age + map[ev.key]);
  });
  gEvents.addEventListener("click", (ev) => {
    const g = ev.target.closest(".ev");
    if (g) set(Number(g.dataset.age));
  });

  const ro = new ResizeObserver(layout);
  ro.observe(svg);
  layout();
  return { set, get age() { return age; }, layout };
}
