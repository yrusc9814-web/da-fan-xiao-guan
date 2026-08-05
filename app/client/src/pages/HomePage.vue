<script setup lang="ts">
import { onMounted } from 'vue';

import { useAppStore } from '../stores/app';

const appStore = useAppStore();

onMounted(() => {
  void appStore.checkHealth();
});
</script>

<template>
  <main class="temporary-home">
    <section class="status-card" aria-labelledby="page-title">
      <p class="eyebrow">节点 1 · 基础工程</p>
      <h1 id="page-title">搭饭小馆</h1>
      <p class="status-copy">当前状态：基础工程搭建完成</p>

      <div class="backend-status" :data-status="appStore.backendStatus">
        <span class="status-dot" aria-hidden="true"></span>
        <span>后端连接状态：{{ appStore.statusLabel }}</span>
      </div>

      <p v-if="appStore.errorMessage" class="error-copy">
        {{ appStore.errorMessage }}
      </p>

      <button type="button" class="check-button" @click="appStore.checkHealth()">
        重新检查
      </button>

      <p class="scope-note">
        此页面仅用于验证前后端基础连通性，正式首页视觉和业务模块将在后续节点实施。
      </p>
    </section>
  </main>
</template>
