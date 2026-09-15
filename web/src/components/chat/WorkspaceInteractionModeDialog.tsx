import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { InteractionMode } from '../../types';
import { InteractionModeSelector } from './InteractionModeSelector';

interface WorkspaceInteractionModeDialogProps {
  open: boolean;
  workspaceName: string;
  currentMode: InteractionMode;
  currentHrAgentEnabled: boolean;
  onClose: () => void;
  onSave: (mode: InteractionMode) => Promise<boolean>;
  onSaveHrAgentEnabled: (enabled: boolean) => Promise<boolean>;
}

export function WorkspaceInteractionModeDialog({
  open,
  workspaceName,
  currentMode,
  currentHrAgentEnabled,
  onClose,
  onSave,
  onSaveHrAgentEnabled,
}: WorkspaceInteractionModeDialogProps) {
  const [draftMode, setDraftMode] = useState(currentMode);
  const [draftHrAgentEnabled, setDraftHrAgentEnabled] = useState(
    currentHrAgentEnabled,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraftMode(currentMode);
      setDraftHrAgentEnabled(currentHrAgentEnabled);
    }
  }, [currentHrAgentEnabled, currentMode, open]);

  const handleSave = async () => {
    if (draftMode === currentMode && draftHrAgentEnabled === currentHrAgentEnabled) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      const modeChanged = draftMode !== currentMode;
      const hrAgentChanged = draftHrAgentEnabled !== currentHrAgentEnabled;
      const saved = !modeChanged || (await onSave(draftMode));
      const hrAgentSaved =
        !saved || !hrAgentChanged || (await onSaveHrAgentEnabled(draftHrAgentEnabled));
      if (!saved || !hrAgentSaved) {
        toast.error(saved ? 'HR Agent 开关保存失败，请重试' : '工作区设置保存失败，请重试');
        return;
      }
      toast.success(
        modeChanged
          ? `已切换为${draftMode === 'proactive' ? '主动模式' : 'Assistant 模式'}`
          : 'HR Agent 开关已保存',
      );
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>工作区回复模式</DialogTitle>
          <DialogDescription>
            设置“{workspaceName}”由谁控制对用户发消息的时机和数量。
          </DialogDescription>
        </DialogHeader>

        <InteractionModeSelector
          value={draftMode}
          onChange={setDraftMode}
          name="workspace-interaction-mode"
          disabled={saving}
          description="同一模式会应用到该工作区的 Web、飞书和所有已绑定渠道；渠道只负责选择流式卡片、普通消息或消息气泡等具体呈现。"
        />
        <label className="flex items-start gap-3 rounded-md border bg-background px-3 py-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={draftHrAgentEnabled}
            onChange={(event) => setDraftHrAgentEnabled(event.target.checked)}
            disabled={saving}
          />
          <span>
            启用 HR Agent 工具
            <span className="mt-1 block text-xs text-muted-foreground">
              关闭后运行时不再注册 HR 工具，host capability 同步拒绝。
            </span>
          </span>
        </label>

        <p className="rounded-md bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
          切换会安全重启该工作区的智能体
          运行时；身份、Skills、记忆与渠道绑定保持不变。正在运行的任务会先停止，后续消息按新模式处理。
        </p>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={saving}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            aria-busy={saving}
          >
            {saving && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {saving ? '正在保存…' : '保存更改'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
