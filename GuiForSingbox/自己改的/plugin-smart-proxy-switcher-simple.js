/*
 * 节点智能切换（v1.6 · 日常长期运行优化版）
 * 文件名固定为 plugin-smart-proxy-switcher-simple.js（无版本号，避免同目录堆积多个 .js 拿错）；
 * 历史版本在 _versions/，工具脚本在 _tools/。
 *
 * 目标：日常使用开箱可用，只关心三件事 —— 能不能用 / 快不快 / 稳不稳。
 *
 * 第 1 轮（都是「看起来在工作、其实没有」的问题）：
 *  1. 切换改为 async + await + 回读确认。v1.0 不 await 宿主切换（它是 async、无返回值、失败静默 return），
 *     `if (result !== false)` 恒为真 ⇒ 切失败也照样写冷却、照样把 current 改成目标节点（假成功）。
 *  2. 配置一律读钩子入参 config.*，不再读 Plugin.*（宿主只在加载时注入一次，是旧快照）。
 *  3. 巡检加「整轮重入守卫」。
 *  4. 切换阈值改用「至少快多少毫秒」，不再与 latencyWeight 强耦合。
 *  5. 修掉 3 个静默失效点：JSON.parse 无 try/catch、asyncPool(NaN) 一个节点都不测、
 *     UI 每秒渲染里调用带副作用的状态机函数。
 *  6. 启动幂等；弹窗关闭真正清掉刷新定时器。
 *
 * 第 2 轮（补掉第 1 轮遗留的 9 项）：
 *  A. status 语义：运行=1(绿) / 停止=0(无圆点) / 异常=2(红)。
 *  B. onConfigure / Start「先校验后停」：配置写错时不打断正在运行的那一轮。
 *  C. 节点列表自动同步：订阅更新、手动增删节点后插件能跟上，同 id 保留历史指标。
 *  D. 未匹配的策略组名提示一次（localStorage 指纹去重）。
 *  E. secret 为空时不发 Authorization 头。
 *  F. failureCount 上限夹取到 failureThreshold。
 *  G. 弹窗 tab 失效时重置。
 *  H. 弹窗标题显示「上次切换」记录。
 *  I. 单轮耗时超过间隔时告警。
 *
 * 第 3 轮（本轮，L 批 —— 修逻辑不一致 + 体验）：
 *  L1. ★候选筛选与阈值判定解耦：旧版「按综合分挑最优，再要求它比当前快 margin」——
 *      稳定性/惩罚权重会把「延迟最低的节点」挤出候选 ⇒ 该切不切、或切到延迟次优的节点。
 *      现在改为「先按延迟筛出确实更快的候选，再在其中选综合分最高」。
 *  L2. 调度改为「跑完再等间隔」的链式 setTimeout。宿主 setIntervalImmediately 是 setInterval，
 *      单轮耗时 > 间隔时会变成背靠背连跑（网络/CPU 持续满负荷），且「间隔」名存实亡。
 *  L3. 弹窗实例一次性 + 关闭即清理刷新定时器。★注意：**不能复用 modal 实例**（v1.3 初版踩过，
 *      症状是「关掉后再点 ✨ 打不开」）。宿主 Plugins.modal 内部 destroyOnClose 默认 true，
 *      每次关闭都会走 afterDestroy ⇒ 把自己那个 `div#Modal-xxx` 容器 remove() 掉，
 *      该实例的 open() 从此只改状态、DOM 回不来。所以是「每次新建 + afterClose/afterDestroy 清理」。
 *  L4. 轮级统一测速地址：旧版每个节点各自随机 ⇒ 同一节点的 EWMA 混入不同 URL 的基线（不可比）。
 *  L5. 稳定率做拉普拉斯平滑 (ok+1)/(n+2)：旧版冷启动 1 次成功=1.0、1 次失败=0.0，
 *      权重 50 时一次波动就吃掉 50 分，前几轮决策抖得厉害。
 *  L6. 探测端点回退：provider 型节点先试 healthcheck 端点，失败自动回退 /proxies/{id}/delay
 *      并记住有效端点（已实测 /proxies/{叶子}/delay 恒 200）。
 *  L7. 全池不可用时明确提示一次（旧版完全静默，用户会以为插件卡死）。
 *  L8. onReady 改为同步判断（核心已在运行就立即接管，否则交给 onCoreStarted）：
 *      去掉旧版 12 秒轮询，也让「启动成功」能真实反映到角标。
 *  L9. 切换失败提示指纹去重（旧版持续失败会刷屏）。
 *  L10. 「惩罚值」列改显示衰减后的实际生效值（旧版显示原始值，与分数口径不一致，调参会误判）。
 *
 * 第 3.1 轮（v1.4 · 回归修复）：
 *  R1. ★修 L3 引进的回归 —— 「弹窗关掉后再点 ✨ 打不开」。L3 为了不漏定时器把 modal 改成
 *      「复用同一个实例」，但宿主实例是一次性的（见 L3 注释里的实证），关掉后 open() 无效。
 *      现在改回「每次新建」，并改用宿主回调（afterClose / afterDestroy）来清刷新定时器 ——
 *      按钮、遮罩、ESC 三条关闭路径都会走到，比包装 close() 更全（遮罩关闭根本不经过 return 的方法）。
 *  R2. onRun 加异常保护：生成弹窗失败时复位「已打开」标志并提示，不再把异常抛回宿主。
 *
 * 第 4 轮（v1.5 · M 批 —— 内存与开销，针对「开启插件占用内存变大」）：
 *  M1. ★数据容器 ref → shallowRef。`managers = ref([])` 会触发 Vue 的**深度响应式代理**：
 *      239 个节点对象、它们共用的 options、以及每个属性的依赖收集表会被整棵代理一遍。
 *      UI 本来就是靠版本号驱动的，这个代理纯属白付。实测（_tools/mem-bench.cjs，真 @vue/reactivity）：
 *      常驻堆 2.23MB → 0.24MB；属性读取不再过 Proxy trap，会话 CPU 956ms → 121ms。
 *  M2. ★UI 改为「数据版本驱动」，**彻底去掉 2 秒刷新定时器**。旧版每帧都重建全部行数据
 *      （239 节点 × 11 列），而巡检 120 秒才产生一次新数据 ⇒ 60 帧里 59 帧白干。
 *      实测新建行对象 28919 → 478（降 60 倍），分配峰值 33.8MB → 8.0MB，CPU 121ms → 2ms。
 *      ★两个副作用已写进使用说明：依赖时间流逝的显示（相对时间、衰减后惩罚值）不再自己走；
 *        表格在数据变化时**立即**更新（比原来的 2 秒轮询更及时）。
 *  M3. ★stop() 清空 managers。旧版停止后 239 个节点对象仍被 managers.value 抓着 ⇒
 *      「停用插件后内存不回落」。现在停止即释放（停止态本来就不显示表格）。
 *  M4. notifyOnce 的内存指纹加上限（旧版是无界 Set）。
 *  M5. 行数据构建抽成模块顶层的纯函数 buildRowSets()：可单测，也是内存基准的复用点。
 *
 * 第 5 轮（v1.6 · 日常长期运行优化）：
 *  N1. 惩罚衰减参数保持「每秒」语义，但把默认值从 0.05 调整为 0.002，避免失败惩罚几十秒内
 *      几乎归零；现有自定义预设中的 penaltyDecayRate 也应同步调整。
 *  N2. 多测速地址改为「一次启动选定、整个监测会话固定」，避免跨轮 EWMA 混入不同 URL 的延迟基线。
 *  N3. 增加两级检测：全节点竞争检测仍按 MonitoringInterval 执行；当前节点增加独立快速健康检测，
 *      默认每 30 秒检测一次，连续 2 次失败立即进入救火切换，但仍受每小时最大切换次数限制。
 *  N4. 新节点至少成功测速 2 次后才进入候选池，避免单次偶然低延迟直接抢走当前节点。
 *  N5. syncNodes 按节点 ID/探测端点比较，保留历史指标；节点删除、组消失、provider 端点变化时正确清理/重置状态。
 *  N6. Start 真正幂等；onConfigure 显式强制重新应用配置。
 *  N7. 宿主切换调用失败立即返回，不再无意义等待 2.4 秒的回读确认。
 *
 * 注意：onReady / onCoreStarted / onCoreStopped 需要注册表 triggers 里声明才会被宿主调用，
 *       请在 App 内「插件 → 编辑 → 触发器」勾选 on::ready / on::core::started / on::core::stopped。
 */

