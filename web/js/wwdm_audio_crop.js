/**
 * WWDMAudioCrop —— 音频可视化裁剪节点前端（v8.1）
 *
 * v8.1 优化（用户反馈）：
 *   1. 输出只保留裁剪后的 audio 音频（去掉 start/end/duration/preview 输出）
 *   2. 修复结束手柄无法拖动：手柄命中判定改为纯像素距离（不依赖选区时间
 *      区间 isSel），避免结束手柄在音频末尾时鼠标落点在手柄右侧导致
 *      判定失败落入画布平移；拖动改为偏移量方式精确跟随指针
 *
 * v8 优化（用户需求）：
 *   1. 去掉节点上半部分的 start_time/end_time/duration 原生参数 widget
 *      （前端隐藏，视觉上消失）；保留波形下方的「开始时间/结束时间/选取时长」
 *      输入框 + audio_file 上传功能。隐藏 widget 仍序列化，执行时正常传参。
 *   2. 「🔄 同步」按钮功能改为：从输入的 audio 加载波形（优先节点内上传的
 *      audio_file，其次上游 LoadAudio 节点），同时同步开始时间、结束时间、
 *      选取时长和波形手柄位置。
 *
 * 架构（沿用 v4-v7）：
 *   上传 → /upload/image → 文件名存 hidden widget audio_file → 前端解码画波形 → <audio> 播放
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { $el } from "../../../scripts/ui.js";

const NODE_TYPE = "WWDMAudioCrop";

// 插件版本号（每次更新递增；显示在波形画布左上角，便于确认是否最新版）
const WWDM_VERSION = "v8.1.0";

function normalizeUrl(url) {
  if (!url) return url;
  if (/^https?:\/\//.test(url)) return url;
  return api.apiURL(url.replace(/^\/+/, ""));
}

// ---------- 时间格式工具（hh:mm:ss + 一位小数秒）----------
/** 解析 "hh:mm:ss.s" / "mm:ss.s" / "ss.s" / 纯数字秒 → 秒数；解析失败返回 null */
function parseTime(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s); // 纯秒
  const m = s.match(/^(\d{1,3}):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/); // hh:mm:ss(.s)
  if (m) {
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10), ss = parseInt(m[3], 10);
    if (mm >= 60 || ss >= 60) return null;
    const frac = m[4] ? parseFloat("0." + m[4]) : 0;
    return hh * 3600 + mm * 60 + ss + frac;
  }
  const m2 = s.match(/^(\d{1,3}):(\d{1,2})(?:\.(\d+))?$/); // mm:ss(.s)
  if (m2) {
    const mm = parseInt(m2[1], 10), ss = parseInt(m2[2], 10);
    if (ss >= 60) return null;
    const frac = m2[3] ? parseFloat("0." + m2[3]) : 0;
    return mm * 60 + ss + frac;
  }
  const f = parseFloat(s);
  return isFinite(f) && f >= 0 ? f : null;
}
/** 秒 → "hh:mm:ss.s"（秒始终保留 1 位小数） */
function fmtHMS(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t - h * 3600) / 60);
  const s = t - h * 3600 - m * 60;
  const pad = (n) => String(n).padStart(2, "0");
  const ss = s.toFixed(1);
  const [ssi, ssf] = ss.split(".");
  return `${pad(h)}:${pad(m)}:${pad(ssi)}.${ssf}`;
}
/** 秒 → 保留 1 位小数的数字字符串（duration/选取时长用） */
function fmtSec1(t) {
  if (!isFinite(t) || t < 0) t = 0;
  return t.toFixed(1);
}

function makeFileUrl(name) {
  if (!name) return "";
  const parts = String(name).replaceAll("\\", "/").split("/").filter(Boolean);
  const filename = parts.pop() || "";
  const params = new URLSearchParams({ filename, type: "input", subfolder: parts.join("/") });
  const path = "/view?" + params.toString();
  return typeof api.apiURL === "function" ? api.apiURL(path) : path;
}

// =====================================================================
// WaveCanvas —— 波形画布（双手柄 + 缩放平移）
// =====================================================================
class WaveCanvas {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.opts = opts;

    this.peaks = null;
    this.sampleRate = 44100;
    this.duration = 0;

    this.viewStart = 0;
    this.viewEnd = 0;
    this.selStart = 0;
    this.selEnd = 0;

    this.dragging = null; // 'left' | 'right' | 'sel' | 'view'
    this.dragStartX = 0;
    this.dragStartView = 0;
    this.dragStartSel = null;
    this.pointerId = null;

    this.audio = null;
    this.playing = false;
    this.playRaf = null;
    this.audioUrl = null;

