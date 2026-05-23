import { execFileSync, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { Module, Version, InstallProgress, InstallationTarget, BaseConfig, ModuleName, InstallationErrorCodes } from './module'
import { getCPUArchitecture } from './archLib'
import { convertTrafficValueToBytes } from '../utils/trafficUnits'

export interface Config extends BaseConfig {
  copies: number;
  threads: number;
  useMyIP: number;
}

type SupportedPlatform = 'linux' | 'win32' | 'darwin'
type SupportedArch = 'x64' | 'arm64' | 'ia32'

interface ModuleBinaryAsset {
  executableName: string
  downloadUrl: string
}

const MHDDOS_PROXY_RELEASE_BASE_URL = 'https://github.com/008/02MHtest/raw/refs/heads/main/bin/'

const MHDDOS_PROXY_DOWNLOAD_ASSETS: Readonly<Record<SupportedPlatform, Partial<Record<SupportedArch, ModuleBinaryAsset>>>> = {
  linux: {
    x64: {
      executableName: 'mhddos_proxy_linux',
      downloadUrl: `${MHDDOS_PROXY_RELEASE_BASE_URL}/controller_linux`
    }
    // arm64: {
    //   executableName: 'mhddos_proxy_linux_arm64',
    //   downloadUrl: `${MHDDOS_PROXY_RELEASE_BASE_URL}/mhddos_proxy_linux_arm64`
    // },
    // ia32: {
    //   executableName: 'mhddos_proxy_linux_x86',
    //   downloadUrl: `${MHDDOS_PROXY_RELEASE_BASE_URL}/controller_mac`
    // }
  },
  win32: {
    x64: {
      executableName: 'mhddos_proxy_win.exe',
      downloadUrl: `${MHDDOS_PROXY_RELEASE_BASE_URL}/controller_win.exe`
    }
    // ia32: {
    //   executableName: 'mhddos_proxy_win_x86.exe',
    //   downloadUrl: `${MHDDOS_PROXY_RELEASE_BASE_URL}/mhddos_proxy_win_x86.exe`
    // }
  },
  darwin: {
    x64: {
      executableName: 'mhddos_proxy_macos',
      downloadUrl: `${MHDDOS_PROXY_RELEASE_BASE_URL}/controller_mac`
    }
    // arm64: {
    //   executableName: 'mhddos_proxy_macos_arm64',
    //   downloadUrl: `${MHDDOS_PROXY_RELEASE_BASE_URL}/mhddos_proxy_macos_arm64`
    // }
  }
}

function isSupportedPlatform (platform: NodeJS.Platform): platform is SupportedPlatform {
  return platform === 'linux' || platform === 'win32' 
  // || platform === 'darwin'
}

function resolveAssetFor (platform: NodeJS.Platform, arch: SupportedArch): ModuleBinaryAsset | null {
  if (!isSupportedPlatform(platform)) {
    return null
  }

  return MHDDOS_PROXY_DOWNLOAD_ASSETS[platform][arch] ?? null
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g

const LINE_SIGNATURES = {
  en: ['traffic', 'connections', 'packets'],
  ua: ['трафік', 'пакети', 'потужність'],
  de: ['verkehr', 'verbindungen', 'pakete']
} as const

const TRAFFIC_LABELS = {
  en: ['traffic'],
  ua: ['трафік'],
  de: ['verkehr']
} as const

const REQUIRED_METRIC_LABELS = {
  en: ['traffic', 'connections', 'packets'],
  ua: ['трафік', 'з\'єднань', 'пакети'],
  de: ['verkehr', 'verbindungen', 'pakete']
} as const

function stripAnsiCodes (value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, '')
}

function normalizeForMatch (value: string): string {
  return stripAnsiCodes(value).replace(/\r/g, '').toLocaleLowerCase()
}

function hasLineSignature (line: string, signatures: readonly string[]): boolean {
  return signatures.every((signature) => line.includes(signature))
}

function escapeRegExp (value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractTrafficValue (rawLine: string, labels: readonly string[]): string | null {
  for (const label of labels) {
    const match = rawLine.match(new RegExp(`${escapeRegExp(label)}\\s*:\\s*([^|]+)`, 'i'))
    if (match?.[1]) {
      return match[1].trim()
    }
  }

  return null
}

function parseLabeledMetrics (rawLine: string): Map<string, string> {
  const normalizedLine = normalizeForMatch(rawLine)
  const metrics = new Map<string, string>()

  for (const segment of normalizedLine.split(',')) {
    const separatorIndex = segment.indexOf(':')
    if (separatorIndex === -1) {
      continue
    }

    const label = segment.slice(0, separatorIndex).trim()
    const value = segment.slice(separatorIndex + 1).trim()
    if (label !== '' && value !== '') {
      metrics.set(label, value)
    }
  }

  return metrics
}

function hasRequiredMetrics (metrics: Map<string, string>, labels: readonly string[]): boolean {
  return labels.every((label) => metrics.has(label))
}

function removeCustomLanguageArguments (args: string[]): string[] {
  const result: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--lang') {
      index += 1
      continue
    }

    if (arg.startsWith('--lang=')) {
      continue
    }

    result.push(arg)
  }

  return result
}