const SPS_TAG = '[节点智能切换]'
const SPS_NOTIFY_KEY = 'smart-proxy-switcher.notified.v1'
const UI_TITLE = '节点智能切换'

/* 插件 status 语义（宿主用 {1:'greenyellow', 2:'red'} 着色，且 !==0 才显示圆点） */
const STATUS_RUNNING = 1
const STATUS_STOPPED = 0
const STATUS_ERROR = 2

/* ---------- 预设 JSON 的数值白名单：非法值一律回退默认，避免 NaN 静默改变决策 ---------- */
const NUM_SPEC = {
  ewmaAlpha: { def: 0.3, min: 0.05, max: 1 },
  failureThreshold: { def: 4, min: 1, max: 50, int: true },
  circuitBreakerTimeout: { def: 120000, min: 5000, max: 3600000 },
  penaltyIncrement: { def: 5, min: 0, max: 1000 },
  // 每秒指数衰减速率；0.002 的半衰期约 5.8 分钟
  penaltyDecayRate: { def: 0.002, min: 0, max: 1 },
  priorityWeight: { def: 1, min: 0, max: 100 },
  latencyWeight: { def: 100, min: 0, max: 1000 },
  penaltyWeight: { def: 1, min: 0, max: 100 },
  hysteresisMargin: { def: 20, min: 1, max: 10000 }, // ← 单位是「毫秒」，不是分数
  stabilityWeight: { def: 50, min: 0, max: 1000 },
}

const PRESET_KEY = { Stable: 'StableMode', LatencyFirst: 'LatencyFirstMode', Custom: 'CustomMode' }
const STABILITY_WINDOW = 20
const WARMUP_SUCCESS_SAMPLES = 2
const CURRENT_CHECK_INTERVAL_DEFAULT = 30 * 1000
const CURRENT_FAILURE_THRESHOLD_DEFAULT = 2
const BUILTIN_NAME_RE = /^(DIRECT|REJECT|REJECT-DROP|PASS|COMPATIBLE|GLOBAL)$/i
const DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204'

const clampNum = (value, spec) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return spec.def
  const x = Math.min(spec.max, Math.max(spec.min, n))
  return spec.int ? Math.round(x) : x
}

/**
 * 同一个提示只弹一次。
 * 指纹同时落内存与 localStorage：localStorage 不可用（隐私模式等）时，至少同一会话内不刷屏。
 */
const notifyOnce = (fingerprint, emit) => {
  if (notifyOnce.memory.has(fingerprint)) return false
  notifyOnce.memory.add(fingerprint)
  // 长期运行不该无界增长：超上限就按插入序丢掉最早的一批
  if (notifyOnce.memory.size > NOTIFY_MEMORY_CAP) {
    let drop = notifyOnce.memory.size - NOTIFY_MEMORY_CAP
    for (const key of notifyOnce.memory) {
      if (drop-- <= 0) break
      notifyOnce.memory.delete(key)
    }
  }
  try {
    const store = JSON.parse(localStorage.getItem(SPS_NOTIFY_KEY) || '{}')
    if (store[fingerprint]) return false
    store[fingerprint] = Date.now()
    const keys = Object.keys(store)
    if (keys.length > 200) {
      keys
        .sort((a, b) => store[a] - store[b])
        .slice(0, keys.length - 200)
        .forEach((k) => delete store[k])
    }
    localStorage.setItem(SPS_NOTIFY_KEY, JSON.stringify(store))
  } catch (e) {
    /* localStorage 不可用：内存指纹已经挡住重复，这里静默即可 */
  }
  emit()
  return true
}
notifyOnce.memory = new Set()
const NOTIFY_MEMORY_CAP = 500

/**
 * ★ UI 的唯一刷新信号（取代 v1.4 的「每 2 秒 setInterval + refresh.value++」）。
 * 面板打开时由 openUI 注入一个把 dataVersion 加一的函数；面板关掉就置空。
 * 所以：① 面板没开时累加是空操作；② 数据一变**立即**反映到表格，不用等下一跳。
 */
let pushDataVersion = null
const notifyDataChanged = () => {
  if (pushDataVersion) pushDataVersion()
}

/**
 * 把 manager 列表拍成表格行数据（每行 11 列，与 columns 一一对应）。
 * 纯函数：只读不写、不碰响应式，所以既能给 UI 复用，也能被 _tools/mem-bench.cjs 直接加载做内存基准。
 * ⚠ 改 UI 的列（增删键）时，同步改 _tools/mem-bench.cjs 里的 EACH_HAS_11_COLS 与内联副本。
 */
