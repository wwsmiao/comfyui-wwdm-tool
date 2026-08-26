/**
 * WWDMAudioCrop —— 音频裁剪节点前端（v8.7）
 *
 * v8.7 优化（用户需求）：
 *   1. 去除「🔄 同步」按钮（保留预加载 / 播放）
 *   2. 开始/结束时间秒数保留整数；选取时长用整数下拉，范围 1-15 秒
 *   3. 解决视频节点音频输出无法预加载的问题：
 *      - 新增后端 GET /wwdm/audio/resolve 路由：相对/绝对路径/视频文件统一
 *        folder_paths 定位 + PyAV 解码拿时长 + 转码 wav 返回可播放 URL
 *      - 前端 _wwdmResolveSourceInfo 扩展：兼容上游任意 AUDIO/视频输出节点
 *        （widget 值、对象属性、tensor 直传），不再限定 LoadAudio
 *   4. 开始/结束时间的时、分、秒分开使用下拉菜单选择
 *      （开始：时/分/秒 3 个下拉；结束：时/分/秒 3 个下拉；时长：1 个下拉）
 *
 * v8.6 重构（用户需求）：去掉波形面板，时间选择改为下拉方式
 *   1. 移除波形画布（WaveCanvas/双手柄/缩放平移/波形渲染全部删除）
 *   2. 时间选择改下拉，粒度按音频时长自适应（≤60s 每1s / ≤10min 每30s / >10min 每60s）
 *   3. 保留：上传区、已上传列表下拉、播放/同步/预加载按钮、audio_file 隐藏 widget
 *
 * v8.5 已回退（用户反馈波形面板和按钮消失）：DOM widget 高度自适应方案失败
 *
 * v8.4 修复（用户反馈）：更换输入音频后再点预加载，跳回第一次选择的音频
 *   根因：预加载把上游解析到的文件名写入了 audio_file widget，而解析源优先读
 *   widget → widget 被固化旧音频。修复：仅节点内上传才写 widget，上游来源写空。
 *
 * v8.3 优化：同步/预加载功能分离（同步只同步时间，预加载加载音频）
 *
 * v8.2 修复：新版 ComfyUI app.graph.links 是 Map（旧版数组），.find() 兼容
 *
 * v8.1 优化：输出只保留裁剪 audio；修复结束手柄无法拖动（像素距离判定+偏移拖动）
 *
 * v8 优化：隐藏节点上半部分原生参数 widget，保留波形下方输入 + audio_file 上传
 *
 * 架构：
 *   上传 → /upload/image → 文件名存 hidden widget audio_file → 前端解码 → 下拉选时间
 *   预加载 → _wwdmResolveSourceInfo 找音频源 → GET /wwdm/audio/resolve → 时长+URL
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { $el } from "../../../scripts/ui.js";

const NODE_TYPE = "WWDMAudioCrop";

// 插件版本号（每次更新递增；显示在按钮行右侧，便于确认是否最新版）
const WWDM_VERSION = "v8.7.0";

function normalizeUrl(url) {
  if (!url) return url;
  if (/^https?:\/\//.test(url)) return url;
  return api.apiURL(url.replace(/^\/+/, ""));
}

// ---------- 时间格式工具（整数秒） ----------
/** 解析 "hh:mm:ss" / "mm:ss" / "ss" / 纯数字秒 → 整数秒；解析失败返回 null */
function parseTime(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s)); // 纯秒 → 取整
  const m = s.match(/^(\d{1,3}):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/); // hh:mm:ss(.s)
  if (m) {
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10), ss = parseInt(m[3], 10);
    if (mm >= 60 || ss >= 60) return null;
    return hh * 3600 + mm * 60 + ss;
  }
  const m2 = s.match(/^(\d{1,3}):(\d{1,2})(?:\.(\d+))?$/); // mm:ss(.s)
  if (m2) {
    const mm = parseInt(m2[1], 10), ss = parseInt(m2[2], 10);
    if (ss >= 60) return null;
    return mm * 60 + ss;
  }
  const f = parseFloat(s);
  return isFinite(f) && f >= 0 ? Math.round(f) : null;
}
/** 秒 → "hh:mm:ss"（整数秒，无小数） */
function fmtHMS(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const sec = Math.round(t);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec - h * 3600) / 60);
  const s = sec - h * 3600 - m * 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}


