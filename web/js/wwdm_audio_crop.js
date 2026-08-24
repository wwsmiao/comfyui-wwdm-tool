/**
 * WWDMAudioCrop —— 音频可视化裁剪节点前端（v2）
 *
 * 功能：
 *   1. 节点面板：即时波形显示（绿色）+ 播放按钮 + 裁剪按钮
 *   2. 裁剪弹窗「音频截取」：
 *      - 全波形 + 每 5 秒时间刻度
 *      - 开始时间 / 结束时间 / 选取时长 三行输入
 *      - 播放按钮
 *      - 滚轮缩放 / 中键拖动平移 / 点击选区播放·停止 / 选区左键拖动平移
 *      - 底部右侧：取消 / 保存
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { $el } from "../../../scripts/ui.js";

const NODE_TYPE = "WWDMAudioCrop";

// 播放/URL 工具
function makeAudio(url) {
  return new Audio(url);
}
function normalizeUrl(url) {
  if (!url) return url;
  if (/^https?:\/\//.test(url)) return url;
  return api.apiURL(url.replace(/^\/+/, ""));
}
function fmtTime(t) {
  if (!isFinite(t) || t < 0) return "0.00";
  return t.toFixed(2);
}

class WaveCanvas {
  /**
   * 波形画布组件：峰值数据 + 选区 + 交互（缩放/平移/拖动/点击）
   * @param {HTMLCanvasElement} canvas
   * @param {Object} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.opts = opts;

    this.peaks = null; // Float32Array 峰值
    this.sampleRate = 44100;
    this.duration = 0;

    // 视图状态
    this.viewStart = 0; // 可视区起始秒
    this.viewEnd = 0; // 可视区结束秒
    this.zoom = 1;

    // 选区（秒）
    this.selStart = 0;
    this.selEnd = 0;

    // 交互状态
    this.dragging = null; // 'view' | 'left' | 'right' | 'sel'
    this.dragStartX = 0;
    this.dragStartView = 0;
    this.dragStartSel = null;
    this.panning = false; // 中键平移
    this.panLastX = 0;

    // 播放状态
    this.audio = null;
    this.playing = false;
    this.playRaf = null;

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
    if (this.opts.onData) this.opts.onData();
  }
  get hasData() {
    return !!this.peaks && this.peaks.length > 0;
  }

  // ---------------------------------------------------------- 选区
  setSelection(s, e) {
    this.selStart = Math.max(0, Math.min(s, this.duration));
    this.selEnd = Math.max(this.selStart, Math.min(e, this.duration));
    this.render();
  }
  get selection() {
    return { start: this.selStart, end: this.selEnd };
  }

  // ---------------------------------------------------------- 视图
  _fitToSelection() {
    if (!this.hasData) return;
    let pad = (this.selEnd - this.selStart) * 0.15;
    if (pad <= 0) pad = this.duration * 0.05 || 1;
    this.viewStart = Math.max(0, this.selStart - pad);
    this.viewEnd = Math.min(this.duration, this.selEnd + pad);
    this.zoom = this.duration / Math.max(1e-6, this.viewEnd - this.viewStart);
  }
  _xToTime(x) {
    const w = this.canvas.clientWidth || this.canvas.width;
    return this.viewStart + (x / w) * (this.viewEnd - this.viewStart);
  }
  _timeToX(t) {
    const w = this.canvas.clientWidth || this.canvas.width;
    return ((t - this.viewStart) / (this.viewEnd - this.viewStart)) * w;
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
    this.zoom = this.duration / Math.max(1e-6, this.viewEnd - this.viewStart);
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
  play(range, url) {
    if (!url) return;
    this.stop();
    this.audio = new Audio(url);
    this.audio.currentTime = range.start;
    this.playing = true;
    this.audio.play().catch(() => {});
    this._playLoop();
  }
  playSelection(url) {
    if (!url || !this.hasData) return;
    this.play({ start: this.selStart, end: this.selEnd }, url);
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
  }
  _playLoop() {
    if (!this.audio || !this.playing) return;
    this.render();
    this.playRaf = requestAnimationFrame(() => this._playLoop());
  }

  // ---------------------------------------------------------- 事件
  _bind() {
    const c = this.canvas;
    const rect = () => c.getBoundingClientRect();

    c.addEventListener("mousedown", (e) => {
      const r = rect();
      const x = e.clientX - r.left;
      const t = this._xToTime(x);
      const isSel = t >= this.selStart && t <= this.selEnd;
      const isSelEdge = isSel && (Math.abs(t - this.selStart) < (this.viewEnd - this.viewStart) * 0.02 || Math.abs(t - this.selEnd) < (this.viewEnd - this.viewStart) * 0.02);

      if (e.button === 1) {
        // 中键：平移视图
        e.preventDefault();
        this.panning = true;
        this.panLastX = e.clientX;
        c.style.cursor = "grabbing";
        return;
      }
      if (e.button !== 0) return;

      if (isSelEdge) {
        this.dragging = t < (this.selStart + this.selEnd) / 2 ? "left" : "right";
      } else if (isSel) {
        this.dragging = "sel";
      } else {
        // 点击空白处 → 重新定位选区（点击选区播放/停止的辅助：点击外部 = 暂停）
        this.dragging = "view";
        this.dragStartView = this.viewStart;
      }
      this.dragStartX = e.clientX;
      this.dragStartSel = { s: this.selStart, e: this.selEnd };
      c.setPointerCapture && c.setPointerCapture(e.pointerId);
    });

    c.addEventListener("mousemove", (e) => {
      if (this.panning) {
        this.panBy(e.clientX - this.panLastX);
        this.panLastX = e.clientX;
        return;
      }
      if (!this.dragging) return;
      const r = rect();
      const x = e.clientX - r.left;
      const t = this._xToTime(x);
      const w = this.canvas.clientWidth || this.canvas.width;
      const dt = (e.clientX - this.dragStartX) / w * (this.viewEnd - this.viewStart);

      if (this.dragging === "left") {
        this.selStart = Math.max(0, Math.min(t, this.selEnd - 0.01));
      } else if (this.dragging === "right") {
        this.selEnd = Math.min(this.duration, Math.max(t, this.selStart + 0.01));
      } else if (this.dragging === "sel") {
        let s = this.dragStartSel.s + dt;
        let en = this.dragStartSel.e + dt;
        if (s < 0) { en -= s; s = 0; }
        if (en > this.duration) { s -= en - this.duration; en = this.duration; }
        this.selStart = s;
        this.selEnd = en;
      } else if (this.dragging === "view") {
        // 空白处拖拽 = 平移视图
        this.panBy(e.clientX - this.dragStartX);
        this.dragStartX = e.clientX;
      }
      this.render();
      if (this.opts.onSelection) this.opts.onSelection();
    });

    const endDrag = (e) => {
      if (this.panning) { this.panning = false; c.style.cursor = ""; return; }
      if (!this.dragging) return;
      // 点击选区（无移动）→ 播放/停止选区
      const moved = Math.abs(e.clientX - this.dragStartX) < 4;
      if (moved && this.dragging === "view") {
        // 点击空白：若正在播放则停止
        if (this.playing) this.stop();
      }
      this.dragging = null;
      if (this.opts.onSelection) this.opts.onSelection();
    };
    c.addEventListener("mouseup", endDrag);
    c.addEventListener("mouseleave", endDrag);

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = rect();
      const x = e.clientX - r.left;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      this.zoomBy(factor, x);
    }, { passive: false });

    c.addEventListener("dblclick", (e) => {
      const r = rect();
      const x = e.clientX - r.left;
      const t = this._xToTime(x);
      // 双击：缩放到选中区
      if (this.hasData) {
        this._fitToSelection();
        this.render();
      }
    });
  }

  // ---------------------------------------------------------- 渲染
  render() {
    const c = this.canvas;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 300;
    const h = c.clientHeight || 120;
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 背景
    ctx.fillStyle = "#10151f";
    ctx.fillRect(0, 0, w, h);

    if (!this.hasData) {
      ctx.fillStyle = "#556";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("加载音频后显示波形…", w / 2, h / 2);
      return;
    }

    // 视图范围映射到峰值桶
    const t0 = this.viewStart;
    const t1 = this.viewEnd;
    const span = Math.max(1e-6, t1 - t0);
    const n = this.peaks.length;
    const center = h / 2;

    // 绘制选区背景（绿色半透明）
    const sx = this._timeToX(this.selStart);
    const ex = this._timeToX(this.selEnd);
    ctx.fillStyle = "rgba(60, 220, 120, 0.25)";
    ctx.fillRect(sx, 0, Math.max(0, ex - sx), h);

    // 绘制波形（采样桶）
    ctx.beginPath();
    for (let px = 0; px <= w; px += 1) {
      const t = t0 + (px / w) * span;
      const idx = Math.floor((t / Math.max(1e-6, this.duration)) * n);
      const peak = this.peaks[Math.max(0, Math.min(n - 1, idx))] || 0;
      const amp = Math.pow(Math.min(1, peak * (this.opts.gain || 2.2)), 0.7);
      const y0 = center - amp * (center - 4);
      const y1 = center + amp * (center - 4);
      ctx.moveTo(px, y0);
      ctx.lineTo(px, y1);
    }
    ctx.strokeStyle = "#5ad08a";
    ctx.lineWidth = 1;
    ctx.stroke();

    // 中线
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.beginPath();
    ctx.moveTo(0, center);
    ctx.lineTo(w, center);
    ctx.stroke();

    // 时间刻度（每5秒，若缩放过密自动跳）
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "10px monospace";
    ctx.textAlign = "left";
    let step = 5;
    while (span / step > 240) step *= 2;   // 太密→放大步长
    while (span / step < 60) step /= 2;    // 太稀→缩小步长
    step = Math.max(1, Math.floor(step));
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const x = this._timeToX(t);
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillText(fmtTime(t), x + 2, 12);
    }

    // 选区边界线
    ctx.strokeStyle = "#ffd54a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
    ctx.moveTo(ex, 0);
    ctx.lineTo(ex, h);
    ctx.stroke();

    // 播放进度游标
    if (this.playing && this.audio) {
      const t = this.audio.currentTime || 0;
      if (t >= this.selStart && t <= this.selEnd) {
        const px = this._timeToX(t);
        ctx.strokeStyle = "#ff6b6b";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, h);
        ctx.stroke();
      }
    }
  }
  destroy() {
    this.stop();
  }
}

/**
 * 裁剪弹窗
 */
