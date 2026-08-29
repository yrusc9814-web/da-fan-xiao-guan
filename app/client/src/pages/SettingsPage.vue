<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AppButton from '../components/ui/AppButton.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import { apiRequest, ApiRequestError, setPinToken } from '../services/api';

interface Settings {
  id: number;
  appName: string;
  subtitle: string;
  userNickname: string;
  autoBackupEnabled: boolean;
  autoDeductInventory: boolean;
  defaultRepeatDays: number;
  onboardingCompleted: boolean;
  pinEnabled: boolean;
  version: number;
}
const data = ref<Settings | null>(null),
  loading = ref(true),
  saving = ref(false),
  error = ref(''),
  message = ref(''),
  pin = ref(''),
  qr = ref(''),
  qrUrl = ref(''),
  qrMessage = ref(''),
  qrCandidates = ref<string[]>([]),
  selectedHost = ref(''),
  repeatDays = ref('7');
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const value = await apiRequest<Settings & { userNickname: string | null }>('/settings');
    data.value = { ...value, userNickname: value.userNickname ?? '' };
    repeatDays.value = String(value.defaultRepeatDays);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (!data.value) return;
  const repeat = Number(repeatDays.value);
  if (!Number.isInteger(repeat) || repeat < 0 || repeat > 365) {
    error.value = '推荐避免重复天数必须是 0–365 的整数';
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    data.value = await apiRequest('/settings', {
      method: 'PUT',
      body: JSON.stringify({
        version: data.value.version,
        appName: data.value.appName,
        subtitle: data.value.subtitle,
        userNickname: data.value.userNickname,
        autoBackupEnabled: data.value.autoBackupEnabled,
        autoDeductInventory: data.value.autoDeductInventory,
        defaultRepeatDays: repeat,
        onboardingCompleted: true
      })
    });
    message.value = '设置已保存';
  } catch (e) {
    handle(e);
  } finally {
    saving.value = false;
  }
}
async function savePin(enabled: boolean) {
  if (!data.value) return;
  try {
    const nextPin = pin.value;
    data.value = await apiRequest('/settings/pin', {
      method: 'PUT',
      body: JSON.stringify({ version: data.value.version, pin: enabled ? nextPin : null, enabled })
    });
    if (enabled) {
      const session = await apiRequest<{ valid: boolean; token: string | null }>('/settings/pin/verify', {
        method: 'POST',
        body: JSON.stringify({ pin: nextPin })
      });
      setPinToken(session.token);
    } else setPinToken(null);
    pin.value = '';
    message.value = enabled ? 'PIN 已启用' : 'PIN 已关闭';
  } catch (e) {
    handle(e);
  }
}
function hostFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}
async function makeQr(host?: string) {
  try {
    const result = await apiRequest<{
      url: string | null;
      dataUrl: string | null;
      candidates: string[];
      message: string | null;
    }>('/settings/access-qr', { query: host ? { host } : {} });
    qrCandidates.value = result.candidates;
    qrMessage.value = result.message ?? '';
    qrUrl.value = result.url ?? '';
    qr.value = result.dataUrl ?? '';
    selectedHost.value = result.url ? hostFromOrigin(result.url) : '';
  } catch (e) {
    handle(e);
  }
}
function handle(e: unknown) {
  error.value =
    e instanceof ApiRequestError && e.status === 409
      ? '设置已被其他设备修改，请刷新后重试'
      : e instanceof Error
        ? e.message
        : '操作失败';
}
onMounted(load);
</script>
<template>
  <section class="business-page">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">Local settings</p>
        <h1>系统设置</h1>
        <p>正式版固定使用 8787 端口；其余设置以 SQLite 为运行时事实源。</p>
      </div>
      <AppButton :loading="saving" @click="save">保存设置</AppButton>
    </header>
    <AppErrorState v-if="error" title="设置操作失败" :description="error" @retry="load" />
    <p v-if="message" class="business-success">{{ message }}</p>
    <div v-if="loading" class="settings-grid"><AppSkeleton v-for="index in 4" :key="index" height="160px" /></div>
    <template v-else-if="data"
      ><div class="business-form app-card">
        <AppInput v-model="data.appName" label="应用名称" /><AppInput v-model="data.subtitle" label="副标题" /><AppInput
          v-model="data.userNickname"
          label="昵称"
        /><AppInput v-model="repeatDays" label="推荐避免重复天数" />
      </div>
      <div class="settings-grid">
        <section class="app-card">
          <h2>自动化偏好</h2>
          <label><input v-model="data.autoBackupEnabled" type="checkbox" /> 每日自动备份</label
          ><label><input v-model="data.autoDeductInventory" type="checkbox" /> 完成计划后提示库存扣减确认</label>
        </section>
        <section class="app-card">
          <h2>本地 PIN</h2>
          <p>仅接受 4–8 位数字。</p>
          <AppInput v-model="pin" type="password" label="新 PIN" />
          <div class="business-card__actions">
            <AppButton variant="ghost" @click="savePin(false)">关闭 PIN</AppButton
            ><AppButton @click="savePin(true)">启用 PIN</AppButton>
          </div>
        </section>
        <section class="app-card">
          <h2>手机访问二维码</h2>
          <p>二维码只编码当前局域网访问地址，不依赖外部服务。</p>
          <AppButton variant="secondary" @click="makeQr()">生成二维码</AppButton>
          <p v-if="qrUrl">{{ qrUrl }}</p>
          <label v-if="qrCandidates.length > 1" class="app-field"
            ><span class="app-field__label">访问地址</span>
            <select :value="selectedHost" @change="makeQr(($event.target as HTMLSelectElement).value)">
              <option v-for="candidate in qrCandidates" :key="candidate" :value="hostFromOrigin(candidate)">
                {{ candidate }}
              </option>
            </select></label
          >
          <img v-if="qr" :src="qr" alt="局域网访问二维码" />
          <p v-else-if="qrMessage">{{ qrMessage }}</p>
        </section>
        <section class="app-card">
          <h2>食用者与偏好</h2>
          <p>管理忌口、过敏与默认餐量。</p>
          <RouterLink class="app-button app-button--secondary app-button--md" to="/diners">管理食用者</RouterLink>
        </section>
        <section class="app-card">
          <h2>最近删除</h2>
          <p>在 30 天内恢复误删的业务数据。</p>
          <RouterLink class="app-button app-button--secondary app-button--md" to="/settings/deleted-items"
            >打开回收站</RouterLink
          >
        </section>
      </div></template
    >
  </section>
</template>
<style scoped>
.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}
.settings-grid section {
  display: grid;
  align-content: start;
  gap: 14px;
}
.settings-grid h2,
.settings-grid p {
  margin: 0;
}
.settings-grid label {
  display: flex;
  gap: 10px;
}
.settings-grid img {
  width: 220px;
  max-width: 100%;
  border-radius: 16px;
}
@media (max-width: 700px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}
</style>
