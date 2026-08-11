<script setup lang="ts">
export interface AppSelectOption {
  label: string;
  value: string;
}

withDefaults(
  defineProps<{
    modelValue?: string;
    label: string;
    options: AppSelectOption[];
    disabled?: boolean;
    error?: string;
  }>(),
  {
    modelValue: '',
    disabled: false,
    error: ''
  }
);

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <label class="app-field">
    <span class="app-field__label">{{ label }}</span>
    <select
      :value="modelValue"
      :disabled="disabled"
      :aria-invalid="Boolean(error)"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="option in options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
    <span v-if="error" class="app-field__error" role="alert">{{ error }}</span>
  </label>
</template>