const buildRowSets = (managers, now) =>
  managers.map((manager) => ({
    group: manager.group,
    rows: manager.proxies.map((proxy) => {
      let testHost = '-'
      try {
        testHost = proxy.lastTestUrl ? new URL(proxy.lastTestUrl).hostname : '-'
      } catch (e) {
        testHost = '-'
      }
      return {
        _selected: !!(manager.current && manager.current.id === proxy.id),
        id: proxy.id,
        state: proxy.state,
        lastDelay: Number.isFinite(proxy.lastDelay) ? proxy.lastDelay.toFixed(2) + 'ms' : '-',
        ewmaLatency: Number.isFinite(proxy.ewmaLatency) ? proxy.ewmaLatency.toFixed(2) + 'ms' : '-',
        testHost,
        score: proxy.getScore().toFixed(2),
        failureCount: proxy.failureCount,
        // 与分数同口径：显示衰减后的实际生效值，避免按原始值调参
        penalty: proxy.decayedPenalty(now).toFixed(2),
        isAvailable: proxy.state === 'CLOSED' ? '✅' : proxy.state === 'HALF_OPEN' ? '🟡' : '❌',
        lastPenaltyUpdate: proxy.lastPenaltyUpdate,
        nextAttempt: proxy.nextAttempt,
      }
    }),
  }))

