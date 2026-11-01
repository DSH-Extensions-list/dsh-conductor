/** Client-side settings page for Conductor. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { ContextSettingsPage } from './ContextSettingsPage.js'
import type { ContextSettingsInjected, TaskOrchestratorSettings } from './ContextSettingsPage.js'
import { en, zh, type ContextSettingsLocaleKey } from './locales.js'
import { SettingsNotice, SettingsNotices } from './SettingsNotice.js'

/** Dictionary namespace registered for the plugin's page. */
export const NS = 'settings.conductor'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Conductor Settings section copy. */
    'settings.conductor': ContextSettingsLocaleKey
  }
}

/** Client services required by the Settings section and its form. */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session']

/**
 * Register the Settings navigation entry while this plugin is enabled.
 * @param ctx - The browser plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  const form = ctx.configForms.get<TaskOrchestratorSettings>('conductor')
  const notices = new SettingsNotices()
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'conductor settings dictionaries')
  const loadModels: ContextSettingsInjected['loadModels'] = async () => {
    const response = await ctx.remote.session.modelCatalog()
    if (!response.ok) throw new Error(response.error.message)
    return response.value
  }
  const injected = (): ContextSettingsInjected => ({ form, notify: notices.publish, loadModels })
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'conductor',
    order: 16,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, ContextSettingsPage)), 'conductor Settings section')
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'conductor.settings-notice', locale: NS,
    inject: () => ({ notices }),
  }, SettingsNotice)), 'conductor settings outcomes')
}
