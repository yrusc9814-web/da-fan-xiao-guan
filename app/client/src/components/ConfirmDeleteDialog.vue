<script setup lang="ts">
import AppButton from './ui/AppButton.vue';
import AppDialog from './ui/AppDialog.vue';

defineProps<{ modelValue: boolean; itemName: string; loading?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; confirm: [] }>();
</script>

<template>
  <AppDialog
    :model-value="modelValue"
    :title="`删除“${itemName}”`"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p>删除后可在“最近删除”中保留 30 天并恢复。确定继续吗？</p>
    <template #footer>
      <AppButton variant="ghost" @click="emit('update:modelValue', false)">取消</AppButton>
      <AppButton :loading="loading" @click="emit('confirm')">删除</AppButton>
    </template>
  </AppDialog>
</template>
