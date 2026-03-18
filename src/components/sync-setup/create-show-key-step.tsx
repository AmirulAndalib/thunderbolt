import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { formatRecoveryKeyForDisplay } from '@/crypto'
import { Check, Copy } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

type CreateShowKeyStepProps = {
  recoveryKey: string
  recoveryKeySaved: boolean
  onConfirmSaved: (saved: boolean) => void
  onContinue: () => void
}

export const CreateShowKeyStep = ({
  recoveryKey,
  recoveryKeySaved,
  onConfirmSaved,
  onContinue,
}: CreateShowKeyStepProps) => {
  const [copied, setCopied] = useState(false)
  const formattedKey = useMemo(() => formatRecoveryKeyForDisplay(recoveryKey), [recoveryKey])

  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const handleCopy = async () => {
    await navigator.clipboard.writeText(recoveryKey)
    setCopied(true)
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        This is your recovery key. Save it somewhere safe — you'll need it to restore access to your encrypted data if
        you lose your device.
      </p>

      <div className="rounded-lg border bg-muted/50 p-4">
        <code className="text-xs font-mono break-all leading-relaxed select-all">{formattedKey}</code>
      </div>

      <Button variant="outline" size="sm" onClick={handleCopy}>
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {copied ? 'Copied' : 'Copy to clipboard'}
      </Button>

      <label className="flex items-center gap-2 cursor-pointer">
        <Checkbox checked={recoveryKeySaved} onCheckedChange={(checked) => onConfirmSaved(checked === true)} />
        <span className="text-sm">I have saved my recovery key</span>
      </label>

      <Button disabled={!recoveryKeySaved} onClick={onContinue}>
        Continue
      </Button>
    </div>
  )
}