    this._bound = {
      move: (e) => this._onMove(e),
      up: (e) => this._onUp(e),
      cancel: (e) => this._onUp(e),
    };
    this._bind();
  }

  // ---------------------------------------------------------- 数据
  setData(peaks, sampleRate, duration) {
    this.peaks = Float32Array.from(peaks || []);
    this.sampleRate = sampleRate || 44100;
    this.duration = duration || (this.peaks.length ? this.peaks.length : 0);
    if (this.duration > 0 && this.viewEnd <= this.viewStart) {
      this.viewStart = 0;
      this.viewEnd = this.duration;
      if (this.selEnd <= this.selStart) this.selEnd = this.duration;
    }
    this.render();
    if (this.opts.onSelection) this.opts.onSelection();
  }
  get hasData() {
    return !!this.peaks && this.peaks.length > 0 && this.duration > 0;
  }

  // ---------------------------------------------------------- 选区
  setSelection(s, e, silent) {
    const dur = this.duration || 1;
    this.selStart = Math.max(0, Math.min(s, dur));
    this.selEnd = Math.max(this.selStart, Math.min(e, dur));
    this.render();
    if (!silent && this.opts.onSelection) this.opts.onSelection();
  }
  get selection() {
    return { start: this.selStart, end: this.selEnd };
  }
  setDuration(d, silent) {
    const dur = this.duration || 1;
    const end = Math.min(this.selStart + Math.max(0, d), dur);
    this.setSelection(this.selStart, end, silent);
  }

  // ---------------------------------------------------------- 视图
  fitAll() {
    this.viewStart = 0;
    this.viewEnd = this.duration || 1;
    this.render();
  }
  fitSelection() {
    if (!this.hasData) return;
    let pad = (this.selEnd - this.selStart) * 0.15;
    if (pad <= 0) pad = this.duration * 0.05 || 1;
    this.viewStart = Math.max(0, this.selStart - pad);
    this.viewEnd = Math.min(this.duration, this.selEnd + pad);
    this.render();
  }
  _xToTime(x) {
    const w = this.canvas.clientWidth || this.canvas.width;
    if (w <= 0) return 0;
    return this.viewStart + (x / w) * (this.viewEnd - this.viewStart);
  }
  _timeToX(t) {
    const w = this.canvas.clientWidth || this.canvas.width;
    if (w <= 0) return 0;
    return ((t - this.viewStart) / Math.max(1e-6, this.viewEnd - this.viewStart)) * w;
  }
  zoomBy(factor, centerX) {
    if (!this.hasData) return;
    const w = this.canvas.clientWidth || this.canvas.width;
    const c = this._xToTime(centerX || w / 2);
    let span = (this.viewEnd - this.viewStart) / factor;
    span = Math.max(0.05, Math.min(span, this.duration || 1));
    this.viewStart = Math.max(0, c - span / 2);
    this.viewEnd = Math.min(this.duration, c + span / 2);
    if (this.viewEnd - this.viewStart < span * 0.99) {
      this.viewStart = Math.max(0, this.viewEnd - span);
    }
    this.render();
  }
  panBy(dxPx) {
    if (!this.hasData) return;
    const w = this.canvas.clientWidth || this.canvas.width;
    const dt = (-dxPx / w) * (this.viewEnd - this.viewStart);
    const span = this.viewEnd - this.viewStart;
    let s = this.viewStart + dt;
    s = Math.max(0, Math.min(s, Math.max(0, this.duration - span)));
    this.viewStart = s;
    this.viewEnd = s + span;
    this.render();
  }

  // ---------------------------------------------------------- 播放
  /** 从 from 播放到 to（固定：起点=开始手柄，终点=结束手柄） */
  playRange(from, to, url) {
    if (!url || !this.hasData) return;
    this.stop();
    this.audioUrl = url;
    const audio = new Audio(url);
    this.audio = audio;
    this.audioEndTime = Math.max(from, Math.min(to, this.duration));
    this.playing = true;

    const startPlay = () => {
      try {
        audio.currentTime = Math.max(0, Math.min(from, this.duration));
      } catch (e) {}
      audio.play().catch(() => {});
      this._playLoop();
    };
    if (audio.readyState >= 1) {
      startPlay();
    } else {
      audio.addEventListener("loadedmetadata", startPlay, { once: true });
      audio.addEventListener("error", () => {
        this.stop();
        this.playing = false;
        if (this.opts.onPlayState) this.opts.onPlayState(false);
      }, { once: true });
    }
  }
  /** 播放选区：固定从开始手柄位置起播 */
  playSelection(url) {
    if (!url || !this.hasData) return;
    this.playRange(this.selStart, this.selEnd, url);
    if (this.opts.onPlayState) this.opts.onPlayState(true);
  }
  stop() {
    this.playing = false;
    if (this.playRaf) cancelAnimationFrame(this.playRaf);
    this.playRaf = null;
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.removeAttribute("src");
      } catch (e) {}
      this.audio = null;
    }
    this.render();
    if (this.opts.onPlayState) this.opts.onPlayState(false);
  }
  _playLoop() {
    if (!this.audio || !this.playing) return;
    if (this.audio.currentTime >= this.audioEndTime) {
      this.stop();
      return;
    }
    this.playRaf = requestAnimationFrame(() => this._playLoop());
  }

  // ---------------------------------------------------------- 事件（Pointer Events）
  _bind() {
    const c = this.canvas;
    const rect = () => c.getBoundingClientRect();

    c.addEventListener("pointerdown", (e) => {
      const r = rect();
      const x = e.clientX - r.left;
      const t = this._xToTime(x);
      const w = c.clientWidth || c.width;
      const edgePx = 14; // 手柄命中区（像素）
      const sx = this._timeToX(this.selStart);
      const ex = this._timeToX(this.selEnd);
      const isSel = t >= this.selStart && t <= this.selEnd;

      if (e.button === 1) {
        e.preventDefault();
        this.dragging = "view";
        this.dragStartX = e.clientX;
        this.dragStartView = this.viewStart;
        this.pointerId = e.pointerId;
        c.setPointerCapture(e.pointerId);
        c.style.cursor = "grabbing";
        return;
      }
      if (e.button !== 0) return;

      // 手柄判定：纯像素距离优先（不依赖 isSel）
      // 结束手柄在音频末尾时，鼠标落点常在右侧（t > selEnd → isSel=false），
      // 旧逻辑会落入 view 分支导致结束手柄拖不动；改为像素距离直接命中。
      // 先判 right 再判 left，避免小选区/重叠时误判为左手柄。
      if (Math.abs(x - ex) <= edgePx) {
        this.dragging = "right";
        this.dragStartSel = { s: this.selStart, e: this.selEnd };
      } else if (Math.abs(x - sx) <= edgePx) {
        this.dragging = "left";
        this.dragStartSel = { s: this.selStart, e: this.selEnd };
      } else if (isSel) {
        this.dragging = "sel";
        this.dragStartSel = { s: this.selStart, e: this.selEnd };
      } else {
        this.dragging = "view";
        this.dragStartX = e.clientX;
        this.dragStartView = this.viewStart;
      }
      this.dragStartX = e.clientX;
      this.pointerId = e.pointerId;
      c.setPointerCapture(e.pointerId);
      c.addEventListener("pointermove", this._bound.move);
      c.addEventListener("pointerup", this._bound.up);
      c.addEventListener("pointercancel", this._bound.cancel);
    });

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = rect();
      const x = e.clientX - r.left;
      const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
      this.zoomBy(factor, x);
    }, { passive: false });

    c.addEventListener("dblclick", (e) => {
      const r = rect();
      const x = e.clientX - r.left;
      const t = this._xToTime(x);
      if (t >= this.selStart && t <= this.selEnd) {
        this.fitSelection();
      } else {
        this.fitAll();
      }
    });
  }

  _onMove(e) {
    if (!this.dragging || (this.pointerId != null && e.pointerId !== this.pointerId)) return;
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    const x = e.clientX - r.left;
    const t = this._xToTime(x);
    const w = c.clientWidth || c.width;
    const dt = ((e.clientX - this.dragStartX) / Math.max(1, w)) * (this.viewEnd - this.viewStart);
    const dur = this.duration || 1;
    const minGap = 0.01;

    if (this.dragging === "left") {
      // 偏移量方式：手柄跟随指针精确移动，避免绝对 t 在边界时被钳制
      const s = this.dragStartSel.s + dt;
      this.selStart = Math.max(0, Math.min(s, this.selEnd - minGap));
    } else if (this.dragging === "right") {
      const en = this.dragStartSel.e + dt;
      this.selEnd = Math.min(dur, Math.max(en, this.selStart + minGap));
    } else if (this.dragging === "sel") {
      let s = this.dragStartSel.s + dt;
      let en = this.dragStartSel.e + dt;
      if (s < 0) { en -= s; s = 0; }
      if (en > dur) { s -= en - dur; en = dur; }
      this.selStart = s;
      this.selEnd = en;
    } else if (this.dragging === "view") {
      this.viewStart = Math.max(0, Math.min(this.dragStartView - dt, Math.max(0, dur - (this.viewEnd - this.viewStart))));
      this.viewEnd = this.viewStart + (this.viewEnd - this.viewStart);
    }
    this.render();
    if (this.opts.onSelection) this.opts.onSelection();
  }

  _onUp(e) {
    if (this.pointerId != null && e && e.pointerId !== this.pointerId) return;
    this.dragging = null;
    this.pointerId = null;
    const c = this.canvas;
    c.style.cursor = "";
    try {
      c.removeEventListener("pointermove", this._bound.move);
      c.removeEventListener("pointerup", this._bound.up);
      c.removeEventListener("pointercancel", this._bound.cancel);
    } catch (err) {}
  }

  // ---------------------------------------------------------- 渲染
  render() {
    const c = this.canvas;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 320;
    const h = c.clientHeight || 140;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = "#0e1420";
    ctx.fillRect(0, 0, w, h);

    // 版本标记
    ctx.fillStyle = "rgba(120, 160, 220, 0.55)";
    ctx.font = "9px monospace";
    ctx.textAlign = "left";
    ctx.fillText("wwdm " + WWDM_VERSION, 4, h - 5);

    if (!this.hasData) {
      ctx.fillStyle = "#55607a";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("请在上方上传音频文件", w / 2, h / 2);
      return;
    }

    const t0 = this.viewStart;
    const t1 = this.viewEnd;
    const span = Math.max(1e-6, t1 - t0);
    const n = this.peaks.length;
    const center = h / 2;
    const sx = this._timeToX(this.selStart);
    const ex = this._timeToX(this.selEnd);

    // 选区背景
    ctx.fillStyle = "rgba(70, 200, 120, 0.18)";
    ctx.fillRect(sx, 0, Math.max(0, ex - sx), h);

    // 波形
    ctx.beginPath();
    for (let px = 0; px <= w; px += 1) {
      const t = t0 + (px / w) * span;
      const idx = Math.floor((t / Math.max(1e-6, this.duration)) * n);
      const peak = this.peaks[Math.max(0, Math.min(n - 1, idx))] || 0;
      const amp = Math.pow(Math.min(1, peak * (this.opts.gain || 2.2)), 0.7);
      const y0 = center - amp * (center - 6);
      const y1 = center + amp * (center - 6);
      ctx.moveTo(px, y0);
      ctx.lineTo(px, y1);
    }
    ctx.strokeStyle = "#59d28b";
    ctx.lineWidth = 1;
    ctx.stroke();

    // 中线
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.beginPath();
    ctx.moveTo(0, center);
    ctx.lineTo(w, center);
    ctx.stroke();

    // 时间刻度
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "10px monospace";
    ctx.textAlign = "left";
    let step = 5;
    while (span / step > 240) step *= 2;
    while (span / step < 60) step /= 2;
    step = Math.max(1, Math.floor(step));
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const x = this._timeToX(t);
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillText(fmtHMS(t), x + 2, 12);
    }

    this._drawHandle(sx, "#ffd54a");
    this._drawHandle(ex, "#ff6b6b");

    if (ex - sx > 40) {
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "center";
      ctx.fillText(fmtHMS(this.selEnd - this.selStart), (sx + ex) / 2, 14);
    }
  }

  _drawHandle(x, color) {
    const ctx = this.ctx;
    const h = this.canvas.clientHeight || this.canvas.height;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, 8, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0e1420";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  destroy() {
    this.stop();
    try {
      const c = this.canvas;
      c.removeEventListener("pointermove", this._bound.move);
      c.removeEventListener("pointerup", this._bound.up);
      c.removeEventListener("pointercancel", this._bound.cancel);
    } catch (err) {}
  }
}

