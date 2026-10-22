// 参数声明与归一化底座：按一份声明产出参数值（声明是数据、归一化是纯函数）。
// 后处理步骤（steps/*.js）与画布合成（canvas-plan.js）共用同一套「声明 → 归一化」，
// 加参数只改声明，默认值 / 范围 / 枚举 / 偶数对齐 / 颜色格式不再各处手写。
'use strict';

/**
 * 参数类型。前端 paramField 与这里必须同形，否则渲染出来的控件取不到值。
 *   number —— 数值（可带 min/max/step/evenAlign）
 *   select —— 枚举（options 为字符串数组）
 *   bool   —— 布尔
 *   file   —— 路径（前端给「选择」按钮）
 *   color  —— 颜色（#RRGGBB / 0xRRGGBB，归一化为 0xrrggbb）
 *   text   —— 普通文本
 */
const TYPES = ['number', 'select', 'bool', 'file', 'color', 'text'];

/** 声明是否合法（开发期自查用；运行期不因声明瑕疵中断处理） */
function validateSchema(schema) {
  const problems = [];
  if (!Array.isArray(schema) || !schema.length) return ['schema 必须是非空数组'];
  const seen = new Set();
  schema.forEach((sc, i) => {
    if (!sc || typeof sc !== 'object') { problems.push('第 ' + (i + 1) + ' 项不是对象'); return; }
    if (!sc.key) problems.push('第 ' + (i + 1) + ' 项缺少 key');
    if (sc.key && seen.has(sc.key)) problems.push('key 重复：' + sc.key);
    if (sc.key) seen.add(sc.key);
    const t = String(sc.type || 'text');
    if (TYPES.indexOf(t) < 0) problems.push(sc.key + ' 的 type 未知：' + t);
    if (t === 'select' && !(Array.isArray(sc.options) && sc.options.length)) {
      problems.push(sc.key + ' 是 select 但没有 options');
    }
    if (t === 'number' && sc.min != null && sc.max != null && sc.min > sc.max) {
      problems.push(sc.key + ' 的 min 大于 max');
    }
  });
  return problems;
}

/** 按声明取一份默认值对象 */
function defaultsOf(schema) {
  const out = {};
  (schema || []).forEach((sc) => {
    if (!sc || !sc.key) return;
    if (sc.default !== undefined) out[sc.key] = sc.default;
    else if (sc.type === 'bool') out[sc.key] = false;
    else if (sc.type === 'number') out[sc.key] = 0;
    else out[sc.key] = '';
  });
  return out;
}

/** 颜色归一化为 ffmpeg 的 0xRRGGBB；非法值回退 fallback 并按需记告警 */
function toFfmpegColor(v, fallback, warnings, label) {
  const s = String(v == null ? '' : v).trim();
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s) || /^0x([0-9a-fA-F]{6})$/.exec(s);
  if (m) return '0x' + m[1].toLowerCase();
  // label 通常已含「颜色」二字（如「背景颜色」），这里不再重复
  if (s && warnings) warnings.push(label + ' 格式无法识别（' + s + '），已按默认值处理');
  return '0x' + String(fallback || '#000000').replace('#', '').toLowerCase();
}

/** 偶数对齐：编码器（h264/hevc）要求宽高为偶数 */
function evenAlign(v) {
  const n = Math.round(Number(v) || 0);
  return n % 2 === 0 ? n : n + 1;
}

/**
 * 按声明归一化参数：缺值取默认、越界裁剪、非法枚举回落、颜色与偶数按需处理。
 * ⚠ **不抛异常**：参数问题一律降级为告警并给出可用值 —— 处理链路不能因为一个越界数字整体失败。
 * @param {Array} schema 参数声明
 * @param {object} params 用户传入的参数（可能缺字段、类型也不对）
 * @param {{label?:Function}} [opts] label(k) 用于告警里的参数名
 */
function normalize(schema, params, opts) {
  const o = opts || {};
  const labelOf = (k) => (typeof o.label === 'function' ? o.label(k) : k);
  const p = Object.assign(defaultsOf(schema), params || {});
  const warnings = [];

  (schema || []).forEach((sc) => {
    if (!sc || !sc.key) return;
    const k = sc.key;
    const t = String(sc.type || 'text');
    const name = labelOf(k) || k;

    if (t === 'number') {
      const n = Number(p[k]);
      if (!isFinite(n)) {
        p[k] = sc.default !== undefined ? sc.default : 0;
        if (Number.isFinite(Number(sc.default))) {
          warnings.push(name + ' 不是有效数字，已按默认值 ' + p[k] + ' 处理');
        }
        return;
      }
      let v = n;
      if (sc.min != null && v < sc.min) {
        warnings.push(name + ' 低于下限 ' + sc.min + '，已按 ' + sc.min + ' 处理');
        v = sc.min;
      }
      if (sc.max != null && v > sc.max) {
        warnings.push(name + ' 超过上限 ' + sc.max + '，已按 ' + sc.max + ' 处理');
        v = sc.max;
      }
      if (sc.evenAlign) {
        const e = evenAlign(v);
        if (e !== Math.round(v) && !sc.silentEven) warnings.push(name + ' 已对齐为偶数（编码要求）');
        v = e;
      }
      p[k] = v;
      return;
    }

    if (t === 'select') {
      const list = sc.options || [];
      const cur = String(p[k] == null ? '' : p[k]);
      if (list.indexOf(cur) < 0) {
        // 非法枚举：回落 default，无 default 则取第一项（避免留下空值）
        const fb = sc.default !== undefined ? String(sc.default) : String(list[0] == null ? '' : list[0]);
        if (cur) warnings.push(name + ' 无法识别（' + cur + '），已按 ' + (fb || '默认值') + ' 处理');
        p[k] = fb;
      } else {
        p[k] = cur;
      }
      return;
    }

    if (t === 'bool') {
      p[k] = !!p[k];
      return;
    }

    if (t === 'color') {
      p[k] = toFfmpegColor(p[k], sc.default || '#000000', warnings, name);
      return;
    }

    // file / text：统一成字符串（null/undefined → 空串）
    p[k] = p[k] == null ? '' : String(p[k]);
  });

  return { params: p, warnings };
}

module.exports = { TYPES, validateSchema, defaultsOf, normalize, toFfmpegColor, evenAlign };
