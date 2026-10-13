import * as React from 'react'
import { Check, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@craft-agent/ui'
import { SettingsSecretInput } from '@/components/settings'

interface QQConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When true, treat the flow as "replace existing credentials". */
  reconfigure?: boolean
  onSaved?: () => void
}

type TestResult =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'success' }
  | { state: 'error'; error: string }


export function QQConnectDialog({
  open,
  onOpenChange,
  reconfigure = false,
  onSaved,
}: QQConnectDialogProps) {
  const { t } = useTranslation()
  const [appId, setAppId] = React.useState('')
  const [appSecret, setAppSecret] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [test, setTest] = React.useState<TestResult>({ state: 'idle' })

  React.useEffect(() => {
    if (!open) {
      setAppId('')
      setAppSecret('')
      setTest({ state: 'idle' })
      setSaving(false)
    }
  }, [open])

  React.useEffect(() => { setTest({ state: 'idle' }) }, [appId, appSecret])

  const ready = appId.trim().length > 0 && appSecret.trim().length > 0

  const handleTest = async () => {
    if (!ready) return
    setTest({ state: 'testing' })
    try {
      const result = await window.electronAPI.testQQCredentials({
        appId: appId.trim(),
        appSecret: appSecret.trim(),
      })
      if (result.success) {
        setTest({ state: 'success' })
      } else {
        setTest({ state: 'error', error: result.error ?? t('common.error') })
      }
    } catch (err) {
      setTest({ state: 'error', error: err instanceof Error ? err.message : t('common.error') })
    }
  }

  const handleSave = async () => {
    if (!ready) return
    setSaving(true)
    try {
      await window.electronAPI.saveQQCredentials({
        appId: appId.trim(),
        appSecret: appSecret.trim(),
      })
      toast.success(t('settings.messaging.qq.saved'))
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.messaging.qq.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {reconfigure
              ? t('settings.messaging.qq.reconfigureTitle')
              : t('settings.messaging.qq.connectTitle')}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {t('settings.messaging.qq.instructions')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div>
            <div className="mb-1.5 text-label font-medium">
              {t('settings.messaging.qq.appIdLabel')}
            </div>
            <SettingsSecretInput
              value={appId}
              onChange={setAppId}
              placeholder={t('settings.messaging.qq.appIdPlaceholder')}
              disabled={saving || test.state === 'testing'}
            />
          </div>

          <div>
            <div className="mb-1.5 text-label font-medium">
              {t('settings.messaging.qq.appSecretLabel')}
            </div>
            <SettingsSecretInput
              value={appSecret}
              onChange={setAppSecret}
              placeholder={t('settings.messaging.qq.appSecretPlaceholder')}
              disabled={saving || test.state === 'testing'}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleTest}
              disabled={!ready || test.state === 'testing' || saving}
            >
              {test.state === 'testing' && <Spinner className="text-label" />}
              {t('settings.messaging.qq.testConnection')}
            </Button>

            {test.state === 'success' && (
              <span className="inline-flex items-center gap-1 text-label-sm text-success">
                <Check className="size-3.5" />
                {t('settings.messaging.qq.testOk')}
              </span>
            )}
            {test.state === 'error' && (
              <span className="inline-flex items-center gap-1 text-label-sm text-destructive">
                <X className="size-3.5" />
                {test.error}
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving || test.state === 'testing'}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!ready || test.state !== 'success' || saving}
          >
            {saving && <Spinner className="text-label" />}
            {t('settings.messaging.qq.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
