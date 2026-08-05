<script setup lang="ts">
import DesktopShell from './DesktopShell.vue';
import DesktopTopbar from './DesktopTopbar.vue';
import MainContent from './MainContent.vue';
import MobileShell from './MobileShell.vue';
</script>

<template>
<div class="app-frame">
  <DesktopShell />
  <div class="app-main">
    <DesktopTopbar />
    <MobileShell />
    <MainContent><slot /></MainContent>
  </div>
</div>
</template>