const readPreset = (config, presetName) => {
  const raw = config[PRESET_KEY[presetName]]
  let obj = {}
  if (typeof raw === 'string' && raw.trim()) {
    try {
      obj = JSON.parse(raw)
    } catch (e) {
      console.warn(SPS_TAG, `预设【${presetName}】的 JSON 解析失败，本次改用内置默认值：`, e.message || e)
      obj = {}
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw
  }
  const out = {}
  for (const key of Object.keys(NUM_SPEC)) out[key] = clampNum(obj[key], NUM_SPEC[key])
  return out
}

const isSingBox = () => String((Plugins && Plugins.APP_TITLE) || '').includes('SingBox')

/** 从运行期 profile 取 clash_api 端口与密钥；任何异常都退回默认端口，不阻断插件 */
const getApiBase = () => {
  const fallbackPort = isSingBox() ? 20123 : 20113
  let port = fallbackPort
  let secret = ''
  try {
    const { currentProfile: profile } = Plugins.useProfilesStore()
    if (profile) {
      const ctrl = isSingBox() ? profile.experimental && profile.experimental.clash_api && profile.experimental.clash_api.external_controller : profile.advancedConfig && profile.advancedConfig['external-controller']
      if (ctrl) port = Number(String(ctrl).split(':').pop()) || fallbackPort
      secret = isSingBox() ? (profile.experimental && profile.experimental.clash_api && profile.experimental.clash_api.secret) || '' : (profile.advancedConfig && profile.advancedConfig.secret) || ''
    }
  } catch (e) {
    console.warn(SPS_TAG, '读取内核凭据失败，使用默认端口：', e.message || e)
  }
  return { base: 'http://127.0.0.1:' + port, bearer: String(secret || '') }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 返回 0 表示没拿到有效延迟（调用方按失败处理） */
const probeDelay = async (path, testUrl, timeoutMs) => {
  const { base, bearer } = getApiBase()
  const qs = new URLSearchParams({ url: testUrl, timeout: String(timeoutMs) })
  const headers = bearer ? { Authorization: 'Bearer ' + bearer } : {}
  const ctrl = new AbortController()
  const guard = setTimeout(() => ctrl.abort(), timeoutMs + 3000)
  try {
    const res = await fetch(base + path + '?' + qs.toString(), { method: 'GET', headers, signal: ctrl.signal })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    const delay = Number(data && data.delay)
    return Number.isFinite(delay) && delay > 0 ? delay : 0
  } finally {
    clearTimeout(guard)
  }
}

const delayPathOf = (id) => '/proxies/' + encodeURIComponent(id) + '/delay'

/**
 * 推导某个策略组下真正可以测速的「叶子节点」。
 * 返回 null 表示组不存在 / 不是可接管的分组；返回 [] 表示组为空。
 * url = 首选探测端点；altUrl = 回退端点（provider 分支实测不可达时用 /proxies/{id}/delay 兜底）。
 */
const listNodes = (kernelApi, groupName) => {
  const group = kernelApi && kernelApi.proxies && kernelApi.proxies[groupName]
  if (!group || !Array.isArray(group.all)) return null
  return group.all
    .filter((id) => id && id !== groupName && !BUILTIN_NAME_RE.test(id))
    .map((id) => ({ id, node: kernelApi.proxies[id] }))
    .filter(({ node }) => node && !Array.isArray(node.all)) // 排除子组，别把整组当节点测
    .map(({ id, node }) => {
      const direct = delayPathOf(id)
      const viaProvider = node.provider ? '/providers/proxies/' + encodeURIComponent(node.provider) + '/' + encodeURIComponent(id) + '/healthcheck' : null
      return { id, group: groupName, url: viaProvider || direct, altUrl: viaProvider ? direct : null }
    })
}

/** @type {EsmPlugin} */
export default (Plugin) => {
  const { ref, shallowRef } = Vue

  /**
   * ★ 必须是 shallowRef（M1）。ref 会对数组做**深度响应式代理**：239 个节点对象、它们共用的
   * options、以及每个属性的依赖收集表会被整棵代理一遍。实测（239 节点）常驻堆多 2MB，
   * 且巡检里每次读属性都要多过一层 Proxy trap。UI 由下面的 dataVersion 驱动，不吃深层响应式。
   */
  const managers = shallowRef([])
  const isRunning = ref(false)
  /** UI 的唯一刷新信号：只在数据真的变了时才 +1 */
  const dataVersion = ref(0)

  /** 只做校验与构建，不碰任何运行态 —— 配置写错时正在跑的那一轮完全不受影响 */
  const build = (cfg, kernelApi) => {
    const presetName = String(cfg.Preset || 'Stable')
    if (!PRESET_KEY[presetName]) throw new Error('预设使用场景不存在，请检查插件配置（当前值：' + presetName + '）')
    if (!kernelApi.running) throw new Error('核心未运行，无法启动监测')

    const requested = (Array.isArray(cfg.IncludeGroup) ? cfg.IncludeGroup : []).map((v) => String(v).trim()).filter(Boolean)
    if (requested.length === 0) throw new Error('「应用智能切换的策略组」是空的，请先填写要接管的策略组名称')
    const preset = readPreset(cfg, presetName)
    const options = Object.assign({}, preset, {
      monitorIntervalMs: clampNum(cfg.MonitoringInterval, { def: 120000, min: 5000, max: 3600000 }),
      probeTimeoutMs: clampNum(cfg.RequestTimeout, { def: 10000, min: 1000, max: 60000 }),
      currentCheckIntervalMs: clampNum(cfg.CurrentCheckInterval, {
        def: CURRENT_CHECK_INTERVAL_DEFAULT,
        min: 10000,
        max: 600000,
      }),
      currentFailureThreshold: clampNum(cfg.CurrentFailureThreshold, {
        def: CURRENT_FAILURE_THRESHOLD_DEFAULT,
        min: 1,
        max: 5,
        int: true,
      }),
      switchCooldownMs: clampNum(cfg.SwitchCooldown, { def: 300000, min: 0, max: 3600000 }),
      maxSwitchPerHour: clampNum(cfg.MaxSwitchPerHour, { def: 10, min: 1, max: 200, int: true }),
      concurrency: clampNum(cfg.ConcurrencyLimit, { def: 20, min: 1, max: 50, int: true }),
      testUrls: (Array.isArray(cfg.TestUrlList) ? cfg.TestUrlList : []).filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim())),
      stabilityWindow: STABILITY_WINDOW,
    })

    const groups = []
    const missing = []
    for (const name of requested) {
      const nodes = listNodes(kernelApi, name)
      if (nodes === null) {
        missing.push(name)
        continue
      }
      if (nodes.length === 0) {
        missing.push(name + '(组内没有可测速节点)')
        continue
      }
      groups.push({ name, nodes })
    }
    if (groups.length === 0) {
      throw new Error('未匹配到任何可接管的策略组，请检查「应用智能切换的策略组」里的名称与配置完全一致')
    }
    return { presetName, options, groups, missing }
  }

  const apply = (built) => {
    stop()
    managers.value = built.groups.map(({ name, nodes }) => new ProxyManager(name, nodes, built.options))
    managers.value.forEach((manager) => manager.startMonitoring())
    isRunning.value = true
    notifyDataChanged()
  }

  const start = (config, force = false) => {
    // 普通 Start/onReady/onCoreStarted 已在运行时不重复重建；onConfigure 显式 force 才重新应用配置。
    if (!force && isRunning.value) return STATUS_RUNNING

    const cfg = config || Plugin
    const built = build(cfg, Plugins.useKernelApiStore())
    apply(built)

    console.log(SPS_TAG, `启动监测：预设=${built.presetName}，组=${built.groups.map((g) => g.name + '(' + g.nodes.length + ')').join(' / ')}，` + `间隔=${built.options.monitorIntervalMs}ms，切换阈值=${built.options.hysteresisMargin}ms`)

    if (built.missing.length) {
      console.warn(SPS_TAG, '以下名称未匹配到策略组，已跳过：', built.missing.join(' / '))
      notifyOnce('missing-group:' + built.missing.join('|'), () => Plugins.message.info('以下策略组名未匹配，已跳过：' + built.missing.join(' / ')))
    }
    return STATUS_RUNNING
  }

  const stop = () => {
    managers.value.forEach((manager) => manager.stopMonitoring())
    // ★ M3：必须清空。否则停止后这 239 个节点对象（连同各自的指标、滑动窗口）仍被
    //   managers.value 抓着不放 —— 用户看到的就是「停用插件后内存不回落」。
    //   停止态本来就不显示表格（模板里 v-if="!isRunning" 走 Empty 分支），清空是安全的。
    managers.value = []
    isRunning.value = false
    notifyDataChanged()
    return STATUS_STOPPED
  }

  /** 校验失败时：旧配置还在跑就别把角标变红 */
  const failStatus = () => (isRunning.value ? STATUS_RUNNING : STATUS_ERROR)

  /**
   * ★ 宿主 Plugins.modal 的实例是「一次性」的，绝不能复用（v1.3 初版在这里踩过，
   *   症状：弹窗关掉之后再点 ✨ 打不开）。实证来自宿主产物 data/rolling-release/assets/index-<hash>.js：
   *   ① 内层 modal 组件的 `destroyOnClose` 默认 true，close 分支写成
   *      `a.destroyOnClose && (a.afterDestroy?.(), ue())` ⇒ **每次关闭都会调用 afterDestroy**；
   *   ② 外层包装 Jd 把弹窗做成 `div#Modal-xxx` 挂在 body 上，并在自己的 afterDestroy 里
   *      `Ee(null, r); r.remove()` ⇒ **关闭即把 Teleport 目标从文档里摘掉**；
   *   ③ 实例上的 `open: () => (n.value = !0)` 只改内部状态，容器已不在文档 ⇒ 再开也是空白。
   *   宿主自己的两处用法（Ctrl+Shift+P 命令面板、快捷键提示）也都是「每次新建 + afterDestroy 置空引用」。
   * 所以这里：每次点 ✨ 都新建实例；刷新定时器挂 afterClose / afterDestroy 清理 ——
   * 这样按钮、遮罩、ESC 三条关闭路径都能清掉（遮罩关闭根本不经过这里 return 出去的方法）。
   */
  let uiOpen = false

  /**
   * 面板是否还挂在文档上。宿主给每个弹窗建 `div#Modal-xxx` 并写 `dataset.title = config.title`，
   * 关闭时在自己的 afterDestroy 里 `r.remove()` 掉。
   * 用 DOM 兜底比只信标志安全：标志万一漏复位就退化成「面板再也打不开」；
   * 这里判断不了最多是重复新建、多叠一层（可用）。判断不了时返回 false ⇒ 走新建。
   */
  const uiAlive = () => {
    try {
      return !!document.querySelector('div[data-title="' + UI_TITLE + '"]')
    } catch (e) {
      return false
    }
  }

  const openUI = () => {
    if (uiOpen && uiAlive()) return null // 已经开着，再点 ✨ 不叠第二层

    /**
     * ★ M2：把「数据版本」接到响应式上 —— 面板存在期间才接，关掉即断开。
     * v1.4 这里是 `setInterval(() => refresh.value += 1, 2000)`：不管数据有没有变都重绘整张表，
     * 而巡检 120 秒才产生一次新数据 ⇒ 每 60 帧有 59 帧是白干（实测新建行对象降 60 倍就是这么来的）。
     * 改法顺带消掉了整整一类问题：**没有定时器，就不存在定时器泄漏**。
     */
    pushDataVersion = () => {
      dataVersion.value += 1
    }
    // 幂等：宿主在不同关闭路径下触发的回调不同，两个都挂上兜住
    const onClosed = () => {
      uiOpen = false
      pushDataVersion = null
    }

    const component = {
      template: `
    <Card>
      <template #title-suffix>
        <div class="font-bold">
          运行状态：{{ isRunning ? '运行中' : '已停止' }}{{ roundInfo ? ' · ' + roundInfo : '' }}{{ lastSwitchText ? ' · ' + lastSwitchText : '' }}
        </div>
      </template>
      <template #extra>
        <Button v-if="isRunning" type="primary" icon="pause" @click="handleStop()">停止</Button>
        <Button v-else type="primary" icon="play" @click="handleStart()">启动</Button>
      </template>
      <Empty v-if="!isRunning" />
      <Tabs v-else :items="tabs" v-model:active-key="tab" tabPosition="top" />
    </Card>`,
      setup() {
        const { h, ref, computed, watch, resolveComponent, onUnmounted } = Vue

        /**
         * ★ M2 的核心：数据版本门控。
         * 版本号没变就直接返回**上一次那批行对象**（同一个引用）⇒ 下面 tabs 也返回同一个数组
         * ⇒ 宿主 Tabs/Table 拿到的 props 引用没变 ⇒ 整张表跳过 diff 与重渲染。
         * 版本号变了才重建行数据，所以「数据一变，表格立刻就变」，比原来的 2 秒轮询更及时。
         */
        let cachedVersion = -1
        let cachedSets = null
        const rowSets = computed(() => {
          const v = dataVersion.value
          if (v === cachedVersion && cachedSets) return cachedSets
          cachedVersion = v
          cachedSets = buildRowSets(managers.value, Date.now())
          return cachedSets
        })

        const columns = [
          {
            title: '节点名',
            key: 'id',
            align: 'center',
            customRender: ({ value, record }) => {
              if (!record._selected) return value
              return h(resolveComponent('Tag'), { color: 'green' }, () => value)
            },
          },
          { title: '分数', key: 'score', align: 'center', sort: (a, b) => Number(a.score) - Number(b.score) },
          { title: '当前延迟', key: 'lastDelay', align: 'center' },
          { title: '测速地址', key: 'testHost', align: 'center' },
          { title: 'EWMA平滑延迟', key: 'ewmaLatency', align: 'center' },
          { title: '失败次数', key: 'failureCount', align: 'center' },
          { title: '惩罚值(衰减后)', key: 'penalty', align: 'center' },
          {
            title: '更新时间',
            key: 'lastPenaltyUpdate',
            align: 'center',
            customRender: ({ value }) => Plugins.formatRelativeTime(value),
          },
          {
            title: '下次检测时间',
            key: 'nextAttempt',
            align: 'center',
            customRender: ({ value }) => (value ? Plugins.formatRelativeTime(value) : '-'),
          },
          {
            title: '断路器',
            key: 'state',
            align: 'center',
            customRender: ({ value }) => {
              switch (value) {
                case 'CLOSED':
                  return '🟢 正常'
                case 'OPEN':
                  return '🔴 故障'
                case 'HALF_OPEN':
                  return '🟡 检测中'
                default:
                  return '❓未知'
              }
            },
          },
          { title: '可用性', key: 'isAvailable', align: 'center' },
        ]

        const tab = ref(null)
        const tabs = computed(() =>
          rowSets.value.map((item) => ({
            key: item.group,
            tab: item.group,
            component: () => h(resolveComponent('Table'), { dataSource: item.rows, columns }),
          })),
        )
        // 组列表是异步出现 / 会被增删的：不能在校验期定死 tab，也要在 tab 失效时重置。
        // 只依赖「组名列表」而不是整批行数据 —— 数据刷新时不必重跑这段。
        watch(
          () => rowSets.value.map((item) => item.group),
          (names) => {
            if (names.length === 0) {
              tab.value = null
              return
            }
            if (!names.includes(tab.value)) tab.value = names[0]
          },
          { immediate: true },
        )

        const lastSwitchText = computed(() => {
          dataVersion.value // 跟随数据版本更新
          const info = managers.value
            .map((manager) => manager.lastSwitchInfo)
            .filter(Boolean)
            .sort((a, b) => b.at - a.at)[0]
          if (!info) return ''
          return '上次切换：' + info.from + ' → ' + info.to + '（' + info.reason + '）'
        })

        // 实际一轮花了多久 —— 比配置的「检测时间间隔」更有参考价值
        const roundInfo = computed(() => {
          dataVersion.value // 跟随数据版本更新
          const costs = managers.value.map((manager) => manager.lastRoundCostMs).filter((v) => v > 0)
          if (costs.length === 0) return ''
          return '上轮耗时 ' + (Math.max.apply(null, costs) / 1000).toFixed(1) + 's'
        })

        // 组件真被卸载时也清一次（幂等），不依赖宿主一定回调 afterDestroy
        if (typeof onUnmounted === 'function') onUnmounted(onClosed)

        return {
          isRunning,
          tab,
          tabs,
          lastSwitchText,
          roundInfo,
          handleStart() {
            try {
              start()
            } catch (error) {
              Plugins.message.error(error.message || String(error))
            }
          },
          handleStop() {
            stop()
          },
        }
      },
    }

    const modal = Plugins.modal(
      {
        title: UI_TITLE,
        maskClosable: true,
        submit: false,
        width: '90',
        height: '90',
        cancelText: 'common.close',
        afterClose: onClosed, // 正常关闭
        afterDestroy: onClosed, // destroyOnClose 默认 true ⇒ 任何关闭都会走到这里
      },
      { default: () => Vue.h(component) },
    )

    uiOpen = true
    modal.open()
    return modal
  }

  return {
    onRun: () => {
      try {
        openUI() // 内部已调 open()：宿主实例是一次性的，每次点 ✨ 都要新建
      } catch (e) {
        uiOpen = false
        console.warn(SPS_TAG, '打开面板失败：', e && e.message ? e.message : e)
        Plugins.message.error('打开面板失败：' + (e && e.message ? e.message : e))
      }
    },
    onReady: () => {
      // 核心已在运行时立即接管；还没起来就交给 onCoreStarted。
      // 不做异步轮询：钩子返回值要能真实反映状态，异步返回等于角标永远是「未运行」。
      try {
        if (!Plugins.useKernelApiStore().running) {
          console.log(SPS_TAG, 'onReady：核心尚未运行，等待 onCoreStarted 接管')
          return
        }
        const r = start()
        console.log(SPS_TAG, 'onReady：已自动接管')
        return r
      } catch (e) {
        console.warn(SPS_TAG, 'onReady：接管失败，', e.message || e)
        return failStatus()
      }
    },
    onConfigure: (config) => {
      try {
        return start(config, true)
      } catch (e) {
        Plugins.message.error(e.message || String(e))
        return failStatus()
      }
    },
    onCoreStarted: () => {
      try {
        const r = start()
        console.log(SPS_TAG, 'onCoreStarted：已自动接管')
        return r
      } catch (e) {
        console.warn(SPS_TAG, 'onCoreStarted：接管失败，', e.message || e)
        return failStatus()
      }
    },
    onCoreStopped: () => stop(),
    onDispose: () => stop(),
    Start: () => {
      try {
        return start()
      } catch (e) {
        Plugins.message.error(e.message || String(e))
        return failStatus()
      }
    },
    Stop: () => stop(),
  }
}