function resolveModuleLanguage (language: 'en-US' | 'ua-UA' | 'de-DE'): 'en' | 'ua' | 'de' {
  if (language === 'ua-UA') {
    return 'ua'
  }

  if (language === 'de-DE') {
    return 'de'
  }

  return 'en'
}

export class MHDDOSProxy extends Module<Config> {
  private workerMonitorInterval?: ReturnType<typeof setInterval>

  public override get name (): ModuleName { return 'MHDDOS_PROXY' }
  public override get homeURL (): string { return 'https://github.com/' }
  public override get supportedInstallationTargets (): Array<InstallationTarget> {
    return [
      { arch: 'x64', platform: 'linux' },
      { arch: 'arm64', platform: 'linux' },
      { arch: 'ia32', platform: 'linux' },
      { arch: 'x64', platform: 'win32' },
      { arch: 'ia32', platform: 'win32' }
      // { arch: 'x64', platform: 'darwin' },
      // { arch: 'arm64', platform: 'darwin' }
    ]
  }

  protected override get defaultConfig (): Config {
    return {
      autoUpdate: true,
      executableArguments: ['--per-target'],
      copies: 1,
      threads: 128,
      useMyIP: 0
    }
  }

  override async getAllVersions (): Promise<Version[]> {
    const defaultTag = 'latest'
    const installDirectory = await this.getInstallationDirectory()
    const installed = await fs.promises.access(path.join(installDirectory, defaultTag))
      .then(() => true)
      .catch(() => false)

    return [{
      tag: defaultTag,
      name: 'Latest',
      body: 'Installed from direct hardcoded release URL.',
      installed
    }]
  }

  override async *installVersion (versionTag: string): AsyncGenerator<InstallProgress, void, void> {
    const asset = resolveAssetFor(process.platform, getCPUArchitecture())
    if (!asset) {
      yield {
        stage: 'FAILED',
        progress: 0,
        errorCode: InstallationErrorCodes.UNSUPPORTED_PLATFORM,
        errorMessage: `Your architecture is "${getCPUArchitecture()}" and platform "${process.platform}" which is not supported.`
      }
      return
    }

    const installDirectory = await this.getInstallationDirectory()
    const cacheDirectory = await this.getCacheDirectory()
    const tempDownoloadPath = path.join(cacheDirectory, asset.executableName)

    try {
      for await (const progress of this.downloadFile(asset.downloadUrl, tempDownoloadPath)) {
        yield { stage: 'DOWNLOADING', progress: progress.progress }
      }
    } catch (err) {
      yield { stage: 'FAILED', progress: 0, errorCode: InstallationErrorCodes.UNKNOWN, errorMessage: `Cant download release asset file: ${err}` }
      return
    }

    yield { stage: 'EXTRACTING', progress: 0 }
    try {
      await this.extractArchive(tempDownoloadPath, path.join(installDirectory, versionTag))
    } catch (err) {
      yield { stage: 'FAILED', progress: 0, errorCode: InstallationErrorCodes.UNKNOWN, errorMessage: `Cant extract archive: ${err}` }
      return
    }

    yield { stage: 'VALIDATING', progress: 0 }
    yield { stage: 'DONE', progress: 0 }
  }

