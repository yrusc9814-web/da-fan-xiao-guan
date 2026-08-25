<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AppButton from './ui/AppButton.vue';
import AppInput from './ui/AppInput.vue';
import { apiRequest, setPinToken } from '../services/api';
interface GateSettings {
  version: number;
  pinEnabled: boolean;
  onboardingCompleted: boolean;
  userNickname: string | null;
  subtitle?: string;
}
const emit = defineEmits<{ unlocked: [] }>(),
  pin = ref(''),
  loading = ref(true),
  error = ref(''),
  mode = ref<'pin' | 'onboarding'>('pin'),
  settings = ref<GateSettings | null>(null),
  nickname = ref(''),
  dinerName = ref('我');
const step = ref(1),
  subtitle = ref('今天也要和喜欢的人，好好吃饭。'),
  userAvatarPath = ref(''),
  pinEnabled = ref(false),
  defaultRepeatDays = ref('7'),
  autoBackupEnabled = ref(true),
  autoDeductInventory = ref(true);
async function initialize() {
  try {
    settings.value = await apiRequest<GateSettings>('/settings');
    if (!settings.value.onboardingCompleted) {
      mode.value = 'onboarding';
      nickname.value = settings.value.userNickname ?? '';
      return;
    }
    if (!settings.value.pinEnabled) {
      emit('unlocked');
      return;
    }
    try {
      await apiRequest('/settings/pin/session');
      emit('unlocked');
      return;
    } catch {
      setPinToken(null);
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法读取本地设置';
  } finally {
    loading.value = false;
  }
}
function nextStep() {
  error.value = '';
  if (step.value === 1 && (!nickname.value.trim() || !dinerName.value.trim())) {
    error.value = '请填写昵称和默认食用者';
    return;
  }
  if (step.value === 2 && pinEnabled.value && !/^\d{4,8}$/.test(pin.value)) {
    error.value = 'PIN 必须是 4–8 位数字';
    return;
  }
  step.value = Math.min(3, step.value + 1);
}
async function completeOnboarding() {
  const repeat = Number(defaultRepeatDays.value);
  if (!settings.value || !Number.isInteger(repeat) || repeat < 0 || repeat > 365) {
    error.value = '推荐避免重复天数必须是 0–365 的整数';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    settings.value = await apiRequest<GateSettings>('/settings/onboarding', {
      method: 'POST',
      body: JSON.stringify({
        version: settings.value.version,
        nickname: nickname.value.trim(),
        dinerName: dinerName.value.trim(),
        subtitle: subtitle.value.trim(),
        userAvatarPath: userAvatarPath.value.trim() || null,
        pinEnabled: pinEnabled.value,
        pin: pinEnabled.value ? pin.value : null,
        defaultRepeatDays: repeat,
        autoBackupEnabled: autoBackupEnabled.value,
        autoDeductInventory: autoDeductInventory.value
      })
    });
    if (pinEnabled.value) {
      const result = await apiRequest<{ valid: boolean; token: string | null }>('/settings/pin/verify', {
        method: 'POST',
        body: JSON.stringify({ pin: pin.value })
      });
      setPinToken(result.token);
    }
    emit('unlocked');
  } catch (e) {
    error.value = e instanceof Error ? e.message : '首次设置失败';
  } finally {
    loading.value = false;
  }
}
async function unlock() {
  loading.value = true;
  error.value = '';
  try {
    const result = await apiRequest<{ valid: boolean; token: string | null }>('/settings/pin/verify', {
      method: 'POST',
      body: JSON.stringify({ pin: pin.value })
    });
    if (!result.valid || !result.token) {
      error.value = 'PIN 不正确';
      return;
    }
    setPinToken(result.token);
    emit('unlocked');
  } catch (e) {
    error.value = e instanceof Error ? e.message : '验证失败';
  } finally {
    loading.value = false;
  }
}
onMounted(initialize);
</script>
<template>
  <main class="pin-gate">
    <section v-if="mode === 'onboarding'" class="app-card">
      <p class="business-eyebrow">First setup · {{ step }} / 3</p>
      <h1>欢迎来到搭饭小馆</h1>
      <template v-if="step === 1"
        ><p>先认识一下。设置只会在最后一步一次性保存。</p>
        <AppInput v-model="nickname" label="你的昵称" /><AppInput v-model="dinerName" label="默认食用者" /><AppInput
          v-model="subtitle"
          label="小馆副标题" /><AppInput v-model="userAvatarPath" label="头像路径（可跳过）" /></template
      ><template v-else-if="step === 2"
        ><p>本机默认通过 8787 端口提供服务。开启局域网访问时，请只在可信 Wi‑Fi 中分享地址。</p>
        <label><input v-model="pinEnabled" type="checkbox" /> 使用访问 PIN</label
        ><AppInput v-if="pinEnabled" v-model="pin" type="password" label="访问 PIN（4–8 位数字）" /></template
      ><template v-else
        ><p>选择推荐、备份与库存确认偏好，之后仍可在设置页修改。</p>
        <AppInput v-model="defaultRepeatDays" label="推荐避免重复天数" /><label
          ><input v-model="autoBackupEnabled" type="checkbox" /> 每日自动备份</label
        ><label><input v-model="autoDeductInventory" type="checkbox" /> 完成计划后提示库存扣减确认</label></template
      >
      <p v-if="error" class="pin-error">{{ error }}</p>
      <div class="gate-actions">
        <AppButton v-if="step > 1" variant="ghost" @click="step--">上一步</AppButton
        ><AppButton v-if="step < 3" @click="nextStep">下一步</AppButton
        ><AppButton v-else :loading="loading" @click="completeOnboarding">完成设置并进入</AppButton>
      </div>
    </section>
    <section v-else class="app-card">
      <p class="business-eyebrow">Local access</p>
      <h1>欢迎回到搭饭小馆</h1>
      <p>请输入本地 PIN 后继续。PIN 只在这台服务所在的本地数据库中验证。</p>
      <AppInput v-model="pin" type="password" label="PIN" error="" @keyup.enter="unlock" />
      <p v-if="error" class="pin-error">{{ error }}</p>
      <AppButton :loading="loading" @click="unlock">进入小馆</AppButton>
    </section>
  </main>
</template>
<style scoped>
.pin-gate {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: var(--space-5);
  background: var(--color-page-bg);
}
.pin-gate section {
  display: grid;
  gap: var(--space-4);
  width: min(100%, 460px);
}
.pin-gate h1,
.pin-gate p {
  margin: 0;
}
.pin-gate label {
  display: flex;
  gap: 10px;
}
.pin-error {
  color: var(--color-danger);
}
.gate-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