class ProxyServer {
  constructor(id, url, group, options, altUrl) {
    this.id = id
    this.url = url // 首选探测端点
    this.altUrl = altUrl || null // 回退端点（provider healthcheck 不通时用 /proxies/{id}/delay）
    this.useAlt = false // 回退成功后记住，后续不再白试首选端点
    this.group = group
    this.priority = 1 // 节点权重暂未使用，全设为 1
    this.options = options

    this.ewmaLatency = null // 延迟的 EWMA 平均值
    this.lastDelay = null // 最近一次成功延迟
    this.lastTestUrl = ''
    this.successSamples = 0 // 成功测速样本数，至少达到 WARMUP_SUCCESS_SAMPLES 才允许参与竞选
    this.fastFailureCount = 0 // 当前节点快速健康检查的连续失败次数
    this.failureCount = 0 // 连续失败次数（上限夹取到 failureThreshold）
    this.penalty = 0 // 故障惩罚值
    this.lastPenaltyUpdate = Date.now()
    this.state = 'CLOSED' // CLOSED / OPEN / HALF_OPEN
    this.nextAttempt = 0
    this.recent = [] // 最近 N 次成败，用于滑动窗口稳定率
  }

  // 拉普拉斯平滑：无样本时 0.5，1 次成功 0.67、1 次失败 0.33，
  // 旧版 1.0 / 0.0 的跳变会让权重 50 的稳定率项一次吃掉 50 分，前几轮决策抖动。
  get stability() {
    const ok = this.recent.filter(Boolean).length
    const n = this.recent.length
    return (ok + 1) / (n + 2)
  }

