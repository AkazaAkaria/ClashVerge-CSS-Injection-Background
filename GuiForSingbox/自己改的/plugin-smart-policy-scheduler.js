/** @type {EsmPlugin} */
export default (Plugin) => {
  const { ref, computed } = Vue
  const kernelApi = Plugins.useKernelApiStore()

  const HIDDEN_TYPES = new Set(['Direct', 'Reject', 'Block', 'DNS', 'direct', 'reject', 'block', 'dns'])
  const STORAGE_ID = Plugin.id || 'plugin-smart-policy-scheduler'
  const LEGACY_STORAGE_ID = 'plugin-media-unlock-checker'
  const GROUP_ENABLED_KEY = `${STORAGE_ID}:enabled-groups:v2`
  const CUSTOM_CONFIG_KEY = `${STORAGE_ID}:custom-config:v2`
  const LEGACY_GROUP_ENABLED_KEY = `${LEGACY_STORAGE_ID}:enabled-groups:v2`
  const LEGACY_CUSTOM_CONFIG_KEY = `${LEGACY_STORAGE_ID}:custom-config:v2`

  const candidatePoolSwitchMap = new Map()

  // 面板打开时轮询宿主内核「外部变更」的间隔（ms）。宿主自身巡检周期为分钟级，1s 属过度轮询
  const MODAL_SYNC_INTERVAL = 3000

  const DEFAULT_OPTIONS = {
    managedGroups: [],
    monitoringInterval: 900000,
    requestTimeout: 5000,
    concurrencyLimit: 4,
    serviceConcurrency: 2,
    maxCheckNodesPerGroup: 4,
    preserveTopNodes: 4,
    rotateNodesPerCycle: 1,
    groupStartDelay: 1200,
    ewmaAlpha: 0.35,
    failureThreshold: 3,
    circuitBreakerTimeout: 360000,
    penaltyIncrement: 60,
    penaltyDecayRate: 0.00018,
    availabilityWeight: 1000,
    latencyWeight: 22000,
    penaltyWeight: 1,
    minSwitchInterval: 900000,
    hysteresisMargin: 60,
    minSwitchSuccessRatio: 0.45,
    logLimit: 120
  }

  const COMMON_SERVICES = [
    { key: 'gstatic', label: 'Google 204', url: 'https://www.gstatic.com/generate_204', weight: 2 },
    { key: 'cloudflare', label: 'Cloudflare', url: 'https://www.cloudflare.com/cdn-cgi/trace', weight: 1 },
    { key: 'github', label: 'GitHub', url: 'https://github.com', weight: 1 }
  ]

  const SERVICE_PROFILES = {
    default: { label: '通用', services: COMMON_SERVICES },
    GLOBAL: { label: '通用', services: COMMON_SERVICES },
    国外流量: {
      label: '全球',
      services: [
        { key: 'google204', label: 'Google 204', url: 'https://www.gstatic.com/generate_204', weight: 3 },
        { key: 'cloudflare', label: 'Cloudflare', url: 'https://www.cloudflare.com/cdn-cgi/trace', weight: 2 },
        { key: 'github', label: 'GitHub', url: 'https://github.com', weight: 2 }
      ]
    },
    即时通讯: {
      label: '通讯',
      services: [
        { key: 'telegram', label: 'Telegram', url: 'https://telegram.org', weight: 4 },
        { key: 'telegramWeb', label: 'TG Web', url: 'https://web.telegram.org', weight: 3 },
        { key: 'discord', label: 'Discord', url: 'https://discord.com/api/v9/experiments', weight: 3 },
        { key: 'whatsapp', label: 'WhatsApp', url: 'https://www.whatsapp.com', weight: 2 },
        COMMON_SERVICES[0]
      ]
    },
    人工智能: {
      label: 'AI',
      services: [
        { key: 'openai', label: 'OpenAI', url: 'https://chat.openai.com/cdn-cgi/trace', weight: 4 },
        { key: 'openaiApi', label: 'API', url: 'https://api.openai.com/compliance/cookie_requirements', weight: 4 },
        { key: 'gemini', label: 'Gemini', url: 'https://gemini.google.com', weight: 3 },
        { key: 'claude', label: 'Claude', url: 'https://claude.ai/cdn-cgi/trace', weight: 3 },
        COMMON_SERVICES[0]
      ]
    },
    谷歌服务: {
      label: '谷歌',
      services: [
        { key: 'google204', label: 'Google 204', url: 'https://www.gstatic.com/generate_204', weight: 4 },
        { key: 'google', label: 'Google', url: 'https://www.google.com', weight: 3 },
        { key: 'youtube', label: 'YouTube', url: 'https://www.youtube.com/generate_204', weight: 3 },
        { key: 'gemini', label: 'Gemini', url: 'https://gemini.google.com', weight: 2 },
        { key: 'gmail', label: 'Gmail', url: 'https://mail.google.com', weight: 2 }
      ]
    },
    微软服务: {
      label: '微软',
      services: [
        { key: 'msConnect', label: 'MS 204', url: 'https://www.msftconnecttest.com/connecttest.txt', weight: 4 },
        { key: 'microsoft', label: 'Microsoft', url: 'https://www.microsoft.com', weight: 3 },
        { key: 'login', label: 'Login', url: 'https://login.live.com', weight: 3 },
        { key: 'office', label: 'Office', url: 'https://www.office.com', weight: 2 },
        COMMON_SERVICES[1]
      ]
    },
    流媒体: {
      label: '流媒体',
      services: [
        { key: 'netflix', label: 'Netflix', url: 'https://www.netflix.com/title/80018499', weight: 4 },
        { key: 'disney', label: 'Disney+', url: 'https://www.disneyplus.com', weight: 3 },
        { key: 'spotify', label: 'Spotify', url: 'https://spclient.wg.spotify.com/signup/public/v1/account', weight: 3 },
        { key: 'youtube', label: 'YouTube', url: 'https://www.youtube.com/generate_204', weight: 3 },
        COMMON_SERVICES[0]
      ]
    }
  }

  const matchServiceProfile = (name) => {
    if (!name) return SERVICE_PROFILES.default
    if (SERVICE_PROFILES[name]) return SERVICE_PROFILES[name]
    const s = String(name).toLowerCase()
    if (/ai|openai|chatgpt|claude|gemini|copilot|人工智能/.test(s)) return SERVICE_PROFILES.人工智能
    if (/tg|telegram|discord|whatsapp|im|即时通讯|通讯|社交/.test(s)) return SERVICE_PROFILES.即时通讯
    if (/google|youtube|ytb|gmail|谷歌/.test(s)) return SERVICE_PROFILES.谷歌服务
    if (/microsoft|ms|bing|office|live|onedrive|微软/.test(s)) return SERVICE_PROFILES.微软服务
    if (/media|netflix|disney|spotify|hbo|prime|流媒体|影视|视频/.test(s)) return SERVICE_PROFILES.流媒体
    if (/global|proxy|国外|全球|节点/.test(s)) return SERVICE_PROFILES.国外流量
    return SERVICE_PROFILES.default
  }

  const calcLatencyScore = (latency) => {
    if (!Number.isFinite(latency) || latency <= 0) return 0
    if (latency < 120) {
      return 300 - (latency - 50) * 0.28
    } else if (latency < 300) {
      return 280 - (latency - 120) * 0.55
    } else if (latency < 600) {
      return 180 - (latency - 300) * 0.47
    } else {
      return Math.max(-250, 40 - (latency - 600) * 0.6)
    }
  }

  const managers = ref([])
  const isRunning = ref(false)
  const lastError = ref('')
  const viewTick = ref(0)
  const schedulerConfig = ref({ groups: [] })

  const notifyUpdate = () => {
    viewTick.value += 1
  }

  const parseList = (value, fallback = []) => {
    if (!value) return fallback
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
    return String(value).split(/[,\n]/).map((v) => v.trim()).filter(Boolean)
  }

  const isGroupProxy = (name) => Array.isArray(kernelApi.proxies?.[name]?.all)

  const isSelectorGroup = (name) => {
    const proxy = kernelApi.proxies?.[name]
    if (!proxy || !Array.isArray(proxy.all)) return false
    const type = String(proxy.type || '').toLowerCase()
    return type === 'selector' || type === ''
  }

  const isLeafProxy = (id) => {
    const proxy = kernelApi.proxies?.[id]
    if (!proxy || Array.isArray(proxy.all)) return false
    return !HIDDEN_TYPES.has(proxy.type)
  }

  const childGroupsOf = (name) => (kernelApi.proxies?.[name]?.all || []).filter((child) => isGroupProxy(child))

  const hasLeafCandidatePool = (name) => {
    const proxy = kernelApi.proxies?.[name]
    if (!proxy || !Array.isArray(proxy.all)) return false
    if (proxy.all.some((child) => isLeafProxy(child))) return true
    return proxy.all.some((child) => kernelApi.proxies?.[child]?.all?.some((leaf) => isLeafProxy(leaf)))
  }

  const collectOutboundAliases = () => {
    const aliases = new Map()
    const visit = (value) => {
      if (!value) return
      if (Array.isArray(value)) {
        value.forEach(visit)
        return
      }
      if (typeof value !== 'object') return
      if (typeof value.id === 'string' && typeof value.tag === 'string') aliases.set(value.id, value.tag)
      Object.values(value).forEach(visit)
    }
    try {
      visit(Plugins.useProfilesStore().currentProfile?.outbounds)
    } catch (err) {}
    return aliases
  }

  const collectRouteOutbounds = () => {
    const found = new Set()
    const aliases = collectOutboundAliases()
    const add = (value) => {
      if (typeof value !== 'string' || !value) return
      found.add(value)
      if (aliases.has(value)) found.add(aliases.get(value))
    }
    const visit = (value) => {
      if (!value) return
      if (Array.isArray(value)) {
        value.forEach(visit)
        return
      }
      if (typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        if (key === 'outbound' || key === 'final') add(child)
        else visit(child)
      }
    }
    try {
      const route = Plugins.useProfilesStore().currentProfile?.route
      if (route?.final) add(route.final)
      visit(route)
    } catch (err) {}
    return [...found]
  }

  const detectManagedGroups = (fallbackGroups = []) => {
    const groups = Object.keys(kernelApi.proxies || {}).filter((name) => isGroupProxy(name))
    const policyLike = groups.filter((name) => hasLeafCandidatePool(name))
    const routeOutbounds = collectRouteOutbounds().filter((name) => policyLike.includes(name))
    const fallback = fallbackGroups.filter((name) => policyLike.includes(name))
    if (routeOutbounds.length) return [...new Set(routeOutbounds)]
    if (fallback.length) return [...new Set(fallback)]
    return policyLike.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  }

  const serviceKey = (label, index) => `${String(label || 'url').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'url'}-${index}`

  const labelFromUrl = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '').split('.')[0] || 'URL'
    } catch (err) {
      return 'URL'
    }
  }

  const servicesToText = (services = []) =>
    services.map((service) => `${service.label || labelFromUrl(service.url)}|${service.url}|${service.weight || 2}`).join('\n')

  const parseServicesText = (text) =>
    String(text || '')
      .split(/\r?\n/)
      .map((line, index) => {
        const raw = line.trim()
        if (!raw) return null
        const parts = raw.split('|').map((item) => item.trim())
        const url = parts.length >= 2 ? parts[1] : parts[0]
        if (!/^https?:\/\//i.test(url)) return null
        const label = parts.length >= 2 ? parts[0] : labelFromUrl(url)
        const weight = Number(parts[2] || 2)
        return { key: serviceKey(label, index), label, url, weight: Number.isFinite(weight) && weight > 0 ? weight : 2 }
      })
      .filter(Boolean)

  const defaultGroupConfig = (name, enabled = true) => {
    const profile = matchServiceProfile(name)
    return { name, enabled, servicesText: servicesToText(profile.services) }
  }

  const normalizeGroupConfig = (item, fallbackEnabled = true) => {
    const name = String(item?.name || '').trim()
    if (!name) return null
    const fallback = defaultGroupConfig(name, fallbackEnabled)
    return { name, enabled: item.enabled !== false, servicesText: String(item.servicesText || fallback.servicesText) }
  }

  const readStorageJson = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : fallback
    } catch (err) {
      return fallback
    }
  }

  const loadSchedulerConfig = (fallbackGroups = []) => {
    const currentEnabled = readStorageJson(GROUP_ENABLED_KEY, {}) || {}
    const oldEnabled = STORAGE_ID === LEGACY_STORAGE_ID ? {} : readStorageJson(LEGACY_GROUP_ENABLED_KEY, {}) || {}
    const legacyEnabled = { ...oldEnabled, ...currentEnabled }
    const saved = readStorageJson(CUSTOM_CONFIG_KEY, {})
    const oldSaved = STORAGE_ID === LEGACY_STORAGE_ID ? {} : readStorageJson(LEGACY_CUSTOM_CONFIG_KEY, {})
    const source = Array.isArray(saved.groups) ? saved : oldSaved
    const savedGroups = Array.isArray(source.groups)
      ? source.groups.map((item) => normalizeGroupConfig(item, legacyEnabled[item?.name] !== false)).filter(Boolean)
      : []

    const detected = detectManagedGroups(fallbackGroups)
    const savedMap = new Map(savedGroups.map((item) => [item.name, item]))
    const groups = detected.length
      ? detected.map((name) => savedMap.get(name) || defaultGroupConfig(name, legacyEnabled[name] !== false))
      : savedGroups
    return { groups }
  }

  const saveSchedulerConfig = (config) => {
    const groups = (config.groups || []).map((item) => normalizeGroupConfig(item)).filter(Boolean)
    const normalized = { groups }
    schedulerConfig.value = normalized
    localStorage.setItem(CUSTOM_CONFIG_KEY, JSON.stringify(normalized))
    localStorage.setItem(GROUP_ENABLED_KEY, JSON.stringify(Object.fromEntries(groups.map((item) => [item.name, item.enabled !== false]))))
    return normalized
  }

  const getOptions = (config = Plugin) => ({
    ...DEFAULT_OPTIONS,
    managedGroups: parseList(config.ManagedGroups, DEFAULT_OPTIONS.managedGroups),
    monitoringInterval: Number(config.MonitoringInterval || DEFAULT_OPTIONS.monitoringInterval),
    requestTimeout: Number(config.RequestTimeout || DEFAULT_OPTIONS.requestTimeout),
    concurrencyLimit: Number(config.ConcurrencyLimit || DEFAULT_OPTIONS.concurrencyLimit),
    maxCheckNodesPerGroup: Number(config.MaxCheckNodesPerGroup || DEFAULT_OPTIONS.maxCheckNodesPerGroup),
    preserveTopNodes: Number(config.PreserveTopNodes || DEFAULT_OPTIONS.preserveTopNodes),
    rotateNodesPerCycle: Number(config.RotateNodesPerCycle || DEFAULT_OPTIONS.rotateNodesPerCycle),
    minSwitchInterval: Number(config.MinSwitchInterval || DEFAULT_OPTIONS.minSwitchInterval),
    hysteresisMargin: Number(config.HysteresisMargin || DEFAULT_OPTIONS.hysteresisMargin)
  })

  const getServiceProfile = (policyGroup, groupConfig = null) => {
    const base = matchServiceProfile(policyGroup)
    const customServices = parseServicesText(groupConfig?.servicesText)
    return customServices.length ? { label: base.label, services: customServices } : base
  }

  const setupRequestApi = () => {
    // 兜底端口按宿主区分：GUI.for.SingBox 默认 20123，GUI.for.Clash 默认 20113（原写死 9090，两者都不匹配）
    const isSingBox = String(Plugins.APP_TITLE || '').includes('SingBox')
    let base = isSingBox ? 'http://127.0.0.1:20123' : 'http://127.0.0.1:20113'
    let bearer = ''
    try {
      const profile = Plugins.useProfilesStore().currentProfile
      const clash = profile?.clash_api || profile?.experimental?.clash_api
      if (clash?.external_controller) {
        let addr = String(clash.external_controller).trim().replace(/^https?:\/\//i, '')
        if (addr.startsWith('0.0.0.0')) addr = addr.replace(/^0\.0\.0\.0/, '127.0.0.1')
        else if (addr.startsWith(':')) addr = `127.0.0.1${addr}`
        base = `http://${addr}`
      }
      if (clash?.secret) bearer = clash.secret
    } catch (err) {}
    return { base, bearer }
  }

  const requestDelay = async (proxy, url, timeout) => {
    const { base, bearer } = setupRequestApi()
    const params = new URLSearchParams({ url, timeout: String(timeout) })
    const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {}

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout + 3000)

    try {
      const response = await fetch(`${base}/proxies/${encodeURIComponent(proxy)}/delay?${params.toString()}`, {
        headers,
        signal: controller.signal
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.message || response.statusText || 'delay failed')
      const delay = Number(data.delay)
      if (!Number.isFinite(delay) || delay <= 0) throw new Error(data.message || 'delay failed')
      return delay
    } finally {
      clearTimeout(timer)
    }
  }

  const asyncPool = async (limit, list, iterator) => {
    const results = []
    let index = 0
    const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (index < list.length) {
        const i = index++
        try {
          results[i] = await iterator(list[i])
        } catch (err) {
          results[i] = err
        }
      }
    })
    await Promise.all(workers)
    return results
  }

  class NodeHealth {
    constructor(id, options) {
      this.id = id
      this.options = options
      this.service = {}
      this.ewmaLatency = null
      this.failureCount = 0
      this.penalty = 0
      this.state = 'CLOSED'
      this.nextAttempt = 0
      this.lastChecked = 0
      this.lastPenaltyDecay = Date.now()
      this.successRatio = 0
    }

    applyPenaltyDecay() {
      const now = Date.now()
      const elapsed = now - this.lastPenaltyDecay
      if (elapsed > 1000 && this.penalty > 0 && this.options.penaltyDecayRate > 0) {
        this.penalty = Math.max(0, this.penalty * Math.exp(-this.options.penaltyDecayRate * elapsed))
        this.lastPenaltyDecay = now
      }
    }

    isAvailable() {
      const now = Date.now()
      this.applyPenaltyDecay()
      if (this.state === 'OPEN') {
        if (now >= this.nextAttempt) {
          this.state = 'HALF_OPEN'
          return true
        }
        return false
      }
      return true
    }

    record(results, services) {
      const now = Date.now()
      this.applyPenaltyDecay()
      const isFirstSample = this.lastChecked === 0
      this.service = results
      this.lastChecked = now
      const totalWeight = services.reduce((sum, svc) => sum + svc.weight, 0)
      const okWeight = services.reduce((sum, svc) => sum + (results[svc.key]?.ok ? svc.weight : 0), 0)
      const okDelays = services.map((svc) => results[svc.key]?.delay).filter((v) => Number.isFinite(v) && v > 0)
      
      const currentRatio = totalWeight ? okWeight / totalWeight : 0
      // Smooth availability with previous history (75% current + 25% history) to resist single-packet drop
      this.successRatio = isFirstSample ? currentRatio : 0.75 * currentRatio + 0.25 * this.successRatio

      if (okDelays.length) {
        const avg = okDelays.reduce((sum, v) => sum + v, 0) / okDelays.length
        this.ewmaLatency = this.ewmaLatency === null ? avg : this.options.ewmaAlpha * avg + (1 - this.options.ewmaAlpha) * this.ewmaLatency
      }

      if (this.successRatio >= this.options.minSwitchSuccessRatio) {
        this.failureCount = 0
        this.state = 'CLOSED'
        this.penalty *= 0.6
      } else {
        this.failureCount += 1
        this.penalty += this.options.penaltyIncrement
        if (this.failureCount >= this.options.failureThreshold || this.state === 'HALF_OPEN') {
          this.state = 'OPEN'
          this.nextAttempt = now + this.options.circuitBreakerTimeout
        }
      }
    }

    getScore() {
      if (!this.isAvailable()) return -Infinity
      const latencyScore = this.ewmaLatency ? calcLatencyScore(this.ewmaLatency) : 0
      const availabilityScore = this.options.availabilityWeight * this.successRatio
      const halfOpenPenalty = this.state === 'HALF_OPEN' ? 200 : 0
      return availabilityScore + latencyScore - this.penalty * this.options.penaltyWeight - this.failureCount * 20 - halfOpenPenalty
    }
  }

  class SmartPolicyManager {
    constructor(policyGroup, options, onUpdate) {
      this.policyGroup = policyGroup
      this.groupConfig = options.groupConfigMap?.get(policyGroup) || defaultGroupConfig(policyGroup)
      this.profile = getServiceProfile(policyGroup, this.groupConfig)
      this.services = this.profile.services
      this.options = options
      this.onUpdate = onUpdate
      this.routeTarget = ''
      this.candidateGroup = ''
      this.nodes = []
      this.nodeMap = new Map()
      this.timer = null
      this.initialTimer = null
      this.checking = false
      this.switching = false
      this.enabled = this.groupConfig.enabled !== false
      this.current = null
      this.lastSwitchAt = 0
      this.lastReason = ''
      this.lastCheckedAt = 0
      this.scanCursor = 0
      this.lastPlanText = ''
      this.logs = []
    }

    addLog(level, message) {
      const item = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, time: Date.now(), level, message }
      this.logs = [item, ...this.logs].slice(0, this.options.logLimit || 120)
      console.log(`[${Plugin.name}][${this.policyGroup}]`, message)
    }

    startMonitoring(initialDelay = 0) {
      const run = () =>
        this.checkAll().catch((error) => {
          lastError.value = error.message || String(error)
          this.addLog('warn', lastError.value)
          this.onUpdate()
        })
      this.initialTimer = setTimeout(() => {
        run()
        this.timer = setInterval(run, this.options.monitoringInterval)
      }, initialDelay)
    }

    stopMonitoring() {
      if (this.initialTimer) clearTimeout(this.initialTimer)
      if (this.timer) clearInterval(this.timer)
      this.initialTimer = null
      this.timer = null
    }

    refreshCandidatePool() {
      const policy = kernelApi.proxies[this.policyGroup]
      if (!policy) return
      this.routeTarget = policy.now || ''
      const routeProxy = kernelApi.proxies[this.routeTarget]
      let candidateGroup = ''
      let candidateIds = []

      // Mode A: 2-Tier Hierarchy (Policy -> Region Sub-selector -> Leaf nodes)
      if (routeProxy && Array.isArray(routeProxy.all) && routeProxy.all.length) {
        candidateGroup = this.routeTarget
        candidateIds = routeProxy.all.filter((id) => isLeafProxy(id))
      }

      // Mode B: 1-Tier Flat Hierarchy (Policy -> Leaf nodes directly)
      if (!candidateIds.length && Array.isArray(policy.all)) {
        candidateGroup = this.policyGroup
        candidateIds = policy.all.filter((id) => isLeafProxy(id))
      }

      this.candidateGroup = candidateGroup
      const old = this.nodeMap
      this.nodes = candidateIds.map((id) => old.get(id) || new NodeHealth(id, this.options))
      this.nodeMap = new Map(this.nodes.map((node) => [node.id, node]))
      const nowNode = this.currentNodeName()
      this.current = this.nodes.find((node) => node.id === nowNode) || this.current
    }

    async checkAll() {
      if (this.checking) return
      if (!this.enabled) {
        if (this.lastReason !== '已关闭智能调度') {
          this.lastReason = '已关闭智能调度'
          this.addLog('muted', this.lastReason)
        }
        this.onUpdate()
        return
      }
      this.checking = true
      try {
        this.refreshCandidatePool()
        if (!this.nodes.length) {
          this.lastReason = `策略组 ${this.policyGroup} 当前选择 ${this.routeTarget || '-'}，没有可检测的节点池`
          this.addLog('warn', this.lastReason)
          return
        }
        const plan = this.buildCheckPlan()
        this.lastPlanText = `本轮检测 ${plan.length}/${this.nodes.length} 个节点`
        this.addLog('info', `${this.lastPlanText}，候选池 ${this.candidateGroup || '-'}，当前 ${this.currentNodeName() || '-'}`)
        await asyncPool(this.options.concurrencyLimit, plan, (node) => this.checkNode(node))
        this.lastCheckedAt = Date.now()
        const ready = this.nodes.filter((node) => node.successRatio >= this.options.minSwitchSuccessRatio).length
        this.addLog(ready ? 'success' : 'warn', `检测完成，可用 ${ready}/${this.nodes.length}`)
        await this.evaluateSwitch()
      } finally {
        this.checking = false
        this.onUpdate()
      }
    }

    buildCheckPlan() {
      const currentName = this.currentNodeName()
      const current = this.nodes.find((node) => node.id === currentName)
      
      const fresh = this.nodes.filter((node) => node.id !== currentName && node.lastChecked === 0)
      const checked = this.nodes.filter((node) => node.id !== currentName && node.lastChecked > 0).sort((a, b) => b.getScore() - a.getScore())
      const stale = [...checked].sort((a, b) => a.lastChecked - b.lastChecked)

      // Fast Warmup check: If more than 30% of nodes in pool are fresh, scale up budget temporarily
      const isWarmup = fresh.length > 3 && fresh.length / this.nodes.length > 0.3
      const baseBudget = Math.max(1, Number(this.options.maxCheckNodesPerGroup) || 4)
      const maxBudget = isWarmup ? Math.min(10, Math.max(baseBudget, Math.ceil(this.nodes.length * 0.35))) : baseBudget

      const picked = []
      const seen = new Set()

      const add = (node) => {
        if (!node || seen.has(node.id) || picked.length >= maxBudget) return false
        seen.add(node.id)
        picked.push(node)
        return true
      }

      if (current) add(current)

      // In warmup phase, take up to 4 fresh nodes to build leaderboards quickly
      const freshQuota = isWarmup ? Math.min(4, fresh.length) : (fresh.length ? 1 : 0)
      fresh.slice(0, freshQuota).forEach(add)

      const rotateLimit = Math.max(1, Number(this.options.rotateNodesPerCycle) || 1)
      this.pickRotatingNodes(stale, rotateLimit).forEach(add)

      const preserveTop = Math.max(1, Number(this.options.preserveTopNodes) || 2)
      checked.slice(0, preserveTop).forEach(add)

      fresh.forEach(add)
      stale.forEach(add)

      return picked
    }

    pickRotatingNodes(list, limit) {
      if (!list.length || limit <= 0) return []
      const picked = []
      const start = this.scanCursor % list.length
      for (let index = 0; index < Math.min(limit, list.length); index += 1) picked.push(list[(start + index) % list.length])
      this.scanCursor = (start + picked.length) % list.length
      return picked
    }

    async checkNode(node) {
      if (!node.isAvailable()) return
      const results = {}
      await asyncPool(this.options.serviceConcurrency, this.services, async (service) => {
        try {
          const delay = await requestDelay(node.id, service.url, this.options.requestTimeout)
          results[service.key] = { ok: true, delay }
        } catch (error) {
          results[service.key] = { ok: false, error: error.message || String(error) }
        }
      })
      node.record(results, this.services)
    }

    async evaluateSwitch() {
      const candidates = this.nodes.filter((node) => node.getScore() > -Infinity && node.successRatio >= this.options.minSwitchSuccessRatio)
      if (!candidates.length) {
        this.lastReason = `候选节点均未达到最低${this.profile.label}可达性要求，暂不切换`
        this.addLog('warn', this.lastReason)
        return
      }
      const best = candidates.sort((a, b) => b.getScore() - a.getScore())[0]
      const currentName = this.currentNodeName()
      const current = this.nodes.find((node) => node.id === currentName)
      this.current = current || this.current

      if (!current) {
        await this.switchTo(best, '当前节点不在候选池，切换到最佳节点')
        return
      }

      const now = Date.now()
      const currentScore = current.getScore()
      const bestScore = best.getScore()

      if (best.id === current.id) {
        this.lastReason = `当前节点仍是最优: ${best.id}`
        this.addLog('success', `${this.lastReason}，分数 ${formatScore(bestScore)}`)
        return
      }

      const isCurrentDead = !current.isAvailable() || current.successRatio < this.options.minSwitchSuccessRatio

      if (isCurrentDead) {
        await this.switchTo(best, `当前节点故障(可用率 ${Math.round(current.successRatio * 100)}%)，触发紧急自愈切换`)
        return
      }

      // Shared candidate pool anti-oscillation protection
      const lastPoolSwitch = candidatePoolSwitchMap.get(this.candidateGroup) || 0
      const timeSinceLastPoolSwitch = now - Math.max(this.lastSwitchAt, lastPoolSwitch)

      if (timeSinceLastPoolSwitch < this.options.minSwitchInterval) {
        const waitSeconds = Math.ceil((this.options.minSwitchInterval - timeSinceLastPoolSwitch) / 1000)
        this.lastReason = `发现更优节点 ${best.id}，但所属候选池处于切换冷却期`
        this.addLog('info', `${this.lastReason}，剩余约 ${waitSeconds}s`)
        return
      }

      if (bestScore >= currentScore + this.options.hysteresisMargin) {
        await this.switchTo(best, `综合分数提升 ${Math.round(bestScore - currentScore)}`)
      } else {
        const delta = Math.round(bestScore - currentScore)
        this.lastReason = `最佳节点 ${best.id} 未超过滞后阈值，保持当前选择`
        this.addLog('info', `${this.lastReason}，提升 ${delta} / 阈值 ${this.options.hysteresisMargin}`)
      }
    }

    // 宿主 Plugins.handleUseProxy 的真实契约（宿主产物 index-*.js 中的 bl 函数）：
    //   ① 严格判断 `type === 'Selector'`，否则静默 return；
    //   ② 目标已是当前节点时静默 return，什么都不做；
    //   ③ 是 async 且无返回值 —— 调用方不 await 就完全不知道成败。
    // 因此必须 await + 回读内核状态，并且只在「确实切过去了」之后才写切换冷却。
    async switchTo(node, reason) {
      // 重入保护：切换是异步的（要等宿主 PUT + 回读），期间不允许并发第二次切换
      if (this.switching) {
        this.lastReason = '已有切换请求进行中，忽略本次'
        return false
      }

      const groupProxy = kernelApi.proxies[this.candidateGroup]
      const nodeProxy = kernelApi.proxies[node.id]
      if (!groupProxy || !nodeProxy) {
        this.lastReason = '未找到候选组或目标节点代理对象，无法切换'
        this.addLog('warn', this.lastReason)
        return false
      }

      const groupType = String(groupProxy.type || '').toLowerCase()
      if (groupType && groupType !== 'selector') {
        this.lastReason = `分组 [${this.candidateGroup}] 类型为 ${groupProxy.type}，非 Selector，无法手动指定节点`
        this.addLog('warn', this.lastReason)
        return false
      }

      const previous = this.currentNodeName()
      // 目标已是当前节点：宿主会静默忽略，这里也直接短路。关键是**不能写切换冷却**，
      // 否则用户误点「当前节点」那一行，就会把自动调度冻结一整个 minSwitchInterval。
      if (previous === node.id) {
        this.current = node
        this.lastReason = `${reason}: 已是当前节点 ${node.id}，无需切换`
        this.addLog('info', this.lastReason)
        return true
      }

      let failure = ''
      this.switching = true
      try {
        await Plugins.handleUseProxy(groupProxy, nodeProxy)
      } catch (error) {
        failure = error.message || String(error)
      } finally {
        this.switching = false
      }

      // 不信任宿主：PUT 之后回读内核 `now` 是否真的变成了目标节点
      const applied = failure ? false : await this.waitForApplied(node.id)
      if (!applied) {
        this.lastReason = failure
          ? `切换 ${previous || '-'} -> ${node.id} 调用失败: ${failure}`
          : `切换 ${previous || '-'} -> ${node.id} 未生效（宿主未确认，可能是分组类型非 Selector 或代理尚未就绪）`
        this.addLog('warn', this.lastReason)
        return false
      }

      this.current = node
      this.lastSwitchAt = Date.now()
      candidatePoolSwitchMap.set(this.candidateGroup, Date.now())
      this.lastReason = `${reason}: ${this.candidateGroup} -> ${node.id}`
      this.addLog('switch', `${reason}: ${previous || '-'} -> ${node.id}`)
      return true
    }

    // 等待内核回读确认切换落地：宿主 refreshProviderProxies 是异步的，PUT 返回那一刻不代表 `now` 已更新
    async waitForApplied(nodeId, timeout = 1500) {
      const deadline = Date.now() + timeout
      for (;;) {
        if (this.currentNodeName() === nodeId) return true
        if (Date.now() >= deadline) return false
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }

    currentNodeName() {
      return kernelApi.proxies[this.candidateGroup]?.now || ''
    }

    syncExternalState(silent = false) {
      const previousRoute = this.routeTarget
      const previousPool = this.candidateGroup
      const previousCurrent = this.currentNodeName()
      this.refreshCandidatePool()
      const nextCurrent = this.currentNodeName()
      const changed = previousRoute !== this.routeTarget || previousPool !== this.candidateGroup || previousCurrent !== nextCurrent
      if (changed && !silent) {
        this.lastReason = `检测到外部选择变化：${previousRoute || '-'} -> ${this.routeTarget || '-'}`
        this.lastPlanText = ''
        this.addLog('info', `${this.lastReason}，当前节点 ${nextCurrent || '-'}`)
      }
      return changed
    }

    toView() {
      const currentName = this.currentNodeName()
      const serviceColumns = this.services.slice(0, 5)
      const rows = [...this.nodes].sort((a, b) => b.getScore() - a.getScore()).map((node) => {
        const services = serviceColumns.map((svc) => {
          const item = node.service[svc.key]
          const ok = item?.ok
          const delay = ok ? Math.round(item.delay) : null
          let cls = 'd-none'
          if (!item) cls = 'd-none'
          else if (!ok) cls = 'd-fail'
          else if (delay < 200) cls = 'd-fast'
          else if (delay < 500) cls = 'd-mid'
          else cls = 'd-slow'
          return { key: svc.key, text: serviceText(node, svc.key), delay: ok ? delay : 999999, cls }
        })
        const score = node.getScore()
        return {
          id: node.id,
          selected: node.id === currentName,
          score: formatScore(score),
          scoreNum: score === -Infinity ? -999999 : score,
          successRatio: `${Math.round(node.successRatio * 100)}%`,
          successRatioNum: node.successRatio,
          services,
          ewma: node.ewmaLatency ? `${Math.round(node.ewmaLatency)}ms` : '-',
          ewmaNum: node.ewmaLatency || 999999,
          failureCount: node.failureCount,
          stateText: stateText(node.state),
          stateCls: node.state === 'CLOSED' ? 's-normal' : node.state === 'OPEN' ? 's-open' : 's-half'
        }
      })
      const bestRow = rows[0]
      return {
        policyGroup: this.policyGroup,
        routeTarget: this.routeTarget || '-',
        candidateGroup: this.candidateGroup || '-',
        current: currentName || '-',
        profileLabel: this.profile.label,
        serviceColumns,
        enabled: this.enabled,
        bestNode: bestRow?.id || '-',
        bestRatio: bestRow?.successRatio || '-',
        readyNodes: this.nodes.filter((node) => node.successRatio >= this.options.minSwitchSuccessRatio).length,
        totalNodes: this.nodes.length,
        lastReason: this.lastReason,
        lastPlanText: this.lastPlanText,
        services: summarizeServices(this.nodes, this.services),
        logs: this.logs.map((item) => ({ ...item, timeText: formatLogTime(item.time) })),
        rows
      }
    }
  }

  const serviceText = (node, key) => {
    const item = node.service[key]
    if (!item) return '-'
    return item.ok ? `${Math.round(item.delay)}ms` : '失败'
  }

  const summarizeServices = (nodes, services) =>
    services.map((svc) => {
      const ok = nodes.filter((node) => node.service[svc.key]?.ok).length
      return { key: svc.key, label: svc.label, ok: ok > 0, text: nodes.length ? `${ok}/${nodes.length}` : '-' }
    })

  const stateText = (state) => (state === 'CLOSED' ? '正常' : state === 'OPEN' ? '熔断' : state === 'HALF_OPEN' ? '试探' : state || '-')
  const formatLogTime = (time) => {
    const d = new Date(time)
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':')
  }
  const formatScore = (score) => (score === -Infinity ? '-' : Math.round(score))

  const start = async (config = Plugin) => {
    stop(false, true)
    lastError.value = ''
    if (!kernelApi.running) throw new Error('核心未运行，无法启动分流策略智能调度')
    const options = getOptions(config)
    const custom = saveSchedulerConfig(loadSchedulerConfig(options.managedGroups))
    options.managedGroups = custom.groups.map((item) => item.name)
    options.groupConfigMap = new Map(custom.groups.map((item) => [item.name, item]))
    const created = []
    for (const group of options.managedGroups) {
      if (!kernelApi.proxies[group]) continue
      const manager = new SmartPolicyManager(group, options, notifyUpdate)
      manager.refreshCandidatePool()
      created.push(manager)
    }
    if (!created.length) throw new Error(`未找到可接管的策略组: ${options.managedGroups.join(', ')}`)
    managers.value = created
    managers.value.forEach((manager, index) => manager.startMonitoring(index * options.groupStartDelay))
    isRunning.value = true
    Plugin.status = 1
    notifyUpdate()
    return 1
  }

  const stop = (setStatus = true, clearManagers = false) => {
    managers.value.forEach((manager) => manager.stopMonitoring())
    if (clearManagers) managers.value = []
    isRunning.value = false
    if (setStatus) Plugin.status = 0
    notifyUpdate()
  }

  const ensurePreviewManagers = () => {
    if (managers.value.length || !kernelApi.running) return
    const options = getOptions()
    const custom = saveSchedulerConfig(loadSchedulerConfig(options.managedGroups))
    options.managedGroups = custom.groups.map((item) => item.name)
    options.groupConfigMap = new Map(custom.groups.map((item) => [item.name, item]))
    managers.value = options.managedGroups.filter((group) => kernelApi.proxies[group]).map((group) => {
      const manager = new SmartPolicyManager(group, options, notifyUpdate)
      manager.refreshCandidatePool()
      manager.lastReason = '等待启动'
      return manager
    })
    notifyUpdate()
  }

  const syncManagersFromKernel = (logChanges = false, shouldNotify = false) => {
    let changed = false
    managers.value.forEach((manager) => {
      if (manager.syncExternalState(!logChanges)) changed = true
    })
    if (changed && shouldNotify) notifyUpdate()
    return changed
  }

  const checkNow = async () => {
    if (!managers.value.length) {
      await start()
      return
    }
    await asyncPool(2, managers.value.filter((manager) => manager.enabled), (manager) => manager.checkAll())
    notifyUpdate()
  }

  const setGroupEnabled = (group, enabled) => {
    const config = schedulerConfig.value.groups.length ? schedulerConfig.value : loadSchedulerConfig(getOptions().managedGroups)
    const groups = config.groups.map((item) => (item.name === group ? { ...item, enabled: Boolean(enabled) } : item))
    saveSchedulerConfig({ groups })
    const manager = managers.value.find((item) => item.policyGroup === group)
    if (manager) {
      manager.enabled = Boolean(enabled)
      manager.lastReason = enabled ? '已开启智能调度，等待下一轮检测' : '已关闭智能调度'
      manager.addLog(enabled ? 'success' : 'muted', manager.lastReason)
      if (enabled) manager.checkAll().catch((error) => (lastError.value = error.message || String(error)))
    }
    notifyUpdate()
  }

  let modalSyncTimer = null

  // 定时器清理的唯一实现，afterClose / onUnmounted / onDispose 三处共用
  const stopModalSync = () => {
    if (modalSyncTimer) {
      clearInterval(modalSyncTimer)
      modalSyncTimer = null
    }
  }

  const openUI = () => {
    ensurePreviewManagers()
    injectStyle()
    const modal = Plugins.modal({
      title: Plugin.name,
      width: 1280,
      cancelText: '关闭',
      submit: false,
      afterClose: () => {
        stopModalSync()
        modal.destroy()
      }
    })
    const { defineComponent, onMounted, onUnmounted } = Vue
    const component = defineComponent({
      template: `
        <div class="ai-switcher">
          <!-- Topbar -->
          <div class="ais-topbar">
            <div class="ais-brand">
              <div class="ais-brand-head">
                <span class="ais-app-title">分流策略智能调度</span>
                <span class="ais-status-chip" :class="isRunning ? 'running' : 'stopped'">
                  <i class="ais-pulse-dot"></i>
                  {{ isRunning ? '调度中' : '已停止' }}
                </span>
              </div>
              <div class="ais-brand-sub">语义自适应服务画像，非线性体感时延打分，冷启动自适应暖机与跨组防踩踏保护。</div>
            </div>
            <div class="ais-actions">
              <button class="ais-btn" @click="openConfigPanel">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                {{ showConfig ? '返回工作台' : '自定义配置' }}
              </button>
              <button v-if="isRunning" class="ais-btn ais-btn-danger" @click="stop()">停止</button>
              <button v-else class="ais-btn ais-btn-primary" @click="handleStart">启动调度</button>
              <button class="ais-btn ais-btn-accent" :disabled="checking" @click="handleCheck">
                <svg v-if="!checking" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                <span v-else class="ais-spinner"></span>
                {{ checking ? '检测中...' : '立即全检' }}
              </button>
            </div>
          </div>

          <!-- Error Alert Banner -->
          <div v-if="lastError" class="ais-alert">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span>{{ lastError }}</span>
          </div>

          <!-- Stat Cards -->
          <div class="ais-stats-grid">
            <div v-for="item in summaryCards" :key="item.label" class="ais-stat-card">
              <div class="ais-stat-label">{{ item.label }}</div>
              <div class="ais-stat-val" :title="item.value">{{ item.value }}</div>
            </div>
          </div>

          <!-- Config Panel View -->
          <div v-if="showConfig" class="ais-config-container">
            <div class="ais-config-head">
              <div>
                <strong>策略组与测试网址配置</strong>
                <span>自定义策略组接管范围及专用探测端点。</span>
              </div>
              <div class="ais-actions">
                <button class="ais-btn" @click="resetDraft">重置修改</button>
                <button class="ais-btn ais-btn-primary" @click="saveDraft">保存并应用</button>
              </div>
            </div>
            <div class="ais-config-body">
              <div class="ais-config-groups">
                <div v-for="name in availableGroups" :key="name" class="ais-config-item" :class="{ selected: isDraftSelected(name), active: activeDraft && activeDraft.name === name }">
                  <input type="checkbox" :checked="isDraftSelected(name)" @change="toggleDraftGroup(name, $event.target.checked)" />
                  <button type="button" @click="selectDraftGroup(name)">
                    <b>{{ name }}</b>
                    <span class="ais-profile-tag">{{ profileLabelFor(name) }}</span>
                  </button>
                </div>
              </div>
              <div v-if="activeDraft" class="ais-config-editor">
                <div class="ais-editor-head">
                  <div>
                    <span class="ais-editor-title">{{ activeDraft.name }}</span>
                    <span class="ais-profile-tag">{{ profileLabelFor(activeDraft.name) }}画像</span>
                  </div>
                  <label class="ais-toggle-label">
                    <input type="checkbox" v-model="activeDraft.enabled" />
                    <i></i>
                    <span>{{ activeDraft.enabled ? '调度已启用' : '调度已停用' }}</span>
                  </label>
                </div>
                <div class="ais-url-editor">
                  <span class="ais-field-label">测试目标网址（每行一个，支持：<code>名称|URL|权重</code>）</span>
                  <textarea v-model="activeDraft.servicesText" spellcheck="false" placeholder="名称|https://domain.com|权重"></textarea>
                </div>
                <div class="ais-editor-foot">
                  <button class="ais-btn" @click="resetDraftServices">恢复此画像预设网址</button>
                </div>
              </div>
              <div v-else class="ais-config-empty">请在左侧勾选并选择要编辑的策略组。</div>
            </div>
          </div>

          <!-- Empty State -->
          <div v-else-if="!groups.length" class="ais-empty-state">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
            <div>核心未运行，或当前配置中没有可接管的代理策略组。</div>
          </div>

          <!-- Main Workspace -->
          <div v-else class="ais-workspace">
            <!-- Left Rail: Policy Groups -->
            <aside class="ais-group-rail">
              <div class="ais-rail-head">策略组列表 ({{ groups.length }})</div>
              <div class="ais-rail-list">
                <button v-for="group in groups" :key="group.policyGroup" class="ais-group-card" :class="{ active: activeGroup && activeGroup.policyGroup === group.policyGroup, disabled: !group.enabled }" @click="setActiveGroup(group.policyGroup)">
                  <div class="ais-gc-head">
                    <span class="ais-gc-name" :title="group.policyGroup">{{ group.policyGroup }}</span>
                    <div class="ais-gc-badges">
                      <span class="ais-profile-tag">{{ group.profileLabel }}</span>
                      <label class="ais-toggle-label mini" :title="group.enabled ? '关闭调度' : '开启调度'" @click.stop>
                        <input type="checkbox" :checked="group.enabled" @change="toggleGroup(group.policyGroup, $event.target.checked)" />
                        <i></i>
                      </label>
                    </div>
                  </div>
                  <div class="ais-gc-route">
                    <span :title="group.routeTarget">{{ group.routeTarget }}</span>
                    <span class="sep">/</span>
                    <span :title="group.candidateGroup">{{ group.candidateGroup || '无池' }}</span>
                  </div>
                  <div class="ais-gc-metrics">
                    <span class="ais-ratio-tag" :class="healthClass(group)">{{ group.bestRatio }} 达标</span>
                    <span class="ais-node-ratio">{{ group.readyNodes }}/{{ group.totalNodes }} 可用</span>
                    <div class="ais-mini-dots">
                      <span v-for="svc in group.services" :key="svc.key" class="ais-mdot" :class="svc.ok ? 'ok' : 'bad'" :title="svc.label + ': ' + svc.text"></span>
                    </div>
                  </div>
                </button>
              </div>
            </aside>

            <!-- Right Detail Panel -->
            <section v-if="activeGroup" class="ais-detail-panel" :class="{ disabled: !activeGroup.enabled }">
              <div class="ais-dp-head">
                <div class="ais-dp-title-row">
                  <div class="ais-dp-title">
                    <strong>{{ activeGroup.policyGroup }}</strong>
                    <span class="ais-dp-path">{{ activeGroup.routeTarget }} / {{ activeGroup.candidateGroup || '无候选池' }}</span>
                  </div>
                  <div class="ais-dp-actions">
                    <button class="ais-btn ais-btn-sm" :disabled="checkingGroup" @click="handleCheckCurrentGroup">
                      <svg v-if="!checkingGroup" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                      <span v-else class="ais-spinner-sm"></span>
                      {{ checkingGroup ? '测速中...' : '重测此组' }}
                    </button>
                    <label class="ais-toggle-label" @click.stop>
                      <input type="checkbox" :checked="activeGroup.enabled" @change="toggleGroup(activeGroup.policyGroup, $event.target.checked)" />
                      <i></i>
                      <span>{{ activeGroup.enabled ? '调度开启' : '调度关闭' }}</span>
                    </label>
                  </div>
                </div>
                <div class="ais-dp-reason">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                  <span>{{ activeGroup.lastReason || '等待检测调度' }}</span>
                  <span v-if="activeGroup.lastPlanText" class="ais-plan-tag">{{ activeGroup.lastPlanText }}</span>
                </div>
              </div>

              <!-- Mini KPI Row -->
              <div class="ais-kpi-row">
                <div class="ais-kpi-box wide">
                  <span class="kpi-label">最佳节点</span>
                  <strong class="kpi-val highlight" :title="activeGroup.bestNode">{{ activeGroup.bestNode }}</strong>
                </div>
                <div class="ais-kpi-box">
                  <span class="kpi-label">健康可用</span>
                  <strong class="kpi-val">{{ activeGroup.readyNodes }} / {{ activeGroup.totalNodes }}</strong>
                </div>
                <div class="ais-kpi-box">
                  <span class="kpi-label">服务画像</span>
                  <strong class="kpi-val">{{ activeGroup.profileLabel }}</strong>
                </div>
                <div class="ais-kpi-box">
                  <span class="kpi-label">巡检进度</span>
                  <strong class="kpi-val">{{ activeGroup.lastPlanText ? activeGroup.lastPlanText.replace('本轮检测 ', '') : '-' }}</strong>
                </div>
              </div>

              <!-- Service Status Chips -->
              <div class="ais-chips-row">
                <div v-for="svc in activeGroup.services" :key="svc.key" class="ais-chip" :class="svc.ok ? 'ok' : 'bad'">
                  <span class="chip-label">{{ svc.label }}</span>
                  <span class="chip-val">{{ svc.text }}</span>
                </div>
              </div>

              <!-- Table Filter Toolbar -->
              <div class="ais-table-toolbar">
                <div class="ais-tt-left">
                  <span class="ais-tt-count">节点列表 ({{ displayRows.length }}/{{ activeGroup.totalNodes }})</span>
                  <span class="ais-tt-tip">💡 支持点击表头排序，点击行或「使用」按钮直接切换节点</span>
                </div>
                <div class="ais-tt-right">
                  <label class="ais-filter-chk">
                    <input type="checkbox" v-model="onlyHealthy" />
                    <span>只看健康</span>
                  </label>
                  <div class="ais-search-box">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input type="text" v-model="searchQuery" placeholder="过滤节点..." />
                    <button v-if="searchQuery" class="ais-clear-btn" @click="searchQuery = ''">×</button>
                  </div>
                </div>
              </div>

              <!-- Node Table -->
              <div class="ais-table-wrap">
                <table class="ais-table">
                  <thead>
                    <tr>
                      <th class="col-node sortable" @click="handleSort('name')">
                        节点全称
                        <span class="sort-icon">{{ sortKey === 'name' ? (sortDesc ? '▼' : '▲') : '' }}</span>
                      </th>
                      <th class="col-score sortable" @click="handleSort('score')">
                        分值
                        <span class="sort-icon">{{ sortKey === 'score' ? (sortDesc ? '▼' : '▲') : '' }}</span>
                      </th>
                      <th class="col-ratio sortable" @click="handleSort('ratio')">
                        可用率
                        <span class="sort-icon">{{ sortKey === 'ratio' ? (sortDesc ? '▼' : '▲') : '' }}</span>
                      </th>
                      <th v-for="svc in activeGroup.serviceColumns" :key="svc.key" class="col-svc sortable" @click="handleSort('svc_' + svc.key)">
                        {{ svc.label }}
                        <span class="sort-icon">{{ sortKey === 'svc_' + svc.key ? (sortDesc ? '▼' : '▲') : '' }}</span>
                      </th>
                      <th class="col-ewma sortable" @click="handleSort('ewma')">
                        EWMA
                        <span class="sort-icon">{{ sortKey === 'ewma' ? (sortDesc ? '▼' : '▲') : '' }}</span>
                      </th>
                      <th class="col-fail sortable" @click="handleSort('fail')">
                        失败
                        <span class="sort-icon">{{ sortKey === 'fail' ? (sortDesc ? '▼' : '▲') : '' }}</span>
                      </th>
                      <th class="col-state">状态</th>
                      <th class="col-op">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in displayRows" :key="row.id" :class="{ 'row-active': row.selected }" @click="handleManualSwitch(row.id)">
                      <td class="col-node" :title="row.id">
                        <div class="ais-node-cell">
                          <span v-if="row.selected" class="ais-active-badge" title="当前路由节点">当前</span>
                          <span class="ais-node-text">{{ row.id }}</span>
                        </div>
                      </td>
                      <td class="col-score"><b>{{ row.score }}</b></td>
                      <td class="col-ratio"><span class="ais-ratio-pill">{{ row.successRatio }}</span></td>
                      <td v-for="svc in row.services" :key="svc.key" class="col-svc" :class="svc.cls">{{ svc.text }}</td>
                      <td class="col-ewma">{{ row.ewma }}</td>
                      <td class="col-fail">{{ row.failureCount }}</td>
                      <td class="col-state"><span class="ais-state-pill" :class="row.stateCls">{{ row.stateText }}</span></td>
                      <td class="col-op" @click.stop>
                        <button v-if="!row.selected" class="ais-btn-switch" @click="handleManualSwitch(row.id)">使用</button>
                        <span v-else class="ais-using-tag">使用中</span>
                      </td>
                    </tr>
                    <tr v-if="!displayRows.length">
                      <td :colspan="6 + activeGroup.serviceColumns.length" class="ais-td-empty">未找到匹配的节点</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- Collapsible Log Drawer -->
              <div class="ais-log-drawer" :class="{ expanded: showLogs }">
                <div class="ais-log-bar" @click="showLogs = !showLogs">
                  <div class="ais-lb-left">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <span class="ais-lb-title">调度与决策日志</span>
                    <span v-if="activeGroup.logs[0]" class="ais-lb-latest">
                      <b class="time">[{{ activeGroup.logs[0].timeText }}]</b>
                      <span class="msg">{{ activeGroup.logs[0].message }}</span>
                    </span>
                    <span v-else class="ais-lb-latest muted">暂无调度记录</span>
                  </div>
                  <div class="ais-lb-right">
                    <span class="ais-lb-count">{{ activeGroup.logs.length }} 条</span>
                    <button class="ais-lb-toggle" type="button">
                      {{ showLogs ? '收起 ▾' : '展开日志 ▴' }}
                    </button>
                  </div>
                </div>
                <div v-if="showLogs" class="ais-log-body">
                  <div v-for="log in activeGroup.logs.slice(0, 30)" :key="log.id" class="ais-log-entry" :class="log.level">
                    <span class="log-time">{{ log.timeText }}</span>
                    <span class="log-tag">{{ log.level }}</span>
                    <span class="log-msg" :title="log.message">{{ log.message }}</span>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      `,
      setup() {
        const checking = ref(false)
        const checkingGroup = ref(false)
        const showConfig = ref(false)
        const showLogs = ref(false)
        const searchQuery = ref('')
        const onlyHealthy = ref(false)
        const sortKey = ref('score')
        const sortDesc = ref(true)

        const draftGroups = ref([])
        const activeDraftName = ref('')
        const activePolicyGroup = ref('')

        const groups = computed(() => {
          viewTick.value
          return managers.value.map((manager) => manager.toView())
        })
        const availableGroups = computed(() => {
          viewTick.value
          return detectManagedGroups()
        })
        const activeGroup = computed(() => groups.value.find((group) => group.policyGroup === activePolicyGroup.value) || groups.value[0] || null)
        const currentManager = computed(() => managers.value.find((m) => m.policyGroup === activePolicyGroup.value) || managers.value[0] || null)
        const activeDraft = computed(() => draftGroups.value.find((item) => item.name === activeDraftName.value) || draftGroups.value[0] || null)

        const summaryCards = computed(() => {
          viewTick.value
          const enabledCount = managers.value.filter((manager) => manager.enabled).length
          return [
            { label: '运行状态', value: isRunning.value ? '已启动运行' : '未启动' },
            { label: '开启策略组', value: managers.value.length ? `${enabledCount} / ${managers.value.length} 个` : `${availableGroups.value.length} 个` },
            { label: '当前大区候选池', value: activeGroup.value?.candidateGroup || '-' },
            { label: '当前选用节点', value: activeGroup.value?.current || '-' }
          ]
        })

        const displayRows = computed(() => {
          if (!activeGroup.value) return []
          let list = [...activeGroup.value.rows]

          if (searchQuery.value.trim()) {
            const q = searchQuery.value.trim().toLowerCase()
            list = list.filter((r) => r.id.toLowerCase().includes(q))
          }

          if (onlyHealthy.value) {
            list = list.filter((r) => r.stateCls === 's-normal' && r.successRatioNum >= 0.45)
          }

          list.sort((a, b) => {
            let vA, vB
            if (sortKey.value === 'score') {
              vA = a.scoreNum
              vB = b.scoreNum
            } else if (sortKey.value === 'ratio') {
              vA = a.successRatioNum
              vB = b.successRatioNum
            } else if (sortKey.value === 'ewma') {
              vA = a.ewmaNum
              vB = b.ewmaNum
            } else if (sortKey.value === 'fail') {
              vA = a.failureCount
              vB = b.failureCount
            } else if (sortKey.value === 'name') {
              return sortDesc.value ? b.id.localeCompare(a.id, 'zh-Hans-CN') : a.id.localeCompare(b.id, 'zh-Hans-CN')
            } else if (sortKey.value.startsWith('svc_')) {
              const k = sortKey.value.replace('svc_', '')
              const sA = a.services.find((s) => s.key === k)
              const sB = b.services.find((s) => s.key === k)
              vA = sA?.delay ?? 999999
              vB = sB?.delay ?? 999999
            } else {
              vA = a.scoreNum
              vB = b.scoreNum
            }
            return sortDesc.value ? vB - vA : vA - vB
          })

          return list
        })

        const handleSort = (key) => {
          if (sortKey.value === key) {
            sortDesc.value = !sortDesc.value
          } else {
            sortKey.value = key
            sortDesc.value = key === 'name' ? false : true
          }
        }

        const handleManualSwitch = async (nodeId) => {
          const manager = currentManager.value
          if (!manager) return
          const targetNode = manager.nodes.find((n) => n.id === nodeId)
          if (!targetNode) return
          if (manager.switching) return
          // 已是当前节点：整行都绑了点击，用户选个文字就会触发，这里必须静默短路，
          // 否则会走进切换流程并写入 15 分钟冷却，把自动调度冻住。
          if (manager.currentNodeName() === nodeId) return
          try {
            const applied = await manager.switchTo(targetNode, '用户手动切换')
            notifyUpdate()
            if (applied) {
              Plugins.message.success(`已切换到节点: ${nodeId}`)
            } else {
              Plugins.message.info(manager.lastReason || `切换未生效: ${nodeId}`)
            }
          } catch (err) {
            Plugins.message.error(`切换失败: ${err.message || err}`)
          }
        }

        const handleCheckCurrentGroup = async () => {
          const manager = currentManager.value
          if (!manager) return
          checkingGroup.value = true
          try {
            await manager.checkAll()
            Plugins.message.success(`${manager.policyGroup} 巡检完成`)
          } catch (err) {
            Plugins.message.error(`检测失败: ${err.message || err}`)
          } finally {
            checkingGroup.value = false
            notifyUpdate()
          }
        }

        const copyConfigGroups = (config) => config.groups.map((item) => ({ ...item }))
        const openConfigPanel = () => {
          if (showConfig.value) {
            showConfig.value = false
            return
          }
          const config = loadSchedulerConfig(getOptions().managedGroups)
          draftGroups.value = copyConfigGroups(config)
          activeDraftName.value = draftGroups.value[0]?.name || ''
          showConfig.value = true
        }
        const resetDraft = () => {
          const config = loadSchedulerConfig()
          draftGroups.value = copyConfigGroups(config)
          activeDraftName.value = draftGroups.value[0]?.name || ''
        }
        const isDraftSelected = (name) => draftGroups.value.some((item) => item.name === name)
        const selectDraftGroup = (name) => {
          if (isDraftSelected(name)) activeDraftName.value = name
        }
        const toggleDraftGroup = (name, enabled) => {
          if (enabled) {
            if (!isDraftSelected(name)) draftGroups.value = [...draftGroups.value, defaultGroupConfig(name, true)]
            activeDraftName.value = name
          } else {
            draftGroups.value = draftGroups.value.filter((item) => item.name !== name)
            if (activeDraftName.value === name) activeDraftName.value = draftGroups.value[0]?.name || ''
          }
        }
        const profileLabelFor = (name) => matchServiceProfile(name).label
        const resetDraftServices = () => {
          if (!activeDraft.value) return
          activeDraft.value.servicesText = defaultGroupConfig(activeDraft.value.name, activeDraft.value.enabled).servicesText
        }
        const saveDraft = async () => {
          const groups = draftGroups.value.map((item) => normalizeGroupConfig(item)).filter(Boolean)
          if (!groups.length) {
            Plugins.message.error('至少选择一个策略组')
            return
          }
          saveSchedulerConfig({ groups })
          showConfig.value = false
          if (isRunning.value) await start()
          else ensurePreviewManagers()
          Plugins.message.success('自定义调度配置已保存')
        }
        const healthClass = (group) => {
          const ratio = Number(String(group.bestRatio).replace('%', ''))
          if (ratio >= 80) return 'good'
          if (ratio >= 45) return 'warn'
          return 'poor'
        }
        onMounted(() => {
          syncManagersFromKernel(false, true)
          stopModalSync()
          modalSyncTimer = setInterval(() => syncManagersFromKernel(true, true), MODAL_SYNC_INTERVAL)
        })
        // 定时器统一走 stopModalSync：afterClose 是主路径，此处仅兜组件异常卸载
        onUnmounted(() => stopModalSync())

        return {
          isRunning,
          lastError,
          checking,
          checkingGroup,
          showConfig,
          showLogs,
          searchQuery,
          onlyHealthy,
          sortKey,
          sortDesc,
          groups,
          availableGroups,
          activeGroup,
          activeDraft,
          summaryCards,
          displayRows,
          handleSort,
          handleManualSwitch,
          handleCheckCurrentGroup,
          setActiveGroup: (policyGroup) => (activePolicyGroup.value = policyGroup),
          openConfigPanel,
          resetDraft,
          isDraftSelected,
          selectDraftGroup,
          toggleDraftGroup,
          profileLabelFor,
          resetDraftServices,
          saveDraft,
          toggleGroup: setGroupEnabled,
          healthClass,
          stop,
          async handleStart() {
            try {
              await start()
            } catch (error) {
              lastError.value = error.message || String(error)
              Plugins.message.error(lastError.value)
            }
          },
          async handleCheck() {
            checking.value = true
            try {
              await checkNow()
            } catch (error) {
              lastError.value = error.message || String(error)
              Plugins.message.error(lastError.value)
            } finally {
              checking.value = false
            }
          }
        }
      }
    })
    modal.setContent(component)
    modal.open()
  }

  const injectStyle = () => {
    const styleId = `${Plugin.id}-style`
    const style = document.getElementById(styleId) || document.createElement('style')
    style.id = styleId
    style.textContent = `
      .ai-switcher {
        --ais-bg: #f8fafc;
        --ais-card: #ffffff;
        --ais-card-sub: #f1f5f9;
        --ais-border: #e2e8f0;
        --ais-border-light: #edf2f7;
        --ais-text: #0f172a;
        --ais-text-muted: #64748b;
        --ais-text-sub: #94a3b8;
        --ais-accent: #2563eb;
        --ais-accent-soft: #eff6ff;
        --ais-accent-border: #bfdbfe;
        --ais-good: #16a34a;
        --ais-good-bg: #f0fdf4;
        --ais-good-border: #bbf7d0;
        --ais-warn: #d97706;
        --ais-warn-bg: #fffbeb;
        --ais-warn-border: #fde68a;
        --ais-bad: #dc2626;
        --ais-bad-bg: #fef2f2;
        --ais-bad-border: #fecaca;
        --ais-row-active: #f0fdf4;
        --ais-row-active-border: #22c55e;
        --ais-shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
        --ais-shadow-card: 0 1px 3px 0 rgba(0, 0, 0, 0.08), 0 1px 2px -1px rgba(0, 0, 0, 0.05);

        background: var(--ais-bg);
        color: var(--ais-text);
        height: min(720px, calc(100vh - 110px));
        min-height: 540px;
        padding: 14px;
        border-radius: 10px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        box-sizing: border-box;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      }

      html.dark .ai-switcher, body.dark .ai-switcher, .dark .ai-switcher, [data-theme="dark"] .ai-switcher,
      body[theme-mode="dark"] .ai-switcher, body[theme-mode=dark] .ai-switcher {
        --ais-bg: #0b0f19;
        --ais-card: #131d31;
        --ais-card-sub: #1a2640;
        --ais-border: #233354;
        --ais-border-light: #1c2b47;
        --ais-text: #f8fafc;
        --ais-text-muted: #94a3b8;
        --ais-text-sub: #64748b;
        --ais-accent: #3b82f6;
        --ais-accent-soft: rgba(59, 130, 246, 0.14);
        --ais-accent-border: rgba(59, 130, 246, 0.35);
        --ais-good: #4ade80;
        --ais-good-bg: rgba(34, 197, 94, 0.12);
        --ais-good-border: rgba(34, 197, 94, 0.28);
        --ais-warn: #fbbf24;
        --ais-warn-bg: rgba(245, 158, 11, 0.12);
        --ais-warn-border: rgba(245, 158, 11, 0.28);
        --ais-bad: #f87171;
        --ais-bad-bg: rgba(239, 68, 68, 0.14);
        --ais-bad-border: rgba(239, 68, 68, 0.32);
        --ais-row-active: rgba(34, 197, 94, 0.10);
        --ais-row-active-border: #4ade80;
        --ais-shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
        --ais-shadow-card: 0 2px 4px 0 rgba(0, 0, 0, 0.25);
      }

      .ai-switcher * { box-sizing: border-box; }

      /* Topbar */
      .ais-topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex: 0 0 auto; }
      .ais-brand { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .ais-brand-head { display: flex; align-items: center; gap: 10px; }
      .ais-app-title { font-size: 18px; font-weight: 800; color: var(--ais-text); letter-spacing: -0.3px; line-height: 24px; }
      .ais-brand-sub { font-size: 12px; color: var(--ais-text-muted); line-height: 18px; }

      .ais-status-chip {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 700;
      }
      .ais-status-chip.running { color: var(--ais-good); background: var(--ais-good-bg); border: 1px solid var(--ais-good-border); }
      .ais-status-chip.stopped { color: var(--ais-text-muted); background: var(--ais-card-sub); border: 1px solid var(--ais-border); }
      .ais-pulse-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: aisPulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
      @keyframes aisPulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }

      .ais-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
      .ais-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        padding: 6px 12px; font-size: 12px; font-weight: 600; line-height: 18px;
        border-radius: 7px; border: 1px solid var(--ais-border); background: var(--ais-card);
        color: var(--ais-text); cursor: pointer; transition: all 0.15s ease;
      }
      .ais-btn:hover { background: var(--ais-card-sub); border-color: var(--ais-text-muted); }
      .ais-btn-sm { padding: 4px 9px; font-size: 11px; border-radius: 6px; }
      .ais-btn-primary { background: var(--ais-accent); color: #fff; border-color: var(--ais-accent); }
      .ais-btn-primary:hover { opacity: 0.92; background: var(--ais-accent); }
      .ais-btn-accent { background: var(--ais-accent-soft); color: var(--ais-accent); border-color: var(--ais-accent-border); }
      .ais-btn-accent:hover { background: var(--ais-accent); color: #fff; }
      .ais-btn-danger { background: var(--ais-bad-bg); color: var(--ais-bad); border-color: var(--ais-bad-border); }
      .ais-btn-danger:hover { background: var(--ais-bad); color: #fff; }
      .ais-spinner { width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: aisSpin 0.75s linear infinite; }
      .ais-spinner-sm { width: 10px; height: 10px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: aisSpin 0.75s linear infinite; }
      @keyframes aisSpin { to { transform: rotate(360deg); } }

      /* Alert */
      .ais-alert {
        display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 7px;
        background: var(--ais-bad-bg); color: var(--ais-bad); border: 1px solid var(--ais-bad-border);
        font-size: 12px; line-height: 16px; flex: 0 0 auto;
      }

      /* Stats Grid */
      .ais-stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; flex: 0 0 auto; }
      .ais-stat-card {
        background: var(--ais-card); border: 1px solid var(--ais-border); border-radius: 8px;
        padding: 8px 12px; box-shadow: var(--ais-shadow-sm); min-width: 0;
      }
      .ais-stat-label { font-size: 11px; font-weight: 600; color: var(--ais-text-muted); margin-bottom: 2px; }
      .ais-stat-val { font-size: 14px; font-weight: 800; color: var(--ais-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      /* Workspace */
      .ais-workspace { display: grid; grid-template-columns: 310px minmax(0, 1fr); gap: 12px; flex: 1 1 0; min-height: 0; }

      /* Group Rail */
      .ais-group-rail {
        background: var(--ais-card); border: 1px solid var(--ais-border); border-radius: 9px;
        display: flex; flex-direction: column; overflow: hidden; box-shadow: var(--ais-shadow-sm);
      }
      .ais-rail-head {
        padding: 9px 12px; font-size: 11px; font-weight: 700; color: var(--ais-text-muted);
        border-bottom: 1px solid var(--ais-border-light); text-transform: uppercase; letter-spacing: 0.4px;
      }
      .ais-rail-list { padding: 8px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; flex: 1 1 0; }

      .ais-group-card {
        width: 100%; text-align: left; padding: 9px 11px; border-radius: 7px;
        border: 1px solid var(--ais-border-light); background: var(--ais-card-sub);
        cursor: pointer; transition: all 0.15s ease; color: inherit; position: relative;
      }
      .ais-group-card:hover { border-color: var(--ais-accent-border); background: var(--ais-card); }
      .ais-group-card.active {
        border-color: var(--ais-accent); background: var(--ais-card);
        box-shadow: 0 0 0 1px var(--ais-accent), var(--ais-shadow-sm);
      }
      .ais-group-card.disabled { opacity: 0.6; }

      .ais-gc-head { display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-bottom: 3px; }
      .ais-gc-name { font-size: 13px; font-weight: 700; color: var(--ais-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ais-gc-badges { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
      .ais-profile-tag {
        font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px;
        background: var(--ais-accent-soft); color: var(--ais-accent); border: 1px solid var(--ais-accent-border);
      }
      .ais-gc-route { font-size: 11px; color: var(--ais-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 5px; }
      .ais-gc-route .sep { margin: 0 4px; opacity: 0.5; }

      .ais-gc-metrics { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
      .ais-ratio-tag { font-size: 10px; font-weight: 800; padding: 1px 6px; border-radius: 999px; }
      .ais-ratio-tag.good { background: var(--ais-good-bg); color: var(--ais-good); border: 1px solid var(--ais-good-border); }
      .ais-ratio-tag.warn { background: var(--ais-warn-bg); color: var(--ais-warn); border: 1px solid var(--ais-warn-border); }
      .ais-ratio-tag.poor { background: var(--ais-bad-bg); color: var(--ais-bad); border: 1px solid var(--ais-bad-border); }
      .ais-node-ratio { font-size: 11px; color: var(--ais-text-muted); }
      .ais-mini-dots { display: flex; align-items: center; gap: 3px; }
      .ais-mdot { width: 6px; height: 6px; border-radius: 50%; }
      .ais-mdot.ok { background: var(--ais-good); }
      .ais-mdot.bad { background: var(--ais-bad); opacity: 0.5; }

      /* Toggle Switch */
      .ais-toggle-label { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; user-select: none; font-size: 12px; font-weight: 600; color: var(--ais-text); }
      .ais-toggle-label.mini { gap: 0; }
      .ais-toggle-label input { position: absolute; opacity: 0; pointer-events: none; }
      .ais-toggle-label i { width: 32px; height: 18px; border-radius: 999px; background: #94a3b8; position: relative; transition: background 0.18s ease; flex: 0 0 auto; }
      .ais-toggle-label.mini i { width: 28px; height: 16px; }
      .ais-toggle-label i::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 999px; background: #fff; transition: transform 0.18s ease; box-shadow: 0 1px 2px rgba(0,0,0,0.2); }
      .ais-toggle-label.mini i::after { width: 12px; height: 12px; }
      .ais-toggle-label input:checked + i { background: var(--ais-accent); }
      .ais-toggle-label input:checked + i::after { transform: translateX(14px); }
      .ais-toggle-label.mini input:checked + i::after { transform: translateX(12px); }

      /* Detail Panel */
      .ais-detail-panel {
        background: var(--ais-card); border: 1px solid var(--ais-border); border-radius: 9px;
        display: flex; flex-direction: column; overflow: hidden; box-shadow: var(--ais-shadow-sm); min-width: 0;
      }
      .ais-detail-panel.disabled { opacity: 0.75; }

      .ais-dp-head { padding: 10px 14px; border-bottom: 1px solid var(--ais-border-light); flex: 0 0 auto; }
      .ais-dp-title-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 4px; }
      .ais-dp-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
      .ais-dp-title strong { font-size: 16px; font-weight: 800; color: var(--ais-text); }
      .ais-dp-path { font-size: 12px; color: var(--ais-text-muted); }
      .ais-dp-actions { display: flex; align-items: center; gap: 10px; }
      .ais-dp-reason { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ais-text-muted); line-height: 16px; }
      .ais-plan-tag { padding: 1px 6px; border-radius: 4px; background: var(--ais-card-sub); font-size: 11px; border: 1px solid var(--ais-border); color: var(--ais-text); }

      /* KPI Row */
      .ais-kpi-row { display: grid; grid-template-columns: minmax(240px, 1.4fr) repeat(3, 1fr); gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--ais-border-light); flex: 0 0 auto; }
      .ais-kpi-box { background: var(--ais-card-sub); border: 1px solid var(--ais-border-light); border-radius: 7px; padding: 7px 10px; min-width: 0; }
      .ais-kpi-box .kpi-label { display: block; font-size: 10px; font-weight: 700; color: var(--ais-text-muted); margin-bottom: 2px; }
      .ais-kpi-box .kpi-val { display: block; font-size: 13px; font-weight: 800; color: var(--ais-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ais-kpi-box .kpi-val.highlight { color: var(--ais-accent); }

      /* Chips Row */
      .ais-chips-row { display: flex; flex-wrap: wrap; gap: 6px; padding: 7px 14px; border-bottom: 1px solid var(--ais-border-light); flex: 0 0 auto; }
      .ais-chip {
        display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px;
        font-size: 11px; font-weight: 700; border: 1px solid transparent;
      }
      .ais-chip.ok { background: var(--ais-good-bg); color: var(--ais-good); border-color: var(--ais-good-border); }
      .ais-chip.bad { background: var(--ais-bad-bg); color: var(--ais-bad); border-color: var(--ais-bad-border); }
      .ais-chip .chip-val { font-weight: 500; opacity: 0.85; }

      /* Table Toolbar */
      .ais-table-toolbar {
        display: flex; justify-content: space-between; align-items: center; gap: 10px;
        padding: 6px 14px; border-bottom: 1px solid var(--ais-border-light);
        background: var(--ais-card); flex: 0 0 auto;
      }
      .ais-tt-left { display: flex; align-items: center; gap: 8px; font-size: 11px; }
      .ais-tt-count { font-weight: 700; color: var(--ais-text); }
      .ais-tt-tip { color: var(--ais-text-muted); font-size: 11px; }
      .ais-tt-right { display: flex; align-items: center; gap: 10px; }
      .ais-filter-chk { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--ais-text-muted); cursor: pointer; user-select: none; }
      .ais-filter-chk input { margin: 0; cursor: pointer; }
      .ais-search-box {
        display: flex; align-items: center; gap: 5px; background: var(--ais-card-sub);
        border: 1px solid var(--ais-border); border-radius: 6px; padding: 2px 7px; width: 135px;
      }
      .ais-search-box input {
        border: 0; background: transparent; color: var(--ais-text); font-size: 11px;
        width: 100%; outline: none;
      }
      .ais-clear-btn { border: 0; background: transparent; color: var(--ais-text-muted); cursor: pointer; font-size: 12px; line-height: 1; padding: 0; }

      /* Table Wrapper */
      .ais-table-wrap { flex: 1 1 0; min-height: 0; overflow-y: auto; overflow-x: auto; position: relative; }
      .ais-table { width: 100%; border-collapse: collapse; font-size: 11px; text-align: left; }
      .ais-table th {
        position: sticky; top: 0; z-index: 2; background: var(--ais-card-sub);
        color: var(--ais-text-muted); font-weight: 700; padding: 7px 8px;
        border-bottom: 1px solid var(--ais-border); white-space: nowrap;
      }
      .ais-table th.sortable { cursor: pointer; user-select: none; }
      .ais-table th.sortable:hover { color: var(--ais-accent); background: var(--ais-border-light); }
      .sort-icon { font-size: 9px; margin-left: 2px; color: var(--ais-accent); }

      .ais-table td {
        padding: 7px 8px; border-bottom: 1px solid var(--ais-border-light);
        color: var(--ais-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ais-table tr { cursor: pointer; transition: background 0.1s ease; }
      .ais-table tr:hover td { background: var(--ais-card-sub); }
      .ais-table tr.row-active td { background: var(--ais-row-active); }

      /* Table Columns Specification */
      .ais-table .col-node { width: 34%; min-width: 250px; font-weight: 600; }
      .ais-table .col-score { width: 56px; text-align: right; }
      .ais-table .col-ratio { width: 68px; text-align: center; }
      .ais-table .col-svc { width: 72px; text-align: center; }
      .ais-table .col-ewma { width: 64px; text-align: right; }
      .ais-table .col-fail { width: 46px; text-align: center; }
      .ais-table .col-state { width: 52px; text-align: center; }
      .ais-table .col-op { width: 56px; text-align: center; }

      .ais-node-cell { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .ais-active-badge {
        flex: 0 0 auto; font-size: 9px; font-weight: 800; padding: 1px 4px;
        border-radius: 3px; background: var(--ais-good); color: #fff;
      }
      .ais-node-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }

      /* Operation Buttons */
      .ais-btn-switch {
        font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px;
        border: 1px solid var(--ais-accent-border); background: var(--ais-accent-soft);
        color: var(--ais-accent); cursor: pointer; transition: all 0.15s ease;
      }
      .ais-btn-switch:hover { background: var(--ais-accent); color: #fff; }
      .ais-using-tag { font-size: 10px; font-weight: 700; color: var(--ais-good); }

      /* Delay Colors */
      .ais-table td.d-fast { color: var(--ais-good); font-weight: 700; }
      .ais-table td.d-mid { color: var(--ais-warn); font-weight: 700; }
      .ais-table td.d-slow { color: var(--ais-bad); font-weight: 700; }
      .ais-table td.d-fail { color: var(--ais-bad); opacity: 0.7; }
      .ais-table td.d-none { color: var(--ais-text-sub); }

      .ais-ratio-pill { padding: 1px 5px; border-radius: 4px; background: var(--ais-card-sub); font-weight: 700; border: 1px solid var(--ais-border); }
      .ais-state-pill { padding: 1px 5px; border-radius: 4px; font-size: 10px; font-weight: 700; }
      .ais-state-pill.s-normal { color: var(--ais-good); background: var(--ais-good-bg); }
      .ais-state-pill.s-open { color: var(--ais-bad); background: var(--ais-bad-bg); }
      .ais-state-pill.s-half { color: var(--ais-warn); background: var(--ais-warn-bg); }
      .ais-td-empty { text-align: center; color: var(--ais-text-muted); padding: 24px !important; }

      /* Collapsible Log Drawer */
      .ais-log-drawer {
        flex: 0 0 auto; border-top: 1px solid var(--ais-border);
        background: var(--ais-card-sub); display: flex; flex-direction: column;
        transition: all 0.2s ease; overflow: hidden;
      }
      .ais-log-bar {
        display: flex; justify-content: space-between; align-items: center;
        padding: 5px 12px; cursor: pointer; user-select: none; font-size: 11px; height: 32px;
      }
      .ais-log-bar:hover { background: var(--ais-border-light); }
      .ais-lb-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .ais-lb-title { font-weight: 700; color: var(--ais-text); flex: 0 0 auto; }
      .ais-lb-latest { color: var(--ais-text-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ais-lb-latest .time { font-family: Consolas, monospace; margin-right: 4px; color: var(--ais-text-sub); }
      .ais-lb-latest.muted { color: var(--ais-text-sub); }
      .ais-lb-right { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
      .ais-lb-count { font-size: 10px; color: var(--ais-text-sub); }
      .ais-lb-toggle {
        border: 0; background: transparent; color: var(--ais-accent); font-size: 11px;
        font-weight: 600; cursor: pointer; padding: 0;
      }
      .ais-log-body {
        padding: 6px 12px 10px; height: 130px; overflow-y: auto;
        display: flex; flex-direction: column; gap: 3px; border-top: 1px solid var(--ais-border-light);
      }
      .ais-log-entry {
        display: grid; grid-template-columns: 52px 48px minmax(0, 1fr); gap: 6px;
        align-items: baseline; font-size: 11px; line-height: 16px;
      }
      .ais-log-entry .log-time { color: var(--ais-text-sub); font-family: Consolas, monospace; font-size: 10px; }
      .ais-log-entry .log-tag {
        font-size: 9px; font-weight: 800; text-transform: uppercase; padding: 0 4px;
        border-radius: 3px; text-align: center;
      }
      .ais-log-entry.info .log-tag { background: var(--ais-accent-soft); color: var(--ais-accent); }
      .ais-log-entry.success .log-tag { background: var(--ais-good-bg); color: var(--ais-good); }
      .ais-log-entry.warn .log-tag { background: var(--ais-warn-bg); color: var(--ais-warn); }
      .ais-log-entry.switch .log-tag { background: #e0e7ff; color: #4338ca; }
      .ais-log-entry .log-msg { color: var(--ais-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      /* Config View */
      .ais-config-container {
        background: var(--ais-card); border: 1px solid var(--ais-border); border-radius: 9px;
        display: flex; flex-direction: column; flex: 1 1 0; min-height: 0; box-shadow: var(--ais-shadow-sm); overflow: hidden;
      }
      .ais-config-head {
        display: flex; justify-content: space-between; align-items: center; padding: 12px 16px;
        border-bottom: 1px solid var(--ais-border-light);
      }
      .ais-config-head strong { display: block; font-size: 15px; color: var(--ais-text); }
      .ais-config-head span { font-size: 12px; color: var(--ais-text-muted); }
      .ais-config-body { display: grid; grid-template-columns: 310px minmax(0, 1fr); flex: 1 1 0; min-height: 0; }
      .ais-config-groups { padding: 10px; border-right: 1px solid var(--ais-border-light); overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
      .ais-config-item {
        display: grid; grid-template-columns: 20px minmax(0, 1fr); align-items: center; gap: 8px;
        padding: 8px 10px; border-radius: 6px; cursor: pointer; transition: all 0.15s ease;
      }
      .ais-config-item:hover, .ais-config-item.selected { background: var(--ais-card-sub); }
      .ais-config-item.active { background: var(--ais-accent-soft); border-left: 3px solid var(--ais-accent); }
      .ais-config-item button { border: 0; background: transparent; padding: 0; color: inherit; text-align: left; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 6px; }
      .ais-config-editor { padding: 16px; display: flex; flex-direction: column; gap: 12px; flex: 1 1 0; min-height: 0; }
      .ais-editor-head { display: flex; justify-content: space-between; align-items: center; }
      .ais-editor-title { font-size: 16px; font-weight: 800; color: var(--ais-text); margin-right: 8px; }
      .ais-url-editor { display: flex; flex-direction: column; gap: 6px; flex: 1 1 0; min-height: 0; }
      .ais-field-label { font-size: 12px; font-weight: 600; color: var(--ais-text-muted); }
      .ais-url-editor textarea {
        flex: 1 1 0; min-height: 200px; resize: none; border-radius: 7px; padding: 10px;
        border: 1px solid var(--ais-border); background: var(--ais-card-sub); color: var(--ais-text);
        font-family: Consolas, monospace; font-size: 12px; line-height: 18px; outline: none;
      }
      .ais-url-editor textarea:focus { border-color: var(--ais-accent); background: var(--ais-card); }
      .ais-editor-foot { display: flex; justify-content: flex-end; }
      .ais-config-empty { display: flex; align-items: center; justify-content: center; color: var(--ais-text-muted); font-size: 13px; }
      .ais-empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 40px; color: var(--ais-text-muted); border: 1px dashed var(--ais-border); border-radius: 8px; }

      @media (max-width: 960px) {
        .ais-stats-grid { grid-template-columns: repeat(2, 1fr); }
        .ais-workspace, .ais-config-body { grid-template-columns: 1fr; }
        .ais-group-rail { max-height: 200px; }
      }
    `
    if (!style.isConnected) document.head.appendChild(style)
  }

  return {
    onRun: () => openUI(),
    onReady: () => {
      if (Plugin.AutoStart !== false) {
        setTimeout(() => start().catch((error) => (lastError.value = error.message || String(error))), 3000)
      }
    },
    onConfigure: async (config) => {
      stop(false, true)
      return start(config)
    },
    onCoreStarted: () => {
      if (Plugin.AutoStart !== false) {
        setTimeout(() => start().catch((error) => (lastError.value = error.message || String(error))), 1500)
      }
    },
    onCoreStopped: () => stop(true, true),
    onDispose: () => {
      stopModalSync()
      return stop(false, true)
    }
  }
}