// 构造 input 目录文件的 /view 播放 URL（含 subfolder）
function makeFileUrl(name) {
  if (!name) return "";
  const parts = String(name).replaceAll("\\", "/").split("/").filter(Boolean);
  const filename = parts.pop() || "";
  const params = new URLSearchParams({ filename, type: "input", subfolder: parts.join("/") });
  const path = "/view?" + params.toString();
  return typeof api.apiURL === "function" ? api.apiURL(path) : path;
}

// =====================================================================
// =====================================================================
// 时间下拉选项生成（v8.7：整数秒）
// =====================================================================
/** 0..floor(dur) 的整数秒列表（步长 1，保证每个整数秒可选） */
function intSteps(duration) {
  const dur = Math.max(0, Math.floor(duration || 0));
  const steps = [];
  for (let t = 0; t <= dur; t++) steps.push(t);
  return steps;
}

/** 填充「时/分/秒」下拉：value 存原始数字，text 两位补零 */
function fillHMSSelect(sel, max, current) {
  if (!sel) return;
  sel.innerHTML = "";
  const cur = current == null ? null : Math.max(0, Math.round(Number(current)));
  let bestIdx = 0;
  for (let v = 0; v <= max; v++) {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = String(v).padStart(2, "0");
    sel.appendChild(opt);
    if (cur != null && v <= cur) bestIdx = v;
  }
  sel.selectedIndex = Math.min(bestIdx, sel.options.length - 1);
}