  /** 惩罚值按时间衰减（不写回，纯计算） */
  decayedPenalty(now) {
    // penaltyDecayRate 保持「每秒」语义；v1.6 通过调低默认值解决衰减过快的问题，避免破坏旧配置的单位含义。
    const dt = Math.max(0, (now - this.lastPenaltyUpdate) / 1000)
    return this.penalty * Math.exp(-this.options.penaltyDecayRate * dt)
  }

  recordSuccess(latency) {
    const now = Date.now()
    const alpha = this.options.ewmaAlpha
    this.ewmaLatency = this.ewmaLatency === null ? latency : alpha * latency + (1 - alpha) * this.ewmaLatency
    this.successSamples = Math.min(this.successSamples + 1, WARMUP_SUCCESS_SAMPLES)
    this.fastFailureCount = 0
    this.lastDelay = latency
    this.failureCount = 0
    this.state = 'CLOSED'
    this.penalty = this.decayedPenalty(now)
    this.lastPenaltyUpdate = now
    this.pushRecent(true)
  }

  recordFailure() {
    const now = Date.now()
    this.failureCount = Math.min(this.failureCount + 1, this.options.failureThreshold)
    this.lastDelay = null
    this.penalty = this.decayedPenalty(now) + this.options.penaltyIncrement
    this.lastPenaltyUpdate = now
    this.pushRecent(false)
    if (this.failureCount >= this.options.failureThreshold) {
      this.state = 'OPEN'
      this.nextAttempt = now + this.options.circuitBreakerTimeout
    }
  }

  pushRecent(ok) {
    this.recent.push(ok)
    const cap = this.options.stabilityWindow
    if (this.recent.length > cap) this.recent.splice(0, this.recent.length - cap)
  }

  /** 纯读，无副作用：UI / 评分过程都可能调用它，不能在这里推进状态机 */
  isAvailable() {
    if (this.state === 'CLOSED') return true
    if (this.state === 'OPEN') return Date.now() >= this.nextAttempt
    return true // HALF_OPEN 允许再试一次
  }

  /** 状态推进只在巡检轮里调用 */
  refreshCircuit() {
    if (this.state === 'OPEN' && Date.now() >= this.nextAttempt) this.state = 'HALF_OPEN'
  }

  getScore() {
    // 只有确认健康（CLOSED 且有历史延迟）的节点才参与竞选，避免切到未验证的坏节点
    if (this.state !== 'CLOSED' || this.ewmaLatency === null) return -Infinity
    const now = Date.now()
    const priorityScore = this.options.priorityWeight * this.priority
    const latencyScore = this.options.latencyWeight * (1000 / this.ewmaLatency)
    const stabilityScore = this.options.stabilityWeight * this.stability
    const penaltyScore = this.options.penaltyWeight * this.decayedPenalty(now)
    return priorityScore + latencyScore + stabilityScore - penaltyScore
  }
}

class ProxyManager {
  constructor(group, nodeConfigs, options) {
    this.group = group
    this.lastSwitchTime = 0
    this.switchHistory = []
    this.lastSwitchInfo = null
    this.lastRoundCostMs = 0
    this.switching = false
    this.ticking = false
    this.currentTicking = false
    this.running = false
    this.timer = null
    this.currentTimer = null
    this.current = null
    this.roundTestUrl = DEFAULT_TEST_URL

    this.options = Object.assign(
      {
        ewmaAlpha: 0.3,
        failureThreshold: 4,
        circuitBreakerTimeout: 120 * 1000,
        penaltyIncrement: 5,
        penaltyDecayRate: 0.002,
        priorityWeight: 1.0,
        latencyWeight: 100.0,
        penaltyWeight: 1.0,
        stabilityWeight: 50,
        stabilityWindow: STABILITY_WINDOW,
        hysteresisMargin: 20, // 单位：毫秒（候选要比当前快这么多才切）
        monitorIntervalMs: 120 * 1000,
        probeTimeoutMs: 10 * 1000,
        currentCheckIntervalMs: CURRENT_CHECK_INTERVAL_DEFAULT,
        currentFailureThreshold: CURRENT_FAILURE_THRESHOLD_DEFAULT,
        switchCooldownMs: 10 * 60 * 1000,
        maxSwitchPerHour: 10,
        concurrency: 20,
        testUrls: [],
      },
      options,
    )

    this.proxies = nodeConfigs.map((cfg) => new ProxyServer(cfg.id, cfg.url, group, this.options, cfg.altUrl || null))
  }

  get randomTestUrl() {
    const urls = this.options.testUrls
    if (!Array.isArray(urls) || urls.length === 0) return DEFAULT_TEST_URL
    return urls[Math.floor(Math.random() * urls.length)]
  }