class CropDialog {
  constructor(canvas, state) {
    this.state = state; // { peaks, sampleRate, duration, audioUrl }
    this.canvas = canvas;
    this.wc = new WaveCanvas(canvas, {
      gain: 2.2,
      onSelection: () => this._syncInputs(),
    });
    if (state) {
      this.wc.setData(state.peaks, state.sampleRate, state.duration);
      this.wc.setSelection(state.selStart ?? 0, state.selEnd ?? state.duration);
    }

    this.dialog = $el("div", {
      className: "wwdm-dialog-overlay",
      style: {
        position: "fixed",
        top: "0", left: "0", right: "0", bottom: "0",
        background: "rgba(0,0,0,0.55)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
    });
    const box = $el("div", {
      style: {
        background: "#1b2330",
        borderRadius: "10px",
        padding: "18px 22px",
        width: "min(860px, 92vw)",
        boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
        border: "1px solid #2c3a4d",
      },
    });

    // 标题
    box.append(
      $el("div", {
        style: { fontSize: "17px", fontWeight: 600, color: "#eef", marginBottom: "12px" },
        textContent: "音频截取",
      })
    );

    // 波形容器
    this.canvasWrap = $el("div", {
      style: {
        position: "relative",
        width: "100%",
        height: "220px",
        background: "#10151f",
        borderRadius: "6px",
        overflow: "hidden",
        cursor: "crosshair",
      },
    });
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    this.canvasWrap.append(canvas);
    box.append(this.canvasWrap);

    // 波形底部提示
    box.append(
      $el("div", {
        style: { fontSize: "11px", color: "#7a8aa0", marginTop: "6px" },
        textContent: "滚轮：缩放 · 中键拖动：平移 · 点击选区：播放/停止 · 选区左键拖动：移动选区 · 双击：缩放到选区",
      })
    );

    // 参数行（开始时间 / 结束时间 / 选取时长）
    this.inpStart = this._numInput("开始时间");
    this.inpEnd = this._numInput("结束时间");
    this.inpDur = this._numInput("选取时长");
    const row = $el("div", { style: { display: "flex", gap: "18px", marginTop: "12px", alignItems: "flex-end" } });
    row.append(
      this._field("开始时间 (秒)", this.inpStart),
      this._field("结束时间 (秒)", this.inpEnd),
      this._field("选取时长 (秒)", this.inpDur)
    );
    box.append(row);

    // 播放按钮 + 底部按钮（取消/保存 右侧）
    this.btnPlay = $el("button", {
      textContent: "▶ 播放选区",
      style: this._btnStyle("#2e7d54"),
    });
    this.btnCancel = $el("button", {
      textContent: "取消",
      style: this._btnStyle("#3a4658"),
    });
    this.btnSave = $el("button", {
      textContent: "保存",
      style: this._btnStyle("#2f6fb3"),
    });
    const footer = $el("div", {
      style: {
        display: "flex",
        alignItems: "center",
        marginTop: "14px",
        gap: "10px",
      },
    });
    footer.append(this.btnPlay);
    const spacer = $el("div", { style: { flex: 1 } });
    footer.append(spacer, this.btnCancel, this.btnSave);
    box.append(footer);

    this.dialog.append(box);

    // 事件
    this.btnPlay.addEventListener("click", () => {
      if (!this.state?.audioUrl) { alert("无可用音频 URL"); return; }
      this.wc.playSelection(this.state.audioUrl);
    });
    this.btnCancel.addEventListener("click", () => this.close());
    this.btnSave.addEventListener("click", () => this.save());
    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog) this.close();
    });
    this._bindInputs();
  }

  _btnStyle(bg) {
    return {
      background: bg,
      color: "#fff",
      border: "none",
      borderRadius: "6px",
      padding: "8px 20px",
      fontSize: "13px",
      cursor: "pointer",
    };
  }
  _numInput(placeholder) {
    return $el("input", {
      type: "number",
      step: "0.01",
      min: "0",
      placeholder,
      style: {
        width: "120px",
        background: "#0f1622",
        color: "#dde",
        border: "1px solid #2c3a4d",
        borderRadius: "5px",
        padding: "7px 10px",
        fontSize: "13px",
      },
    });
  }
  _field(label, input) {
    const lab = $el("label", { style: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "#9aa7ba" } });
    lab.append(document.createTextNode(label), input);
    return lab;
  }

  _bindInputs() {
    const apply = () => {
      const s = parseFloat(this.inpStart.value);
      const e = parseFloat(this.inpEnd.value);
      const d = parseFloat(this.inpDur.value);
      if (isFinite(s) && s >= 0) this.wc.selStart = Math.min(s, this.wc.duration);
      if (isFinite(e) && e > 0) this.wc.selEnd = Math.min(e, this.wc.duration);
      if (isFinite(d) && d > 0) this.wc.selEnd = Math.min(this.wc.selStart + d, this.wc.duration);
      this.wc.selEnd = Math.max(this.wc.selStart + 0.01, this.wc.selEnd);
      this.wc.render();
      this._syncInputs();
    };
    this.inpStart.addEventListener("input", apply);
    this.inpEnd.addEventListener("input", apply);
    this.inpDur.addEventListener("input", apply);
  }

  _syncInputs() {
    const { start, end } = this.wc.selection;
    this.inpStart.value = fmtTime(start);
    this.inpEnd.value = fmtTime(end);
    this.inpDur.value = fmtTime(end - start);
  }

  save() {
    const { start, end } = this.wc.selection;
    if (this.state?.onSave) this.state.onSave({ start, end, duration: end - start });
    this.close();
  }

  close() {
    this.wc.destroy();
    this.dialog.remove();
  }
}