  override executableOutputToString (data: Buffer) {
    return data.toString()
  }

  async killProcessesOnWindows (): Promise<void> {
    const filename = resolveAssetFor('win32', getCPUArchitecture())?.executableName ?? 'mhddos_proxy_win.exe'

    await new Promise<void>((resolve) => {
      const handler = spawn('taskkill', ['/F', '/T', '/IM', filename], { windowsHide: true })
      const finish = () => resolve()
      handler.once('close', finish)
      handler.once('error', finish)
      handler.once('exit', finish)
    })
  }

  private clearWorkerMonitor () {
    if (this.workerMonitorInterval) {
      clearInterval(this.workerMonitorInterval)
      this.workerMonitorInterval = undefined
    }
  }

  private hasRunningWindowsWorkers (): boolean {
    if (process.platform !== 'win32') {
      return false
    }

    const filename = resolveAssetFor('win32', getCPUArchitecture())?.executableName ?? 'mhddos_proxy_win.exe'

    try {
      const output = execFileSync(
        'tasklist',
        ['/FI', `IMAGENAME eq ${filename}`, '/FO', 'CSV', '/NH'],
        {
          windowsHide: true,
          encoding: 'utf8'
        }
      )

      return output.trim() !== '' && !output.includes('No tasks are running')
    } catch {
      return false
    }
  }

  protected override shouldIgnoreProcessClose (code: number | null): boolean {
    return code !== null && process.platform === 'win32' && this.hasRunningWindowsWorkers()
  }

  private startWorkerMonitor () {
    if (process.platform !== 'win32') {
      return
    }

    this.clearWorkerMonitor()
    this.workerMonitorInterval = setInterval(() => {
      if (!this.hasRunningWindowsWorkers()) {
        this.clearWorkerMonitor()
        this.clearAutoUpdateInterval()
        if (this.executedProcessHandler !== undefined) {
          this.executedProcessHandler = undefined
          this.emit('execution:stopped', { type: 'execution:stopped', exitCode: 0 })
        }
      }
    }, 1500)
  }

  protected override async stopExecutable (): Promise<void> {
    if (process.platform === 'win32') {
      this.clearWorkerMonitor()
      this.clearAutoUpdateInterval()
      await this.killProcessesOnWindows()
      this.executedProcessHandler = undefined
      return
    }

    await super.stopExecutable()
  }