  /** 订阅更新 / 手动增删节点后跟上内核真实列表；同 id 保留历史指标，不然积累的数据会白丢 */
  syncNodes() {
    let kernelApi = null
    let fresh = null
    try {
      kernelApi = Plugins.useKernelApiStore()
      fresh = listNodes(kernelApi, this.group)
    } catch (e) {
      return
    }

    // 核心未运行时，保留当前对象；宿主 onCoreStopped 会随后统一 stop() 清理。
    if (!kernelApi || !kernelApi.running) return

    // 核心正常运行但策略组已经消失：清掉旧节点，避免插件继续持有过期候选。
    if (fresh === null) {
      if (this.proxies.length > 0 || this.current) {
        this.proxies = []
        this.current = null
        console.log(SPS_TAG, `策略组【${this.group}】已不存在，清空插件节点状态`)
        notifyDataChanged()
      }
      return
    }

    // 组确实为空时也要清空；只有「核心重启中」才保留旧状态。
    if (fresh.length === 0) {
      if (this.proxies.length > 0 || this.current) {
        this.proxies = []
        this.current = null
        console.log(SPS_TAG, `策略组【${this.group}】当前为空，清空插件节点状态`)
        notifyDataChanged()
      }
      return
    }

    const keep = new Map(this.proxies.map((p) => [p.id, p]))
    const sameNodes =
      fresh.length === this.proxies.length &&
      fresh.every((n) => {
        const old = keep.get(n.id)
        return old && old.url === n.url && (old.altUrl || null) === (n.altUrl || null)
      })

    if (sameNodes) {
      // 只发生内核列表重排时，复用原 ProxyServer 对象，仅更新数组顺序。
      const reordered = fresh.some((n, i) => this.proxies[i]?.id !== n.id)
      if (reordered) {
        this.proxies = fresh.map((n) => keep.get(n.id))
        notifyDataChanged()
      }
      return
    }

    this.proxies = fresh.map((n) => {
      const old = keep.get(n.id)
      const nextAltUrl = n.altUrl || null
      if (old) {
        // provider 探测端点发生变化时，之前记住的 useAlt 可能已经失效。
        if (old.url !== n.url || (old.altUrl || null) !== nextAltUrl) old.useAlt = false
        old.url = n.url
        old.altUrl = nextAltUrl
        return old
      }
      return new ProxyServer(n.id, n.url, this.group, this.options, nextAltUrl)
    })

    if (this.current && !this.proxies.includes(this.current)) this.current = null
    console.log(SPS_TAG, `策略组【${this.group}】节点列表已同步，当前 ${this.proxies.length} 个节点`)
    notifyDataChanged()
  }

  /**
   * 链式自调度：跑完一轮再等 interval，而不是每 interval 强推一次。
   * 宿主 setIntervalImmediately 是 setInterval —— 单轮耗时 > 间隔时会背靠背连跑，
   * 「间隔」名存实亡且网络/CPU 持续满负荷。
   */
  startMonitoring() {
    this.stopMonitoring()
    this.running = true
    // 一个监测会话固定测速地址；多地址配置只在启动时随机选一次，避免 EWMA 跨 URL 混合。
    this.roundTestUrl = this.randomTestUrl
    this.scheduleNext(0) // 启动后立即跑第一轮全池检测
    this.scheduleCurrentNext(this.options.currentCheckIntervalMs) // 稍后开始当前节点快速检测，避免启动时重复测
  }

  scheduleNext(delayMs) {
    this.timer = setTimeout(async () => {
      if (!this.running) return
      await this.tick()
      if (this.running) this.scheduleNext(this.options.monitorIntervalMs)
    }, delayMs)
  }

  scheduleCurrentNext(delayMs) {
    this.currentTimer = setTimeout(async () => {
      this.currentTimer = null
      if (!this.running) return
      await this.tickCurrent()
      if (this.running) this.scheduleCurrentNext(this.options.currentCheckIntervalMs)
    }, delayMs)
  }