// =====================================================================
// 前端解码工具
// =====================================================================
async function decodeAudioBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("音频解码失败: HTTP " + response.status);
  const bytes = await response.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error("浏览器不支持 Web Audio");
  const ctx = new AC();
  try {
    return await ctx.decodeAudioData(bytes.slice(0));
  } finally {
    await ctx.close().catch(() => {});
  }
}

function bufferToPeaks(buffer, numBuckets) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const total = buffer.length;
  const peaks = new Float32Array(numBuckets);
  if (total === 0) return peaks;
  for (let b = 0; b < numBuckets; b++) {
    const start = Math.floor((b / numBuckets) * total);
    const end = Math.max(start + 1, Math.floor(((b + 1) / numBuckets) * total));
    let max = 0;
    const stride = Math.max(1, Math.floor((end - start) / 64));
    for (let s = start; s < end; s += stride) {
      for (const data of channels) {
        const v = Math.abs(data[s] || 0);
        if (v > max) max = v;
      }
    }
    peaks[b] = max;
  }
  return peaks;
}

// =====================================================================
// 节点注册
// =====================================================================
app.registerExtension({
  name: "wwdm.AudioCrop",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);

      // ---------- 上传区 ----------
      const uploadZone = $el("div", {
        style: {
          width: "100%",
          border: "1px dashed #2c5368",
          borderRadius: "6px",
          background: "#101b26",
          color: "#08b4ed",
          fontSize: "12px",
          textAlign: "center",
          padding: "10px 8px",
          cursor: "pointer",
          boxSizing: "border-box",
          transition: "border-color .12s, background .12s",
        },
        textContent: "📂 点击或拖拽上传音频",
      });
      uploadZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = "#0aa4d6";
        uploadZone.style.background = "#142633";
      });
      uploadZone.addEventListener("dragleave", () => {
        uploadZone.style.borderColor = "#2c5368";
        uploadZone.style.background = "#101b26";
      });
      uploadZone.addEventListener("drop", (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = "#2c5368";
        uploadZone.style.background = "#101b26";
        const file = e.dataTransfer?.files?.[0];
        if (file) this._wwdmUpload(file);
      });
      uploadZone.addEventListener("click", () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.mp4";
        inp.onchange = () => {
          if (inp.files?.[0]) this._wwdmUpload(inp.files[0]);
        };
        inp.click();
      });
      this.wwdmUploadZone = uploadZone;

      // ---------- 已上传音频下拉框（可复用） ----------
      this.wwdmFileSelect = $el("select", {
        style: {
          width: "100%",
          background: "#0f1622",
          color: "#dde",
          border: "1px solid #2c3a4d",
          borderRadius: "4px",
          padding: "5px 7px",
          fontSize: "12px",
          boxSizing: "border-box",
          marginTop: "6px",
          display: "none",
        },
      });
      this.wwdmFileSelect.addEventListener("change", () => {
        const name = this.wwdmFileSelect.value;
        if (!name) return;
        this._wwdmLoadFile(name);
      });
      const fileRow = $el("div", { style: { display: "flex", gap: "6px", marginTop: "0" } });
      fileRow.append(this.wwdmFileSelect);
      this.wwdmFileName = $el("div", {
        style: {
          fontSize: "11px",
          color: "#7f94a3",
          marginTop: "4px",
          textAlign: "center",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        },
      });

      // ---------- 波形画布 ----------
      this.wwdmCanvas = $el("canvas", {
        style: {
          width: "100%",
          height: "150px",
          display: "block",
          borderRadius: "4px",
          background: "#0e1420",
          cursor: "crosshair",
          marginTop: "6px",
          touchAction: "none",
        },
      });
      this.wwdmWc = new WaveCanvas(this.wwdmCanvas, {
        gain: 2.2,
        onSelection: () => this._wwdmSyncWidgets(),
        onPlayState: (playing) => {
          this.wwdmBtnPlay.textContent = playing ? "⏹ 停止" : "▶ 播放";
        },
      });

      // ---------- 时间输入行（hh:mm:ss） ----------
      const mkInput = (label, ref, ph) => {
        const inp = $el("input", {
          type: "text",
          placeholder: ph || "hh:mm:ss",
          spellcheck: "false",
          style: {
            width: "100%",
            background: "#0f1622",
            color: "#dde",
            border: "1px solid #2c3a4d",
            borderRadius: "4px",
            padding: "5px 7px",
            fontSize: "12px",
            boxSizing: "border-box",
            fontFamily: "monospace",
          },
        });
        const lab = $el("label", {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "3px",
            fontSize: "11px",
            color: "#8fa0b8",
            flex: 1,
          },
        });
        lab.append(document.createTextNode(label), inp);
        this[ref] = inp;
        return lab;
      };
      const inputRow = $el("div", { style: { display: "flex", gap: "8px", marginTop: "6px" } });
      inputRow.append(
        mkInput("开始时间", "wwdmInpStart", "hh:mm:ss"),
        mkInput("结束时间", "wwdmInpEnd", "hh:mm:ss"),
        mkInput("选取时长(秒)", "wwdmInpDur", "10.0")
      );

      // ---------- 按钮行（播放 + 同步） ----------
      const btnStyle = (bg) => ({
        background: bg,
        color: "#fff",
        border: "none",
        borderRadius: "5px",
        padding: "7px 16px",
        fontSize: "12px",
        cursor: "pointer",
        fontWeight: 600,
      });
      this.wwdmBtnPlay = $el("button", { textContent: "▶ 播放", style: btnStyle("#2e7d54") });
      this.wwdmBtnPlay.style.flex = "1";
      this.wwdmBtnSync = $el("button", { textContent: "🔄 同步", style: btnStyle("#3d5a80") });
      const hint = $el("div", {
        style: { fontSize: "10px", color: "#5c6a82", flex: "2", lineHeight: "16px", textAlign: "right" },
        textContent: "滚轮缩放 · 空白拖动平移 · 双击适配",
      });
      const btnRow = $el("div", { style: { display: "flex", gap: "8px", marginTop: "6px", alignItems: "center" } });
      btnRow.append(this.wwdmBtnPlay, this.wwdmBtnSync, hint);

      const wrap = $el("div", { style: { width: "100%", padding: "2px 0" } });
      wrap.append(uploadZone, fileRow, this.wwdmFileName, this.wwdmCanvas, inputRow, btnRow);
      this.wwdmUiEl = wrap;

      if (this.addDOMWidget) {
        this.wwdmWidget = this.addDOMWidget("wwdm_ui", "wwdm_ui", wrap, { serialize: false });
        this.wwdmWidget.computeSize = function (width) {
          return [width || 320, 310];
        };
      } else {
        const container = this.el || this.nodeEl || this.constructor?.nodeEl;
        if (container) container.appendChild(wrap);
      }

      // 节点高度覆盖（确保上传区/画布/输入行/播放/同步按钮全部可见；
      // 原生 start/end/duration widget 已隐藏，高度相应缩减）
      const origComputeSize = this.computeSize?.bind(this);
      this.computeSize = function (w) {
        const base = origComputeSize ? origComputeSize(w) : [360, 400];
        const needed = 376; // 上传区(38)+下拉(30)+文件名(20)+画布(150)+输入行(52)+按钮行(36)+边距(~50)
        return [base[0], Math.max(base[1], needed)];
      };

      // ---------- 隐藏原生 start_time/end_time/duration + audio_file 参数（v8） ----------
      // 需求：去掉节点上半部分的三个参数，只保留波形下方的输入框。
      // 用 computeSize 折叠 widget，使其在面板上不渲染；但 widget 仍留在
      // this.widgets 中，值会被序列化并随执行传给后端 crop()，保证功能不变。
      // audio_file 是上传路径的存储载体，同样隐藏（上传/选择走按钮+下拉框）。
      for (const nm of ["start_time", "end_time", "duration", "audio_file"]) {
        const w = this.widgets?.find((x) => x.name === nm);
        if (w) {
          w.hidden = true;
          w.computeSize = () => [0, -4];
        }
      }

      // ---------- 输入框事件（hh:mm:ss / 秒） ----------
      this._wwdmGuard = false;
      this._wwdmReadInputs = () => {
        const sv = parseTime(this.wwdmInpStart.value);
        const ev = parseTime(this.wwdmInpEnd.value);
        const dv = parseTime(this.wwdmInpDur.value);
        return { sv, ev, dv };
      };
      // 手动输入修改：change/Enter 时应用（同步按钮为强制统一入口）
      this.wwdmInpStart.addEventListener("change", () => this._wwdmApplyInputs("start"));
      this.wwdmInpEnd.addEventListener("change", () => this._wwdmApplyInputs("end"));
      this.wwdmInpDur.addEventListener("change", () => this._wwdmApplyInputs("dur"));
      for (const inp of [this.wwdmInpStart, this.wwdmInpEnd, this.wwdmInpDur]) {
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            const which = inp === this.wwdmInpStart ? "start" : inp === this.wwdmInpEnd ? "end" : "dur";
            this._wwdmApplyInputs(which);
          }
        });
      }

      // ---------- 同步按钮（v8：从输入 audio 加载波形 + 同步全部） ----------
      this.wwdmBtnSync.addEventListener("click", () => this._wwdmSyncAll());

      // ---------- 播放按钮 ----------
      this.wwdmBtnPlay.addEventListener("click", () => {
        const url = this.wwdmAudioUrl || (this._wwdmCurrentName ? makeFileUrl(this._wwdmCurrentName) : "");
        if (!url) {
          alert("请先上传或选择音频文件");
          return;
        }
        if (!this.wwdmWc.hasData) {
          alert("波形尚未加载，请稍候或重新选择");
          return;
        }
        if (this.wwdmWc.playing) {
          this.wwdmWc.stop();
        } else {
          this.wwdmWc.playSelection(url);
        }
      });

      // ---------- 上传处理 ----------
      this._wwdmUpload = async (file) => {
        if (!file) return;
        this.wwdmUploadZone.textContent = "⏳ 上传中…";
        try {
          const body = new FormData();
          body.append("image", file, file.name);
          body.append("type", "input");
          const response = await api.fetchApi("/upload/image", { method: "POST", body });
          if (!response.ok) throw new Error("上传失败: HTTP " + response.status);
          const result = await response.json();
          const name = [result.subfolder, result.name].filter(Boolean).join("/");
          await this._wwdmLoadFile(name);
          this.wwdmUploadZone.textContent = "📂 点击或拖拽重新上传";
        } catch (err) {
          console.error("[wwdm] 上传失败", err);
          this.wwdmUploadZone.textContent = "❌ 上传失败，点击重试";
          this.wwdmFileName.textContent = String(err.message || err);
        }
      };

      /** 加载已上传/已选择的音频文件（写入 widget + 解码画波形） */
      this._wwdmLoadFile = async (name) => {
        if (!name) return;
        this._wwdmCurrentName = name;
        const wf = this.widgets?.find((x) => x.name === "audio_file");
        if (wf) wf.value = name;
        this.wwdmFileName.textContent = "已加载: " + name;
        this.wwdmAudioUrl = makeFileUrl(name);
        const sel = this.wwdmFileSelect;
        if (sel && ![...sel.options].some((o) => o.value === name)) {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          sel.appendChild(opt);
        }
        if (sel) sel.value = name;
        try {
          this.wwdmCanvas.style.opacity = "0.45";
          const buffer = await decodeAudioBuffer(makeFileUrl(name));
          const peaks = bufferToPeaks(buffer, 1200);
          const duration = buffer.duration || (buffer.length / (buffer.sampleRate || 44100));
          this.wwdmWc.setData(peaks, buffer.sampleRate || 44100, duration);
          this.wwdmWc.setSelection(0, duration);
          this.wwdmCanvas.style.opacity = "1";
          this._wwdmSyncWidgets();
        } catch (err) {
          console.error("[wwdm] 波形解码失败", err);
          this.wwdmCanvas.style.opacity = "1";
          this.wwdmFileName.textContent = "❌ 波形解码失败: " + String(err.message || err);
        }
      };

      // ---------- 刷新已上传文件列表 ----------
      this._wwdmRefreshFiles = async () => {
        try {
          const res = await api.fetchApi("/wwdm/audio/files");
          if (!res.ok) return;
          const data = await res.json();
          const files = data.files || [];
          const sel = this.wwdmFileSelect;
          const cur = this._wwdmCurrentName;
          sel.innerHTML = "";
          if (!files.length) {
            sel.style.display = "none";
            return;
          }
          sel.style.display = "block";
          const ph = document.createElement("option");
          ph.value = "";
          ph.textContent = "已上传音频…";
          sel.appendChild(ph);
          for (const f of files) {
            const opt = document.createElement("option");
            opt.value = f;
            opt.textContent = f;
            sel.appendChild(opt);
          }
          if (cur && files.includes(cur)) {
            sel.value = cur;
          }
        } catch (err) {
          console.error("[wwdm] 刷新文件列表失败", err);
        }
      };

      // ---------- 初始化：恢复已保存文件 + 拉取文件列表 ----------
      const wf = this.widgets?.find((x) => x.name === "audio_file");
      if (wf?.value) {
        const name = String(wf.value);
        this._wwdmLoadFile(name);
      }
      this._wwdmRefreshFiles();

      return r;
    };

    // ---------- 应用输入框修改（单字段同步） ----------
    nodeType.prototype._wwdmApplyInputs = function (which) {
      if (!this.wwdmWc?.hasData) return;
      const { sv, ev, dv } = this._wwdmReadInputs();
      const dur = this.wwdmWc.duration;
      const sel = this.wwdmWc.selection;
      let s = sel.start, e = sel.end;

      if (which === "start") {
        if (sv == null) { this._wwdmSyncWidgets(); return; }
        s = Math.min(Math.max(0, sv), dur);
        if (e <= s + 0.01) e = Math.min(dur, s + 0.01);
      } else if (which === "end") {
        if (ev == null) { this._wwdmSyncWidgets(); return; }
        e = Math.min(Math.max(s + 0.01, ev), dur);
      } else if (which === "dur") {
        if (dv != null && dv > 0) {
          e = Math.min(dur, s + dv);
        }
      }
      this.wwdmWc.setSelection(s, e);
      this._wwdmSyncWidgets();
    };

    // ---------- 解析音频源（优先节点内上传 audio_file，其次上游 LoadAudio） ----------
    nodeType.prototype._wwdmResolveSource = function () {
      // 1) 节点内上传的 audio_file
      const wf = this.widgets?.find((x) => x.name === "audio_file");
      if (wf?.value && String(wf.value).trim()) return String(wf.value).trim();
      // 2) 上游 LoadAudio 节点的音频文件名
      const inp = this.inputs?.find((x) => x.name === "audio");
      if (inp?.link != null && app?.graph) {
        const link = app.graph.links.find((l) => l.id === inp.link);
        const src = link ? app.graph.getNodeById(link.origin_id) : null;
        if (src) {
          // LoadAudio 的 audio 参数
          const aw = src.widgets?.find((x) => x.name === "audio");
          if (aw?.value && String(aw.value).trim()) return String(aw.value).trim();
          // 兼容：第一个 widget 恰好是文件名的场景
          const w0 = src.widgets?.[0];
          if (w0?.value && typeof w0.value === "string" && String(w0.value).trim()) {
            return String(w0.value).trim();
          }
        }
      }
      return null;
    };

    // ---------- 一键同步（v8：从输入 audio 加载波形 + 同步时间与手柄） ----------
    nodeType.prototype._wwdmSyncAll = async function () {
      if (!this.wwdmWc) return;
      // 1) 解析音频源并加载波形
      const name = this._wwdmResolveSource();
      if (!name) {
        alert("未找到音频：请在节点内上传音频，或连接 LoadAudio 的 AUDIO 输入");
        return;
      }
      const url = makeFileUrl(name);
      try {
        const buffer = await decodeAudioBuffer(url);
        const peaks = bufferToPeaks(buffer, 1200);
        const duration = buffer.duration || (buffer.length / (buffer.sampleRate || 44100));
        this.wwdmWc.setData(peaks, buffer.sampleRate || 44100, duration);
        // 记录来源（若与当前不同，同步 UI 展示）
        if (this._wwdmCurrentName !== name) {
          this._wwdmCurrentName = name;
          const wf = this.widgets?.find((x) => x.name === "audio_file");
          if (wf) wf.value = name;
          this.wwdmFileName.textContent = "已加载: " + name;
          this.wwdmAudioUrl = url;
          const sel = this.wwdmFileSelect;
          if (sel && ![...sel.options].some((o) => o.value === name)) {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            sel.appendChild(opt);
          }
          if (sel) sel.value = name;
        }
      } catch (err) {
        console.error("[wwdm] 同步加载波形失败", err);
        alert("波形加载失败: " + String(err.message || err));
        return;
      }
      // 2) 按输入行时间参数同步手柄：开始时间 / 选取时长(优先) / 结束时间
      const { sv, ev, dv } = this._wwdmReadInputs();
      const dur = this.wwdmWc.duration;
      let s = 0, e = dur;
      if (sv != null && sv >= 0) s = Math.min(sv, dur);
      if (dv != null && dv > 0) {
        e = Math.min(dur, s + dv);
      } else if (ev != null && ev > 0) {
        e = Math.min(dur, Math.max(ev, s + 0.01));
      }
      if (e <= s + 0.01) e = Math.min(dur, s + 0.01);
      this.wwdmWc.setSelection(s, e);
      this._wwdmSyncWidgets();
    };

    // ---------- 选区 → 节点参数 + 输入框 同步 ----------
    nodeType.prototype._wwdmSyncWidgets = function () {
      if (this._wwdmGuard) return;
      this._wwdmGuard = true;
      try {
        const { start, end } = this.wwdmWc.selection;
        const dur = end - start;
        const w = (name) => this.widgets?.find((x) => x.name === name);
        const ws = w("start_time"), we = w("end_time"), wd = w("duration");
        if (ws) ws.value = fmtHMS(start);
        if (we) we.value = fmtHMS(end);
        if (wd) wd.value = fmtSec1(dur);
        if (this.wwdmInpStart) this.wwdmInpStart.value = fmtHMS(start);
        if (this.wwdmInpEnd) this.wwdmInpEnd.value = fmtHMS(end);
        if (this.wwdmInpDur) this.wwdmInpDur.value = fmtSec1(dur);
      } finally {
        this._wwdmGuard = false;
      }
    };

    // ---------- 节点参数变化 → 波形 ----------
    const onWidgetChanged = nodeType.prototype.onWidgetChanged;
    nodeType.prototype.onWidgetChanged = function (widget, value) {
      const r = onWidgetChanged?.apply(this, arguments);
      if (this._wwdmGuard || !this.wwdmWc?.hasData) return r;
      if (widget?.name === "start_time") {
        const v = parseTime(value);
        if (v != null) {
          const e = Math.max(v + 0.01, this.wwdmWc.selEnd);
          this.wwdmWc.setSelection(v, e);
        }
      } else if (widget?.name === "end_time") {
        const v = parseTime(value);
        if (v != null) {
          const s = Math.min(v - 0.01, this.wwdmWc.selStart);
          this.wwdmWc.setSelection(s, v);
        }
      } else if (widget?.name === "duration") {
        const v = parseTime(value);
        if (v != null) this.wwdmWc.setDuration(v);
      }
      return r;
    };

    // ---------- 执行结果 ----------
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted?.apply(this, arguments);
      // 后端 executed 消息的 ui 字段值都是数组（get_output_from_returns 合并逻辑），
      // 需取 [0]；也兼容直接对象
      const pick = (v) => (Array.isArray(v) ? v[0] : v);
      const wf = pick(message?.wwdm_waveform);
      const audioUrl = pick(message?.wwdm_audio_url);
      if (wf && Array.isArray(wf.peaks) && wf.peaks.length) {
        // 保留用户已设置的时间参数：执行后手柄反映 start/end/duration 值
        const w = (name) => this.widgets?.find((x) => x.name === name);
        const sv = parseTime(w("start_time")?.value);
        const ev = parseTime(w("end_time")?.value);
        const dv = parseTime(w("duration")?.value);
        this.wwdmWc.setData(wf.peaks, wf.sample_rate, wf.duration);
        let s = 0, e = this.wwdmWc.duration;
        if (sv != null && sv >= 0) s = Math.min(sv, e);
        if (dv != null && dv > 0) e = Math.min(e, s + dv);
        else if (ev != null && ev > 0) e = Math.min(e, Math.max(ev, s + 0.01));
        this.wwdmWc.setSelection(s, e);
        if (audioUrl) this.wwdmAudioUrl = audioUrl;
        this._wwdmSyncWidgets();
      }
      return r;
    };

    // ---------- 序列化保留波形 ----------
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      const pick = (v) => (Array.isArray(v) ? v[0] : v);
      const wf = pick(info?.wwdm_waveform);
      if (wf && Array.isArray(wf.peaks) && wf.peaks.length) {
        this.wwdmWc.setData(wf.peaks, wf.sample_rate, wf.duration);
      }
      return r;
    };
  },
});

// 全局样式
app.registerExtension({
  name: "wwdm.AudioCrop.style",
  setup() {
    const style = document.createElement("style");
    style.textContent = `
      .wwdm-widget button:hover { filter: brightness(1.15); }
      .wwdm-widget input:focus { outline: 1px solid #2f6fb3; }
      .wwdm-widget select:focus { outline: 1px solid #2f6fb3; }
    `;
    document.head.appendChild(style);
  },
});
