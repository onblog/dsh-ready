/* Status messages the main process hands back to the UI (error/result notices); confirmation dialogs are drawn by the renderer itself and never go through here. */

const MESSAGES = {
  zh: {
    'msg.busy': '已有操作在进行中',
    'msg.notInstalled': '尚未安装 DSH，请先安装',
    'msg.noTarget': '暂时拿不到可升级的版本，请检查网络后重试',
    'msg.targetTooLow': '目标版本需要高于当前 {current}，请选择更新的版本',
    'msg.noPlan': '缺少升级计划，请重新检查',
    'msg.notRunning': 'DSH 尚未运行',
    'msg.takeoverNone': '未检测到其它方式启动的 DSH',
    'msg.portInvalid': '端口需在 1–65535 之间',
    'msg.portFirst': '请先停止 DSH 再修改端口',
    'msg.systemUninstall': '插件与配置已清理，用户数据保留；程序本体请在终端卸载',
    'msg.uninstalled': 'DSH 已卸载（用户数据、Node 与 npm 保留）',
    'msg.autoLaunchUnsupported': '开机自启动仅在安装版的 macOS / Windows 上可用',
    'msg.autoLaunchOn': '已开启开机自启动',
    'msg.autoLaunchOff': '已关闭开机自启动',
    'msg.autoLaunchFailed': '修改开机自启动失败'
  },
  en: {
    'msg.busy': 'Another operation is already running',
    'msg.notInstalled': 'DSH is not installed yet',
    'msg.noTarget': 'No upgradable version found — check the network and retry',
    'msg.targetTooLow': 'The target must be newer than the current {current}',
    'msg.noPlan': 'Upgrade plan missing, run the check again',
    'msg.notRunning': 'DSH is not running',
    'msg.takeoverNone': 'No DSH started outside DSH Ready was found',
    'msg.portInvalid': 'Port must be between 1 and 65535',
    'msg.portFirst': 'Stop DSH before changing the port',
    'msg.systemUninstall': 'Plugins and configuration cleaned; user data kept — remove the package in your terminal',
    'msg.uninstalled': 'DSH uninstalled (user data, Node and npm kept)',
    'msg.autoLaunchUnsupported': 'Launch at login works only in the installed macOS / Windows build',
    'msg.autoLaunchOn': 'Launch at login enabled',
    'msg.autoLaunchOff': 'Launch at login disabled',
    'msg.autoLaunchFailed': 'Could not change the login item'
  }
}

export function mainT(lang, key, params) {
  const table = MESSAGES[lang] ?? MESSAGES.zh
  const template = table[key] ?? MESSAGES.zh[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}
