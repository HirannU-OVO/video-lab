/* eslint-disable */
/**
 * 组件展示页脚本（C-04 组件工厂的活样板 · C-07 组件级视觉快照的载体）
 *
 * 全部控件都由 VL.ui 工厂渲染，用来验证「新代码只需选 variant/size/state，
 * 不用重新发明样式」。页面本身不含任何硬编码色与内联样式。
 */
(function () {
  'use strict';

  function fill(id, nodes) {
    var box = document.getElementById(id);
    if (!box) return;
    for (var i = 0; i < nodes.length; i++) box.appendChild(nodes[i]);
  }

  function init() {
    if (!window.VL || !VL.ui) return;

    // ① 按钮 variant
    fill('rowsVariant', [
      VL.ui.btn({ text: '普通' }),
      VL.ui.btn({ text: '主操作', variant: 'primary' }),
      VL.ui.btn({ text: '危险', variant: 'danger' }),
      VL.ui.btn({ text: '幽灵', variant: 'ghost' }),
      VL.ui.btn({ text: '次级', variant: 'subtle' })
    ]);

    // ② 按钮 size
    fill('rowsSize', [
      VL.ui.btn({ text: '小 sm', size: 'sm' }),
      VL.ui.btn({ text: '中 md' }),
      VL.ui.btn({ text: '大 lg', size: 'lg' })
    ]);

    // ③ 按钮状态（用属性表达）
    fill('rowsState', [
      VL.ui.btn({ text: '禁用', disabled: true }),
      VL.ui.btn({ text: '已按下', pressed: true }),
      VL.ui.btn({ text: '提交中', loading: true })
    ]);

    // ④ 输入框
    fill('rowsInput', [
      VL.ui.input({ placeholder: '默认输入框' }),
      VL.ui.input({ placeholder: '小号', size: 'sm' }),
      VL.ui.input({ value: '只读内容', readonly: true }),
      VL.ui.input({ placeholder: '校验失败', invalid: true })
    ]);

    // ⑤ 复选框
    fill('rowsCheck', [
      VL.ui.check({ text: '普通勾选项' }),
      VL.ui.check({ text: '已勾选', checked: true }),
      VL.ui.check({ text: '带说明', hint: '补充说明一行，用于解释这个选项的影响' }),
      VL.ui.check({ text: '禁用项', disabled: true })
    ]);

    // ⑥ 标签
    fill('rowsTag', [
      VL.ui.tag({ text: '中性' }),
      VL.ui.tag({ text: '品牌', variant: 'brand' }),
      VL.ui.tag({ text: '注意', variant: 'accent' }),
      VL.ui.tag({ text: '失败', variant: 'danger' }),
      VL.ui.tag({ text: '完成', variant: 'ok' }),
      VL.ui.tag({ text: '描边', variant: 'outline' }),
      VL.ui.tag({ text: '小号', size: 'sm' })
    ]);

    // 皮肤跟随：仅在页面未指定 data-skin 时向主进程取一次。⚠ 不读 localStorage。
    try {
      if (!document.documentElement.getAttribute('data-skin') && window.txapi && window.txapi.get_skin) {
        Promise.resolve(window.txapi.get_skin()).then(function (s) {
          if (s && !document.documentElement.getAttribute('data-skin')) {
            document.documentElement.setAttribute('data-skin', String(s));
          }
        }).catch(function () {});
      }
    } catch (e) { /* 皮肤取不到也不影响展示 */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