// =====================================================================
// 节点注册
// =====================================================================
app.registerExtension({
  name: "wwdm.AudioCrop",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== NODE_TYPE) return;

    // ---------- 节点 UI ----------
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);

      // 波形画布（节点内）
      this.wwdmCanvas = $el("canvas", {
        style: {
          width: "100%",
          height: "110px",
          display: "block",
          borderRadius: "4px",
          marginTop: "6px",
          background: "#10151f",
          cursor: "crosshair",
        },
      });
      this.wwdmWc = new WaveCanvas(this.wwdmCanvas, { gain: 2.2 });
      this.wwdmWc.onSelection = () => {
        const { start, end } = this.wwdmWc.selection;
        if (this.widgets) {
          const w = (name) => this.widgets.find((x) => x.name === name);
          const ws = w("slider_start"), we = w("slider_end");
          if (ws) ws.value = (start / (this.wwdmWc.duration || 1)) * 100;
          if (we) we.value = (end / (this.wwdmWc.duration || 1)) * 100;
        }
      };

      // 按钮行：播放 / 裁剪
      this.wwdmBtnPlay = $el("button", {
        textContent: "▶ 播放",
        style: this._wwdmBtnStyle("#2e7d54"),
      });
      this.wwdmBtnCrop = $el("button", {
        textContent: "✂ 裁剪",
        style: this._wwdmBtnStyle("#2f6fb3"),
      });
      const row = $el("div", { style: { display: "flex", gap: "8px", marginTop: "6px" } });
      row.append(this.wwdmBtnPlay, this.wwdmBtnCrop);
      this.wwdmBtns = row;

      const wrap = $el("div", {
        style: { width: "100%", padding: "2px 0" },
      });
      wrap.append(this.wwdmCanvas, row);

      // 插入节点 DOM（widgets 之后）
      if (this.addDOMWidget) {
        this.wwdmWidget = this.addDOMWidget("wwdm_ui", "wwdm_ui", wrap, { serialize: false });
      } else {
        const container = this.el || this.nodeEl || this.constructor?.nodeEl;
        if (container) container.appendChild(wrap);
      }

      this.wwdmBtnPlay.addEventListener("click", () => {
        const url = this.wwdmAudioUrl;
        if (!url) {
          alert("请先加载音频（连接音频并执行一次）");
          return;
        }
        if (this.wwdmWc.playing) this.wwdmWc.stop();
        else this.wwdmWc.playSelection(url);
      });

      this.wwdmBtnCrop.addEventListener("click", () => {
        const state = {
          peaks: this.wwdmWc.peaks ? Array.from(this.wwdmWc.peaks) : null,
          sampleRate: this.wwdmWc.sampleRate,
          duration: this.wwdmWc.duration,
          audioUrl: this.wwdmAudioUrl,
          selStart: this.wwdmWc.selStart,
          selEnd: this.wwdmWc.selEnd,
          onSave: ({ start, end, duration }) => {
            // 保存：更新滑条百分比 + 秒数输入
            const dur = this.wwdmWc.duration || 1;
            const set = (name, v) => {
              const w = this.widgets?.find((x) => x.name === name);
              if (w) w.value = v;
            };
            set("slider_start", (start / dur) * 100);
            set("slider_end", (end / dur) * 100);
            set("start_time", start);
            set("end_time", end);
            set("duration", duration);
            this.wwdmWc.setSelection(start, end);
          },
        };
        new CropDialog($el("canvas"), state);
      });

      return r;
    };

    // ---------- 执行结果（波形数据 + 播放 URL） ----------
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted?.apply(this, arguments);
      if (message?.wwdm_waveform) {
        const wf = message.wwdm_waveform;
        this.wwdmWc.setData(wf.peaks, wf.sample_rate, wf.duration);
        if (message.wwdm_crop_url) {
          this.wwdmAudioUrl = message.wwdm_crop_url;
        }
      }
      return r;
    };

    // ---------- 序列化保留波形数据 ----------
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      if (info?.wwdm_waveform) {
        this.wwdmWc.setData(info.wwdm_waveform.peaks, info.wwdm_waveform.sample_rate, info.wwdm_waveform.duration);
      }
      return r;
    };
  },
});

// 便捷样式
app.registerExtension({
  name: "wwdm.AudioCrop.style",
  setup() {
    const style = document.createElement("style");
    style.textContent = `
      .wwdm-dialog-overlay { font-family: -apple-system, "Segoe UI", sans-serif; }
      .wwdm-dialog-overlay button:hover { filter: brightness(1.15); }
    `;
    document.head.appendChild(style);
  },
});