  override async start (): Promise<void> {
    if (process.platform === 'win32') {
      this.clearWorkerMonitor()
      await this.killProcessesOnWindows()
    }

    const settings = await this.settings.getData()
    const lang = resolveModuleLanguage(settings.system.language)

    const config = await this.getConfig()

    const args: string[] = []
    if (settings.itarmy.uuid !== '') {
      args.push('--user-id', settings.itarmy.uuid)
    }
    args.push('--no-updates')
    if (config.copies !== 0) {
      args.push('--copies', config.copies.toString())
    }
    if (config.copies === 0) {
      args.push('--copies', 'auto')
    }
    if (config.threads > 0) {
      args.push('--threads', config.threads.toString())
    }
    if (config.useMyIP > 0) {
      args.push('--use-my-ip', config.useMyIP.toString())
    }
    args.push('--source', 'itarmykit')
    args.push(...removeCustomLanguageArguments(config.executableArguments.filter((arg) => arg !== '')))
    args.push('--lang', lang)

    const currentAsset = resolveAssetFor(process.platform, getCPUArchitecture())
    if (!currentAsset) {
      throw new Error(`Unsupported platform ${process.platform} and architecture ${getCPUArchitecture()} for MHDDOS_PROXY`)
    }

    const handler = await this.startExecutable(currentAsset.executableName, args)
    if (process.platform === 'win32') {
      this.startWorkerMonitor()
    }

    let lastStatisticsEvent: Date | null = null
    let statisticsBuffer = ''
    handler.stdout.on('data', (data: Buffer) => {
      statisticsBuffer += data.toString()

      const lines = statisticsBuffer.split(/\r?\n/)
      if (/\r?\n$/.test(statisticsBuffer)) {
        statisticsBuffer = ''
      } else {
        statisticsBuffer = lines.pop() as string
      }

      const DEBUG_MHDDOS = process.env.MHDDOS_PROXY_DEBUG === '1' || process.env.ITARMYKIT_DEBUG === '1'

      for (const line of lines) {
          try {
            const normalizedLine = normalizeForMatch(line)
            const metrics = parseLabeledMetrics(line)

            if (DEBUG_MHDDOS) {
              try {
                const metricsArray = Array.from(metrics.entries())
                const sig = lang === 'ua' ? LINE_SIGNATURES.ua : lang === 'de' ? LINE_SIGNATURES.de : LINE_SIGNATURES.en
                const reqLabels = lang === 'ua' ? REQUIRED_METRIC_LABELS.ua : lang === 'de' ? REQUIRED_METRIC_LABELS.de : REQUIRED_METRIC_LABELS.en
                const signatureOk = hasLineSignature(normalizedLine, sig)
                const requiredOk = hasRequiredMetrics(metrics, reqLabels)
                // eslint-disable-next-line no-console
                console.log(`[MHDDOSProxy:DEBUG] normalized='${normalizedLine}', signatureOk=${signatureOk}, requiredOk=${requiredOk}, metrics=${JSON.stringify(metricsArray)}`)
              } catch (err) {
                // ignore debug errors
              }
            }
          if (lang === 'ua') {
            if (!hasLineSignature(normalizedLine, LINE_SIGNATURES.ua) || !hasRequiredMetrics(metrics, REQUIRED_METRIC_LABELS.ua)) {
              continue
            }
          } else if (lang === 'de') {
            if (!hasLineSignature(normalizedLine, LINE_SIGNATURES.de) || !hasRequiredMetrics(metrics, REQUIRED_METRIC_LABELS.de)) {
              continue
            }
          } else if (!hasLineSignature(normalizedLine, LINE_SIGNATURES.en) || !hasRequiredMetrics(metrics, REQUIRED_METRIC_LABELS.en)) {
            continue
          }

          let bytesSend = 0

          const msg = lang === 'ua'
            ? metrics.get(TRAFFIC_LABELS.ua[0]) ?? extractTrafficValue(line, TRAFFIC_LABELS.ua)
            : lang === 'de'
              ? metrics.get(TRAFFIC_LABELS.de[0]) ?? extractTrafficValue(line, TRAFFIC_LABELS.de)
              : metrics.get(TRAFFIC_LABELS.en[0]) ?? extractTrafficValue(line, TRAFFIC_LABELS.en)

          if (!msg) {
            continue
          }

          const currentSendBitrate = convertTrafficValueToBytes(msg)
          if (currentSendBitrate <= 0) {
            continue
          }

          if (lastStatisticsEvent != null) {
            const now = new Date()
            const timeDiff = (now.getTime() - lastStatisticsEvent.getTime()) / 1000.0
            if (timeDiff > 60) {
              lastStatisticsEvent = new Date()
              continue
            }

            if (timeDiff > 0) {
              bytesSend = currentSendBitrate * timeDiff
            }
          }
          lastStatisticsEvent = new Date()

          this.emit('execution:statistics', {
            type: 'execution:statistics',
            bytesSend,
            currentSendBitrate,
            timestamp: new Date().getTime()
          })
        } catch (e) {
          console.error(String(e) + '\n' + line)
        }
      }
    })
  }

  override async stop (): Promise<void> {
    await this.stopExecutable()
  }
}
