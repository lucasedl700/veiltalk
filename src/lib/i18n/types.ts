/**
 * VeilTalk i18n — 类型定义
 *
 * 设计（第 16 轮 F-34，P1-4 落地）：
 *  - 自研轻量方案而非 next-intl：本项目为单路由 App Router（唯一可见路由 /），
 *    无 locale 路由诉求；语言切换要求客户端无刷新即时生效；零依赖 + 完全类型安全
 *    （字典即对象，属性访问即查找，编译期校验 key 存在性）。
 *  - 字典按「pack 文件」拆分（packs/core|shell|panels.ts），各 pack 内部以 zh 为
 *    事实源、en 显式标注 typeof zh 强制形状一致（漏译/多译都是编译错误）。
 *  - 命名空间在 pack 间不允许重叠（分配见 worklog 第 16 轮）。
 */

export type Lang = 'zh' | 'en'

/** 变量插值：模板中的 {name} 由 fmt() 替换 */
export type Vars = Record<string, string | number>
