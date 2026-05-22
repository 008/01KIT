import { Config as MHDDOSProxyConfig } from 'lib/module/mhddosproxy'
import { InstallProgress } from 'app/lib/module/module'

export enum Preset {
  GOVERNMENT_AGENCY = 'GOVERNMENT_AGENCY',
  LAPTOP = 'LAPTOP',
  COMFORT = 'COMFORT',
  NORMAL = 'NORMAL',
  MAX = 'MAX',
}

const MODULE_NAME = 'MHDDOS_PROXY' as const

async function installModule (mhddosProxyConfig: MHDDOSProxyConfig, callback: (progress: InstallProgress) => void) {
  const versions = await window.modulesAPI.getAllVersions(MODULE_NAME)
  if (versions.length === 0) {
    throw new Error('No MHDDOS_PROXY versions available for installation')
  }

  const tag = versions[0].tag
  await window.modulesAPI.installVersion(MODULE_NAME, tag, callback)
  mhddosProxyConfig.selectedVersion = tag
  await window.modulesAPI.setConfig(MODULE_NAME, mhddosProxyConfig)
  await window.executionEngineAPI.setModuleToRun(MODULE_NAME)
}

async function getDefaultConfig (): Promise<MHDDOSProxyConfig> {
  return await window.modulesAPI.getConfig('MHDDOS_PROXY')
}

async function applyCommonSystemSettings (): Promise<void> {
  await window.settingsAPI.system.setAutoUpdate(true)
  await window.settingsAPI.system.setStartOnBoot(true)
  await window.settingsAPI.system.setHideInTray(true)
}

export async function configureGovernmentAgencyPreset (callback: (progress: InstallProgress) => void) {
  const mhddosProxyConfig = await getDefaultConfig()

  mhddosProxyConfig.copies = 1
  mhddosProxyConfig.threads = 160

  await installModule(mhddosProxyConfig, callback)

  await window.executionEngineAPI.startModule()
  await applyCommonSystemSettings()
}

export async function configureLaptopPreset (callback: (progress: InstallProgress) => void) {
  const mhddosProxyConfig = await getDefaultConfig()
  mhddosProxyConfig.copies = 1
  mhddosProxyConfig.threads = 1024

  await installModule(mhddosProxyConfig, callback)
  await window.executionEngineAPI.startModule()
  await applyCommonSystemSettings()
}

export async function configureComfortPreset (callback: (progress: InstallProgress) => void) {
  const mhddosProxyConfig = await getDefaultConfig()
  mhddosProxyConfig.copies = 1
  mhddosProxyConfig.threads = 1280

  await installModule(mhddosProxyConfig, callback)
  await window.executionEngineAPI.startModule()
  await applyCommonSystemSettings()
}

export async function configureNormalPreset (callback: (progress: InstallProgress) => void) {
  const mhddosProxyConfig = await getDefaultConfig()
  await installModule(mhddosProxyConfig, callback)
  await window.executionEngineAPI.startModule()
  await applyCommonSystemSettings()
}

export async function configureMaxPreset (callback: (progress: InstallProgress) => void) {
  const mhddosProxyConfig = await getDefaultConfig()

  mhddosProxyConfig.copies = 0 // Auto
  mhddosProxyConfig.threads = 0 // Auto

  await installModule(mhddosProxyConfig, callback)
  await window.executionEngineAPI.startModule()
  await applyCommonSystemSettings()
}

export async function configure (preset: Preset, callback: (progress: InstallProgress) => void) {
  switch (preset) {
    case Preset.GOVERNMENT_AGENCY:
      await configureGovernmentAgencyPreset(callback)
      break
    case Preset.LAPTOP:
      await configureLaptopPreset(callback)
      break
    case Preset.COMFORT:
      await configureComfortPreset(callback)
      break
    case Preset.NORMAL:
      await configureNormalPreset(callback)
      break
    case Preset.MAX:
      await configureMaxPreset(callback)
      break
  }
}
