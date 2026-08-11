<script setup lang="ts">
import AppFrame from './layouts/AppFrame.vue';
import PinGate from './components/PinGate.vue';
import { ref } from 'vue';
const unlocked = ref(false);
</script>

<template>
  <PinGate v-if="!unlocked" @unlocked="unlocked = true" />
  <AppFrame v-else>
    <RouterView />
  </AppFrame>
</template>