  stopMonitoring() {
    this.running = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.currentTimer !== null) {
      clearTimeout(this.currentTimer)
      this.currentTimer = null
    }
  }

  /** 定时器只挂 tick：守卫覆盖「同步 + 全池探测 + 切换评估」整轮 */
  async tick() {
    if (this.ticking || this.currentTicking) return
    this.ticking = true
    const startedAt = Date.now()
    try {
      this.syncNodes()
      if (this.proxies.length === 0) return

      // 同一监测会话固定测速地址，不再每轮随机。
      await this.checkAll()
      await this.evaluateSwitch()
    } catch (e) {
      console.warn(SPS_TAG, '巡检异常：', e && e.message ? e.message : e)
    } finally {
      this.ticking = false
      const cost = Date.now() - startedAt
      this.lastRoundCostMs = cost
      if (cost > this.options.monitorIntervalMs) {
        console.warn(SPS_TAG, `【${this.group}】单轮耗时 ${Math.round(cost / 1000)}s，已超过检测间隔 ` + `${Math.round(this.options.monitorIntervalMs / 1000)}s，两轮之间的实际间隔会比设定值更长`)
        notifyOnce('slow-round:' + this.group, () => Plugins.message.info(`策略组【${this.group}】单轮检测耗时已超过设定间隔，实际切换会比设定更慢。` + '可调大「检测时间间隔」或调高「并发检测数量」'))
      }
      notifyDataChanged()
    }
  }

  /** 单节点统一探测逻辑：首选端点失败时回退，并记住可用端点。 */
  async probeOne(proxy, testUrl, timeoutMs) {
    proxy.lastTestUrl = testUrl
    const primary = proxy.useAlt && proxy.altUrl ? proxy.altUrl : proxy.url
    const fallback = proxy.altUrl && proxy.altUrl !== primary ? proxy.altUrl : null

    let delay = 0
    try {
      delay = await probeDelay(primary, testUrl, timeoutMs)
    } catch (e) {
      delay = 0
    }
    if (delay > 0) return delay

    if (fallback) {
      try {
        delay = await probeDelay(fallback, testUrl, timeoutMs)
      } catch (e) {
        delay = 0
      }
      if (delay > 0) {
        proxy.useAlt = true
        return delay
      }
    }

    return 0
  }

  async checkAll() {
    for (const proxy of this.proxies) proxy.refreshCircuit()

    // 当前节点由快速健康检测负责，正常全池竞争轮跳过它，避免重复探测。
    this.syncCurrentFromKernel()
    const currentId = this.current && this.current.id
    const targets = this.proxies.filter((proxy) => proxy.id !== currentId && proxy.isAvailable())

    const testUrl = this.roundTestUrl
    const timeoutMs = this.options.probeTimeoutMs

    const checkOne = async (proxy) => {
      const delay = await this.probeOne(proxy, testUrl, timeoutMs)
      if (delay > 0) {
        proxy.recordSuccess(delay)
        return
      }
      proxy.recordFailure()
    }

    const concurrency = Math.max(1, Number(this.options.concurrency) || 1)
    await Plugins.asyncPool(concurrency, targets, checkOne)
  }

  /** 两级检测的快速层：只检查当前正在使用的节点。 */
  async tickCurrent() {
    if (!this.running || this.currentTicking || this.ticking || this.switching) return

    this.currentTicking = true
    try {
      this.syncCurrentFromKernel()
      const current = this.current
      if (!current) return

      current.refreshCircuit()
      // 旧当前节点处于 OPEN 且熔断时间未到：等待 circuit breaker 到期，不浪费快速检测。
      if (current.state === 'OPEN') return

      const delay = await this.probeOne(current, this.roundTestUrl, this.options.probeTimeoutMs)

      if (delay > 0) {
        current.fastFailureCount = 0
        current.recordSuccess(delay)
        notifyDataChanged()
        return
      }

      current.fastFailureCount += 1
      current.recordFailure()

      const shouldFailover = current.state !== 'CLOSED' || current.fastFailureCount >= this.options.currentFailureThreshold

      if (shouldFailover) {
        current.state = 'OPEN'
        current.nextAttempt = Date.now() + this.options.circuitBreakerTimeout
        await this.failoverFromCurrent(`当前节点快速检测连续失败 ${current.fastFailureCount} 次`)
      }

      notifyDataChanged()
    } catch (e) {
      console.warn(SPS_TAG, `【${this.group}】当前节点快速检测异常：`, e && e.message ? e.message : e)
    } finally {
      this.currentTicking = false
    }
  }

  /** 回读内核真实当前节点；失败返回 null */
  readLiveCurrent() {
    try {
      const kernelApi = Plugins.useKernelApiStore()
      const group = kernelApi.proxies[this.group]
      if (!group) return null
      return this.proxies.find((proxy) => proxy.id === group.now) || null
    } catch (e) {
      return null
    }
  }

  /** 同步内核当前节点；用户手动切换后尊重新选择，并清掉新当前节点的快速失败计数。 */
  syncCurrentFromKernel() {
    const live = this.readLiveCurrent()
    if (live && (!this.current || live.id !== this.current.id)) {
      this.current = live
      live.fastFailureCount = 0
      return true
    }
    return false
  }

  /** 健康节点池：断路器闭合、已拿到延迟、且至少完成两次成功测速暖机。 */
  healthyPool() {
    return this.proxies.filter((proxy) => proxy.state === 'CLOSED' && proxy.ewmaLatency !== null && proxy.successSamples >= WARMUP_SUCCESS_SAMPLES)
  }

  pickBestIn(pool) {
    let best = null
    let bestScore = -Infinity
    for (const proxy of pool) {
      const score = proxy.getScore()
      if (score > bestScore) {
        bestScore = score
        best = proxy
      }
    }
    return best
  }

  canSwitch() {
    const now = Date.now()
    this.switchHistory = this.switchHistory.filter((t) => now - t < 3600000)
    return this.switchHistory.length < this.options.maxSwitchPerHour
  }

  /** 轮询回读：宿主 PUT 返回时 store 里的 now 还没更新，即时断言会误判失败 */
  async waitForCurrent(proxy, tries = 12, gapMs = 200) {
    // 12×200ms = 2.4s：给「切换 + refreshProviderProxies」留足时间。
    // 太短会在慢组上误报「切换未生效」；太长会拖慢失败路径（失败已按目标指纹去重）。
    for (let i = 0; i < tries; i++) {
      const live = this.readLiveCurrent()
      if (live && live.id === proxy.id) return true
      await sleep(gapMs)
    }
    return false
  }

  /** 当前节点故障后的救火切换：绕过普通 cooldown，但仍受每小时最大切换次数限制。 */
  async failoverFromCurrent(reason) {
    const current = this.current
    if (!current || current.state === 'CLOSED') return false

    const pool = this.healthyPool().filter((proxy) => proxy.id !== current.id)
    if (!pool.length) {
      notifyOnce('all-down:' + this.group, () => Plugins.message.info(`策略组【${this.group}】当前没有可用节点（全部熔断或尚未完成暖机），已暂时停止切换`))
      return false
    }

    if (!this.canSwitch()) return false

    const best = this.pickBestIn(pool)
    if (!best) return false
    return await this.switchTo(best, reason)
  }

  async evaluateSwitch() {
    this.syncCurrentFromKernel()

    const pool = this.healthyPool()

    if (!this.current) {
      const best = this.pickBestIn(pool)
      if (best) await this.switchTo(best, '首次接管')
      return
    }

    // 救火：当前节点已熔断 / 还没通过复检 ⇒ 立刻换，不受切换冷却限制（仍受每小时次数限制）
    if (this.current.state !== 'CLOSED') {
      await this.failoverFromCurrent('当前节点已熔断')
      return
    }

    // ★先按延迟筛出「确实更快」的候选，再在其中选综合分最高的。
    // 新节点还需通过 warm-up，因此只有至少 2 次成功测速的健康节点才能参与竞选。
    const margin = this.options.hysteresisMargin
    const faster = pool.filter((p) => p.id !== this.current.id && this.current.ewmaLatency - p.ewmaLatency >= margin)
    const best = this.pickBestIn(faster)

    if (!best || best.id === this.current.id) return
    if (Date.now() - this.lastSwitchTime < this.options.switchCooldownMs) return
    if (!this.canSwitch()) return

    await this.switchTo(best, `快 ${Math.round(this.current.ewmaLatency - best.ewmaLatency)}ms`)
  }

  /** 返回是否真的切换成功；只有确认落地才写冷却与 current */
  async switchTo(proxy, reason) {
    if (!proxy) return false
    if (this.switching) return false
    if (this.current && this.current.id === proxy.id) return false // 已是当前节点：短路，绝不写冷却

    this.switching = true
    const from = (this.current && this.current.id) || '无'
    try {
      const kernelApi = Plugins.useKernelApiStore()
      const group = kernelApi.proxies[proxy.group]
      const target = kernelApi.proxies[proxy.id]
      if (!group || !target) {
        console.warn(SPS_TAG, `跳过切换：组或节点不存在（${proxy.group} / ${proxy.id}）`)
        return false
      }
      if (String(group.type || '').toLowerCase() !== 'selector') {
        console.warn(SPS_TAG, `跳过切换：${proxy.group} 不是 Selector 组（type=${group.type}），宿主会忽略`)
        return false
      }

      try {
        await Plugins.handleUseProxy(group, target)
      } catch (e) {
        const detail = e && e.message ? e.message : String(e)
        console.warn(SPS_TAG, '调用宿主切换失败：', detail)
        notifyOnce('switch-call-fail:' + proxy.group + ':' + proxy.id, () => Plugins.message.info(`策略组【${proxy.group}】调用宿主切换失败（${from} → ${proxy.id}）：${detail}`))
        return false
      }

      const landed = await this.waitForCurrent(proxy)
      if (!landed) {
        notifyOnce('switch-fail:' + proxy.group + ':' + proxy.id, () => Plugins.message.info(`策略组【${proxy.group}】切换未生效（${from} → ${proxy.id}）`))
        return false
      }

      this.current = proxy
      proxy.fastFailureCount = 0
      this.lastSwitchTime = Date.now()
      this.switchHistory.push(Date.now())
      this.lastSwitchInfo = { from, to: proxy.id, reason, at: Date.now() }
      console.log(SPS_TAG, `策略组【${proxy.group}】${from} → ${proxy.id}（${reason}）`)
      notifyDataChanged()
      return true
    } finally {
      this.switching = false
    }
  }
}
