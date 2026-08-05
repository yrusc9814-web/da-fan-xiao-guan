<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import AppIcon from '../components/AppIcon.vue';
import AppBadge from '../components/ui/AppBadge.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppCard from '../components/ui/AppCard.vue';
import AppDialog from '../components/ui/AppDialog.vue';
import AppDrawer from '../components/ui/AppDrawer.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppIconButton from '../components/ui/AppIconButton.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppSectionHeader from '../components/ui/AppSectionHeader.vue';
import AppSelect from '../components/ui/AppSelect.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import AppTabs from '../components/ui/AppTabs.vue';
import AppTextarea from '../components/ui/AppTextarea.vue';
import AppToast from '../components/ui/AppToast.vue';
import { useAppStore } from '../stores/app';
import { getResponsiveMode } from '../utils/responsive';

type ResponsiveMode = '桌面' | '平板' | '移动';

const appStore = useAppStore();
const responsiveMode = ref<ResponsiveMode>('桌面');
const dialogOpen = ref(false);
const drawerOpen = ref(false);
const toastOpen = ref(false);
const tab = ref('default');
const inputValue = ref('');
const selectValue = ref('default');
const textareaValue = ref('');

const modeLabel = computed(() => `当前响应式模式：${responsiveMode.value}`);
const tabs = [
  { label: '默认', value: 'default' },
  { label: '辅助', value: 'assist' }
];
const selectOptions = [
  { label: '请选择一个选项', value: 'default' },
  { label: '组件状态演示', value: 'preview' }
];

function updateResponsiveMode(): void {
  const width = window.innerWidth;
  const mode = getResponsiveMode(width);
  responsiveMode.value = mode === 'desktop' ? '桌面' : mode === 'tablet' ? '平板' : '移动';
}

onMounted(() => {
  void appStore.checkHealth();
  updateResponsiveMode();
  window.addEventListener('resize', updateResponsiveMode);
});

onBeforeUnmount(() => window.removeEventListener('resize', updateResponsiveMode));
</script>

<template>
  <section class="temporary-home" aria-labelledby="page-title">
    <header class="page-heading">
      <div>
        <p class="component-preview__label">节点 3 · 设计系统与响应式框架</p>
        <h1 id="page-title">搭饭小馆</h1>
        <p>统一视觉变量、双端页面框架与公共 UI 组件预览。</p>
      </div>
      <AppBadge tone="primary">{{ modeLabel }}</AppBadge>
    </header>

    <AppCard class="system-status" :data-status="appStore.backendStatus" aria-live="polite">
      <span class="status-dot" aria-hidden="true"></span>
      <span>后端健康状态：{{ appStore.statusLabel }}</span>
      <span v-if="appStore.health" class="system-status__meta">{{ appStore.health.app }}</span>
      <AppButton class="system-status__action" variant="ghost" size="sm" :loading="appStore.backendStatus === 'checking'" @click="appStore.checkHealth()">
        重新检查
      </AppButton>
    </AppCard>

    <AppErrorState v-if="appStore.errorMessage" title="后端健康检查失败" :description="appStore.errorMessage" />

    <AppCard>
      <AppSectionHeader title="公共组件预览" description="仅用于验证状态、交互和可访问性，不包含正式业务数据。">
        <template #actions>
          <AppButton variant="secondary" size="sm" @click="toastOpen = true">显示 Toast</AppButton>
        </template>
      </AppSectionHeader>

      <div class="component-preview-grid">
        <div class="component-preview">
          <span class="component-preview__label">按钮、标签与图标按钮</span>
          <div class="cluster">
            <AppButton>默认按钮</AppButton>
            <AppButton variant="secondary">次级按钮</AppButton>
            <AppButton variant="ghost">幽灵按钮</AppButton>
            <AppButton loading>加载中</AppButton>
            <AppBadge tone="green">成功状态</AppBadge>
            <AppBadge tone="orange">提示状态</AppBadge>
            <AppIconButton icon="plus" label="新增占位" />
          </div>
        </div>

        <div class="component-preview">
          <span class="component-preview__label">表单控件</span>
          <div class="form-preview-grid">
            <AppInput v-model="inputValue" label="输入框" placeholder="请输入内容" />
            <AppSelect v-model="selectValue" label="选择框" :options="selectOptions" />
            <AppTextarea v-model="textareaValue" label="多行文本" placeholder="请输入说明" :rows="3" />
          </div>
        </div>

        <div class="component-preview">
          <span class="component-preview__label">分页标签与反馈状态</span>
          <AppTabs v-model="tab" :tabs="tabs" />
          <div class="state-preview-row">
            <AppSkeleton :lines="2" />
            <AppEmptyState title="空状态" description="暂无内容" />
          </div>
        </div>

        <div class="component-preview">
          <span class="component-preview__label">弹窗与抽屉</span>
          <div class="cluster">
            <AppButton variant="secondary" @click="dialogOpen = true">打开 Dialog</AppButton>
            <AppButton variant="secondary" @click="drawerOpen = true">打开 Drawer</AppButton>
            <span class="component-preview__hint"><AppIcon name="info" :size="16" /> Escape 可关闭</span>
          </div>
        </div>
      </div>
    </AppCard>

    <AppCard :elevated="false" class="scope-card">
      <AppSectionHeader title="节点 3 范围" description="本轮只验证壳层、路由、组件和响应式切换；正式首页与业务模块留待后续节点。" />
      <div class="scope-card__items">
        <span><AppIcon name="check" :size="16" />桌面侧栏与顶部栏</span>
        <span><AppIcon name="check" :size="16" />移动顶部品牌栏与底栏</span>
        <span><AppIcon name="check" :size="16" />统一表单、反馈、弹层组件</span>
      </div>
    </AppCard>

    <AppDialog v-model="dialogOpen" title="Dialog 占位预览">
      <p>这是公共弹窗的交互占位，后续节点再接入真实业务内容。</p>
      <template #footer>
        <AppButton variant="ghost" @click="dialogOpen = false">关闭</AppButton>
      </template>
    </AppDialog>

    <AppDrawer v-model="drawerOpen" title="Drawer 占位预览">
      <p>这是公共抽屉的交互占位，支持 Escape 关闭。</p>
    </AppDrawer>

    <AppToast v-model="toastOpen" message="Toast 组件已显示" tone="success" />
  </section>
</template>
