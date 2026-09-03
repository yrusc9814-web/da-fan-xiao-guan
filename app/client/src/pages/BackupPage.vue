<script setup lang="ts">
import { onMounted, ref } from 'vue';

import AppButton from '../components/ui/AppButton.vue';
import AppDialog from '../components/ui/AppDialog.vue';
import AppInput from '../components/ui/AppInput.vue';
import { apiRequest, getPinToken, setPinToken } from '../services/api';

const file = ref<File | null>(null);
const busy = ref(false);
const message = ref('');
const error = ref('');
const authorizeDialogOpen = ref(false);
const pinEnabled = ref(false);
const pin = ref('');
const localConfirmation = ref(false);

function choose(event: Event): void {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function loadSecurityState(): Promise<void> {
  try {
    const settings = await apiRequest<{ pinEnabled: boolean }>('/settings');
    pinEnabled.value = settings.pinEnabled;
  } catch {
    pinEnabled.value = false;
  }
}

function requestRestore(): void {
  if (!file.value) return;
  error.value = '';
  pin.value = '';
  localConfirmation.value = false;
  authorizeDialogOpen.value = true;
}

async function authorizeAndRestore(): Promise<void> {
  if (!file.value || (pinEnabled.value ? !pin.value : !localConfirmation.value)) return;
  busy.value = true;
  error.value = '';
  try {
    let authorization: { token: string };
    if (pinEnabled.value) {
      authorization = await apiRequest('/settings/high-risk/authorize', {
        method: 'POST',
        body: JSON.stringify({ action: 'RESTORE', pin: pin.value })
      });
    } else {
      const intent = await apiRequest<{ challenge: string }>('/settings/high-risk/authorize', {
        method: 'POST',
        body: JSON.stringify({ action: 'RESTORE' })
      });
      authorization = await apiRequest('/settings/high-risk/authorize', {
        method: 'POST',
        body: JSON.stringify({ action: 'RESTORE', challenge: intent.challenge, confirmation: 'RESTORE_LOCAL_DATA' })
      });
    }
    const body = new FormData();
    body.append('file', file.value);
    await apiRequest('/backups/restore', {
      method: 'POST',
      body,
      headers: { 'X-High-Risk-Token': authorization.token }
    });
    setPinToken(null);
    authorizeDialogOpen.value = false;
    message.value = '恢复成功，建议重启小馆后继续使用。';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '恢复失败，当前数据已回滚';
  } finally {
    busy.value = false;
  }
}

async function exportBackup(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const response = await fetch('/api/v1/backups/export', {
      headers: getPinToken() ? { 'X-App-Pin-Token': getPinToken()! } : {}
    });
    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error?.message ?? '导出失败');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `搭饭小馆-${new Date().toLocaleDateString('sv-SE')}.zip`;
    anchor.click();
    URL.revokeObjectURL(url);
    message.value = '备份已导出';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '导出失败';
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void loadSecurityState();
});
</script>

<template>
  <section class="business-page">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">数据安全</p>
        <h1>备份与恢复</h1>
        <p>备份文件包含你的菜谱、库存、记录、图片和设置；恢复时会先完整校验备份内容，再替换当前数据。</p>
      </div>
      <AppButton :loading="busy" @click="exportBackup">导出备份</AppButton>
    </header>
    <div class="app-card backup-panel">
      <h2>从备份恢复</h2>
      <p>选择本应用导出的备份文件。如果文件不完整或已损坏，恢复会在替换前被拒绝，现有数据不受影响。</p>
      <input type="file" accept=".zip,application/zip" @change="choose" />
      <AppButton :disabled="!file" :loading="busy" @click="requestRestore">校验并恢复</AppButton>
      <p v-if="message" class="backup-success">{{ message }}</p>
      <p v-if="error" class="backup-error">{{ error }}</p>
    </div>

    <AppDialog v-model="authorizeDialogOpen" title="恢复前二次验证">
      <p>恢复会用备份中的数据替换当前的小馆数据。系统会先自动保存一份当前数据用于恢复失败时回退。</p>
      <AppInput v-if="pinEnabled" v-model="pin" type="password" label="再次输入本地 PIN" />
      <label v-else class="backup-confirmation">
        <input v-model="localConfirmation" type="checkbox" />
        <span>我确认要用所选备份替换当前本地数据</span>
      </label>
      <template #footer>
        <AppButton variant="ghost" @click="authorizeDialogOpen = false">取消</AppButton>
        <AppButton :disabled="pinEnabled ? !pin : !localConfirmation" :loading="busy" @click="authorizeAndRestore"
          >二次验证并恢复</AppButton
        >
      </template>
    </AppDialog>
  </section>
</template>

<style scoped>
.backup-panel {
  display: grid;
  gap: var(--space-4);
  max-width: 760px;
}
.backup-panel h2,
.backup-panel p {
  margin: 0;
}
.backup-success {
  color: var(--color-success);
}
.backup-error {
  color: var(--color-danger);
}
.backup-confirmation {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.backup-confirmation input {
  margin-top: var(--space-1);
}
</style>