/** 填充「选取时长」下拉：1-15 整数秒 */
function fillDurSelect(sel, current) {
  if (!sel) return;
  sel.innerHTML = "";
  const cur = current == null ? null : Math.max(1, Math.min(15, Math.round(Number(current))));
  for (let v = 1; v <= 15; v++) {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = v + " 秒";
    sel.appendChild(opt);
  }
  if (cur != null && cur >= 1 && cur <= 15) sel.value = String(cur);
}


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
          padding: "8px 8px",
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
          padding: "4px 6px",
          fontSize: "12px",
          boxSizing: "border-box",
          marginTop: "5px",
          display: "none",
        },
      });
      this.wwdmFileSelect.addEventListener("change", () => {
        const name = this.wwdmFileSelect.value;
        if (!name) return;
        this._wwdmLoadFile(name);
      });
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

      // ---------- 时间下拉行（v8.7：时分秒分开 + 时长 1-15 整数） ----------
      const selStyle = {
        width: "100%",
        background: "#0f1622",
        color: "#dde",
        border: "1px solid #2c3a4d",
        borderRadius: "4px",
        padding: "4px 6px",
        fontSize: "12px",
        boxSizing: "border-box",
        fontFamily: "monospace",
      };
      const mkSel = (label, ref) => {
        const sel = $el("select", { style: selStyle });
        const lab = $el("label", {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "2px",
            fontSize: "11px",
            color: "#8fa0b8",
            flex: 1,
          },
        });
        lab.append(document.createTextNode(label), sel);
        this[ref] = sel;
        return lab;
      };
      // 开始时间：时/分/秒 三个下拉
      const startRow = $el("div", { style: { display: "flex", gap: "4px", marginTop: "6px", alignItems: "flex-end" } });
      const sLab = $el("span", { style: { fontSize: "11px", color: "#8fa0b8", marginRight: "4px", lineHeight: "22px" }, textContent: "开始" });
      startRow.append(sLab);
      startRow.append(
        mkSel("时", "wwdmSelSH"),
        mkSel("分", "wwdmSelSM"),
        mkSel("秒", "wwdmSelSS")
      );
      // 结束时间：时/分/秒 三个下拉
      const endRow = $el("div", { style: { display: "flex", gap: "4px", marginTop: "4px", alignItems: "flex-end" } });
      const eLab = $el("span", { style: { fontSize: "11px", color: "#8fa0b8", marginRight: "4px", lineHeight: "22px" }, textContent: "结束" });
      endRow.append(eLab);
      endRow.append(
        mkSel("时", "wwdmSelEH"),
        mkSel("分", "wwdmSelEM"),
        mkSel("秒", "wwdmSelES")
      );
      // 选取时长：1-15 整数秒
      const durRow = $el("div", { style: { display: "flex", gap: "4px", marginTop: "4px", alignItems: "flex-end" } });
      const dLab = $el("span", { style: { fontSize: "11px", color: "#8fa0b8", marginRight: "4px", lineHeight: "22px" }, textContent: "时长" });
      durRow.append(dLab);
      durRow.append(mkSel("选取时长", "wwdmSelDur"));

      // ---------- 按钮行（v8.7：播放 + 预加载，已去掉同步） ----------
      const btnStyle = (bg) => ({
        background: bg,
        color: "#fff",
        border: "none",
        borderRadius: "5px",
        padding: "6px 12px",
        fontSize: "12px",
        cursor: "pointer",
        fontWeight: 600,
      });
      this.wwdmBtnPlay = $el("button", { textContent: "▶ 播放", style: btnStyle("#2e7d54") });
      this.wwdmBtnPlay.style.flex = "1";
      this.wwdmBtnPreload = $el("button", { textContent: "⏬ 预加载", style: btnStyle("#6a4fa3") });
      this.wwdmBtnPreload.style.flex = "1";
      const hint = $el("div", {
        style: { fontSize: "10px", color: "#5c6a82", flex: "1.4", lineHeight: "16px", textAlign: "right" },
        textContent: "版本 " + WWDM_VERSION,
      });
      const btnRow = $el("div", { style: { display: "flex", gap: "6px", marginTop: "6px", alignItems: "center" } });
      btnRow.append(this.wwdmBtnPlay, this.wwdmBtnPreload, hint);

      const wrap = $el("div", { style: { width: "100%", padding: "2px 0" } });
      wrap.append(uploadZone, this.wwdmFileSelect, this.wwdmFileName, startRow, endRow, durRow, btnRow);
      this.wwdmUiEl = wrap;

      if (this.addDOMWidget) {
        this.wwdmWidget = this.addDOMWidget("wwdm_ui", "wwdm_ui", wrap, { serialize: false });
        // v8.7：无画布，时分秒 3 行 + 按钮行。固定高度（上传34+下拉30+文件名16+开始28+结束28+时长28+按钮30+边距≈40）
        this.wwdmWidget.computeSize = function (width) {
          return [width || 340, 245];
        };
      } else {
        const container = this.el || this.nodeEl || this.constructor?.nodeEl;
        if (container) container.appendChild(wrap);
      }

      // 节点高度覆盖（v8.7：无画布，内容紧凑）
      const origComputeSize = this.computeSize?.bind(this);
      this.computeSize = function (w) {
        const base = origComputeSize ? origComputeSize(w) : [360, 320];
        const needed = 300; // 上传34+下拉30+文件名16+时间3行(84)+按钮30+边距(~100)
        return [base[0], Math.max(base[1], needed)];
      };

      // ---------- 隐藏原生 start_time/end_time/duration + audio_file 参数（v8） ----------
      // widget 仍留在 this.widgets 中，值会被序列化并随执行传给后端 crop()，保证功能不变。
      for (const nm of ["start_time", "end_time", "duration", "audio_file"]) {
        const w = this.widgets?.find((x) => x.name === nm);
        if (w) {
          w.hidden = true;
          w.computeSize = () => [0, -4];
        }
      }

      // ---------- 状态 ----------
      this._wwdmGuard = false;
      // v8.6：时间选区状态（不再有波形画布）
      this._wwdmSel = { s: 0, e: 0 };
      this._wwdmDuration = 0;
      this._wwdmAudioUrl = "";
      this._wwdmHasAudio = false;
      // ---------- 时间下拉事件（v8.7：时分秒 + 时长联动） ----------
      // 从 7 个下拉读取时间：开始 = SH*3600+SM*60+SS；结束 = EH*3600+EM*60+ES
      this._wwdmReadSel = () => {
        const g = (ref) => { const el = this[ref]; return el && el.value !== "" ? Number(el.value) : 0; };
        const sv = g("wwdmSelSH") * 3600 + g("wwdmSelSM") * 60 + g("wwdmSelSS");
        const ev = g("wwdmSelEH") * 3600 + g("wwdmSelEM") * 60 + g("wwdmSelES");
        const dv = g("wwdmSelDur");
        return { sv, ev, dv };
      };
      const applyFromDropdowns = () => {
        if (!this._wwdmHasAudio) return;
        const dur = this._wwdmDuration || 1;
        const { sv, ev, dv } = this._wwdmReadSel();
        let s = Math.max(0, Math.min(sv, dur));
        let e;
        if (dv != null && dv > 0) {
          e = Math.min(dur, s + dv); // 时长优先
        } else {
          e = Math.min(dur, Math.max(ev, s + 1));
        }
        if (e <= s + 1) e = Math.min(dur, s + 1);
        this._setSel(s, e);
      };
      for (const ref of ["wwdmSelSH", "wwdmSelSM", "wwdmSelSS", "wwdmSelEH", "wwdmSelEM", "wwdmSelES", "wwdmSelDur"]) {
        const el = this[ref];
        if (el) el.addEventListener("change", applyFromDropdowns);
      }

      // ---------- 预加载按钮（v8.3：从输入端获取当前音频并刷新） ----------
      this.wwdmBtnPreload.addEventListener("click", () => this._wwdmPreload());

      // ---------- 播放按钮 ----------
      this.wwdmBtnPlay.addEventListener("click", () => {
        const url = this.wwdmAudioUrl || (this._wwdmCurrentName ? makeFileUrl(this._wwdmCurrentName) : "");
        if (!url) {
          alert("请先上传或选择音频文件");
          return;
        }
        if (!this._wwdmHasAudio) {
          alert("音频尚未加载，请先点「⏬ 预加载」或上传");
          return;
        }
        if (this._wwdmPlaying) {
          this._wwdmStopPlay();
        } else {
          this._wwdmPlaySelection(url);
        }
      });


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

      /** 加载已上传/已选择的音频文件（写入 widget + 解码获取时长 + 填充时间下拉） */
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
          const buffer = await decodeAudioBuffer(makeFileUrl(name));
          const duration = buffer.duration || (buffer.length / (buffer.sampleRate || 44100));
          this._wwdmDuration = duration;
          this._wwdmHasAudio = true;
          this._setSel(0, duration); // 全选并填充下拉
        } catch (err) {
          console.error("[wwdm] 音频解码失败", err);
          this.wwdmFileName.textContent = "❌ 音频解码失败: " + String(err.message || err);
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

    // ---------- 设置选区（v8.7：核心状态入口） ----------
    // 写 _wwdmSel、刷新 7 个下拉、写隐藏 widget（start_time/end_time/duration）
    nodeType.prototype._setSel = function (s, e) {
      const dur = this._wwdmDuration || 0;
      if (dur <= 0) return;
      s = Math.max(0, Math.min(Math.round(s), Math.floor(dur)));
      e = Math.max(s + 1, Math.min(Math.round(e), Math.floor(dur)));
      this._wwdmSel = { s, e };
      // 刷新时分秒下拉（时 0-23 / 分 0-59 / 秒 0-59；若音频超 24h 则时上限扩展）
      const maxH = Math.min(23, Math.floor(dur / 3600));
      const sSec = s % 60, sMin = Math.floor(s / 60) % 60, sHr = Math.floor(s / 3600);
      const eSec = e % 60, eMin = Math.floor(e / 60) % 60, eHr = Math.floor(e / 3600);
      fillHMSSelect(this.wwdmSelSH, maxH, sHr);
      fillHMSSelect(this.wwdmSelSM, 59, sMin);
      fillHMSSelect(this.wwdmSelSS, 59, sSec);
      fillHMSSelect(this.wwdmSelEH, maxH, eHr);
      fillHMSSelect(this.wwdmSelEM, 59, eMin);
      fillHMSSelect(this.wwdmSelES, 59, eSec);
      fillDurSelect(this.wwdmSelDur, e - s);
      this._wwdmSyncWidgets();
    };


    // ---------- 解析音频源（v8.7：返回 {name, fromUpload}） ----------
    // fromUpload=true 表示节点内上传（文件名存 input 目录）
    // 否则为上游节点来源：widget 值（LoadAudio/视频节点路径），或对象/字典属性
    nodeType.prototype._wwdmResolveSourceInfo = function () {
      // 1) 节点内上传的 audio_file
      const wf = this.widgets?.find((x) => x.name === "audio_file");
      if (wf?.value && String(wf.value).trim()) {
        return { name: String(wf.value).trim(), fromUpload: true };
      }
      // 2) 上游节点的音频文件名（LoadAudio / 视频节点 / 任意 AUDIO 输出）
      //    新版 ComfyUI 的 app.graph.links 是 Map（旧版是数组），需兼容两种结构
      const inp = this.inputs?.find((x) => x.name === "audio");
      if (inp?.link != null && app?.graph) {
        const links = app.graph.links;
        const link = Array.isArray(links)
          ? links.find((l) => l.id === inp.link)
          : links?.get?.(inp.link);
        const src = link ? app.graph.getNodeById(link.origin_id) : null;
        if (src) {
          // 2a) 优先取「audio」命名 widget（LoadAudio 风格）
          const aw = src.widgets?.find((x) => x.name === "audio");
          if (aw?.value && typeof aw.value === "string" && String(aw.value).trim()) {
            return { name: String(aw.value).trim(), fromUpload: false };
          }
          // 2b) 视频节点：widget 可能是 video/file/audio_file/audio_path/filename 等路径
          for (const nm of ["video", "file", "audio_file", "audio_path", "filename"]) {
            const wv = src.widgets?.find((x) => x.name === nm);
            if (wv?.value && typeof wv.value === "string" && String(wv.value).trim()) {
              return { name: String(wv.value).trim(), fromUpload: false };
            }
          }
          // 2c) 兼容：第一个 widget 恰好是文件名的场景（含 combo/字符串）
          const w0 = src.widgets?.[0];
          if (w0?.value && typeof w0.value === "string" && String(w0.value).trim()) {
            return { name: String(w0.value).trim(), fromUpload: false };
          }
          // 2d) 对象/字典属性（部分自定义节点输出 audio 对象）
          const ww = src.widgetsValues || src.properties || null;
          if (ww && typeof ww === "object") {
            for (const k of ["audio", "video", "file", "filename", "path"]) {
              const v = ww[k];
              if (v && typeof v === "string" && String(v).trim()) {
                return { name: String(v).trim(), fromUpload: false };
              }
            }
          }
        }
      }
      return null;
    };

    // ---------- 解析音频源（兼容旧调用：返回文件名或 null） ----------
    nodeType.prototype._wwdmResolveSource = function () {
      const info = this._wwdmResolveSourceInfo();
      return info ? info.name : null;
    };

    // ---------- 预加载（v8.7：后端 /wwdm/audio/resolve 解析任意来源） ----------
    // 支持：节点内上传 / LoadAudio / 视频节点路径 / 绝对路径 / 相对路径
    nodeType.prototype._wwdmPreload = async function () {
      const info = this._wwdmResolveSourceInfo();
      const name = info ? info.name : null;
      if (!name) {
        alert("未找到音频：请在节点内上传音频，或连接 LoadAudio / 视频节点的 AUDIO 输入");
        return;
      }
      // 后端统一解析：folder_paths 定位（相对/绝对路径/视频文件均可）→ 时长 + 可播放 URL
      try {
        const res = await api.fetchApi("/wwdm/audio/resolve?name=" + encodeURIComponent(name));
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error((data && data.error) || ("HTTP " + res.status));
        }
        const duration = Number(data.duration) || 0;
        if (duration <= 0) throw new Error("音频时长为 0");
        // 更新来源展示（强制刷新：即使同名也刷新 UI，解决更换输入音频后点击无效）
        this._wwdmCurrentName = name;
        // 仅节点内上传才写入 audio_file widget；上游来源不写 widget，
        // 保持 widget 为空 → 下次解析仍读上游当前音频（否则会固化旧音频导致跳回第一次）
        const wf = this.widgets?.find((x) => x.name === "audio_file");
        if (info.fromUpload) {
          if (wf) wf.value = name;
        } else if (wf) {
          wf.value = "";
        }
        this.wwdmFileName.textContent = "已加载: " + name;
        this.wwdmAudioUrl = data.audio_url || makeFileUrl(name);
        this._wwdmDuration = duration;
        this._wwdmHasAudio = true;
        const sel = this.wwdmFileSelect;
        if (sel && ![...sel.options].some((o) => o.value === name)) {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          sel.appendChild(opt);
        }
        if (sel) sel.value = name;
        // 新音频：选区重置为全选，并填充时分秒下拉
        this._setSel(0, duration);
      } catch (err) {
        console.error("[wwdm] 预加载失败", err);
        this.wwdmFileName.textContent = "❌ 音频加载失败: " + String(err.message || err);
        alert("音频加载失败: " + String(err.message || err));
      }
    };


    // ---------- 选区 → 隐藏 widget（start_time/end_time/duration）同步（v8.7 整数） ----------
    nodeType.prototype._wwdmSyncWidgets = function () {
      if (this._wwdmGuard) return;
      this._wwdmGuard = true;
      try {
        const { s, e } = this._wwdmSel || { s: 0, e: 0 };
        const dur = Math.max(1, e - s);
        const w = (name) => this.widgets?.find((x) => x.name === name);
        const ws = w("start_time"), we = w("end_time"), wd = w("duration");
        if (ws) ws.value = fmtHMS(s);
        if (we) we.value = fmtHMS(e);
        if (wd) wd.value = String(Math.round(dur));
      } finally {
        this._wwdmGuard = false;
      }
    };


    const onWidgetChanged = nodeType.prototype.onWidgetChanged;
    nodeType.prototype.onWidgetChanged = function (widget, value) {
      const r = onWidgetChanged?.apply(this, arguments);
      if (this._wwdmGuard || !this._wwdmHasAudio) return r;
      if (widget?.name === "start_time") {
        const v = parseTime(value);
        if (v != null) {
          const e = Math.max(v + 1, this._wwdmSel.e);
          this._setSel(v, e);
        }
      } else if (widget?.name === "end_time") {
        const v = parseTime(value);
        if (v != null) {
          const s = Math.min(v - 1, this._wwdmSel.s);
          this._setSel(s, v);
        }
      } else if (widget?.name === "duration") {
        const v = parseTime(value);
        if (v != null) this._setSel(this._wwdmSel.s, this._wwdmSel.s + v);
      }
      return r;
    };

    // ---------- 执行结果（保留：读取后端返回的时长/URL，刷新时间下拉） ----------
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted?.apply(this, arguments);
      const pick = (v) => (Array.isArray(v) ? v[0] : v);
      const audioUrl = pick(message?.wwdm_audio_url);
      const cropUrl = pick(message?.wwdm_crop_url);
      if (audioUrl) this.wwdmAudioUrl = audioUrl;
      if (cropUrl) this._wwdmCropUrl = cropUrl;
      // 保留用户已设置的时间参数：执行后下拉反映 start/end/duration 值
      const w = (name) => this.widgets?.find((x) => x.name === name);
      const sv = parseTime(w("start_time")?.value);
      const ev = parseTime(w("end_time")?.value);
      const dv = parseTime(w("duration")?.value);
      if (sv != null || ev != null || dv != null) {
        const dur = this._wwdmDuration || 1;
        let s = this._wwdmSel?.s ?? 0;
        let e = this._wwdmSel?.e ?? dur;
        if (sv != null && sv >= 0) s = Math.min(sv, dur);
        if (dv != null && dv > 0) e = Math.min(dur, s + dv);
        else if (ev != null && ev > 0) e = Math.min(dur, Math.max(ev, s + 1));
        this._setSel(s, e);
      }
      return r;
    };

    // ---------- 序列化保留（v8.6：无波形，无需恢复；保留钩子） ----------
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      return onConfigure?.apply(this, arguments);
    };

    // ---------- 播放（v8.6：用 <audio> 播放选区，无波形） ----------
    nodeType.prototype._wwdmPlaySelection = function (url) {
      if (!url || !this._wwdmHasAudio) return;
      this._wwdmStopPlay();
      const audio = new Audio(url);
      this._wwdmAudioEl = audio;
      this._wwdmPlaying = true;
      this.wwdmBtnPlay.textContent = "⏹ 停止";
      const { s, e } = this._wwdmSel || { s: 0, e: 0 };
      const startPlay = () => {
        try {
          audio.currentTime = Math.max(0, Math.min(s, this._wwdmDuration || 0));
        } catch (err) {}
        audio.play().catch(() => {});
      };
      if (audio.readyState >= 1) startPlay();
      else audio.addEventListener("loadedmetadata", startPlay, { once: true });
      audio.addEventListener("ended", () => this._wwdmStopPlay(), { once: true });
      audio.addEventListener("error", () => this._wwdmStopPlay(), { once: true });
      // 播放到结束时间自动停止
      const checkEnd = () => {
        if (!this._wwdmPlaying || !this._wwdmAudioEl) return;
        if (this._wwdmAudioEl.currentTime >= e) {
          this._wwdmStopPlay();
          return;
        }
        this._wwdmPlayRaf = requestAnimationFrame(checkEnd);
      };
      this._wwdmPlayRaf = requestAnimationFrame(checkEnd);
    };
    nodeType.prototype._wwdmStopPlay = function () {
      this._wwdmPlaying = false;
      if (this._wwdmPlayRaf) cancelAnimationFrame(this._wwdmPlayRaf);
      this._wwdmPlayRaf = null;
      if (this._wwdmAudioEl) {
        try {
          this._wwdmAudioEl.pause();
          this._wwdmAudioEl.removeAttribute("src");
        } catch (err) {}
        this._wwdmAudioEl = null;
      }
      if (this.wwdmBtnPlay) this.wwdmBtnPlay.textContent = "▶ 播放";
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
