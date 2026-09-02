<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AppButton from '../components/ui/AppButton.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import { apiRequest } from '../services/api';
import { buildMonthGrid, monthRange } from '../utils/calendar';
import { displayLabel } from '../utils/display';
interface Day {
  date: string;
  hasPlans: boolean;
  hasRecords: boolean;
  hasDrafts: boolean;
  plans: Array<{ id: string; mealType: string; status: string }>;
  records: Array<{ id: string; mealType: string; status: string }>;
}
const weekdayHeaders = ['一', '二', '三', '四', '五', '六', '日'];
const cursor = ref(new Date()),
  days = ref<Day[]>([]),
  loading = ref(true),
  error = ref('');
const range = computed(() => {
  const y = cursor.value.getFullYear(),
    m = cursor.value.getMonth();
  return {
    label: `${y} 年 ${m + 1} 月`,
    ...monthRange(y, m)
  };
});
const cells = computed(() => buildMonthGrid(cursor.value.getFullYear(), cursor.value.getMonth()));
const dayMap = computed(() => new Map(days.value.map((day) => [day.date, day])));
function weekday(date: string) {
  return new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(new Date(`${date}T12:00:00`));
}
function marker(date: string) {
  return dayMap.value.get(date);
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await apiRequest<{ days: Day[] }>('/calendar', {
      query: { start: range.value.start, end: range.value.end }
    });
    days.value = data.days;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}
async function move(delta: number) {
  cursor.value = new Date(cursor.value.getFullYear(), cursor.value.getMonth() + delta, 1);
  await load();
}
onMounted(load);
</script>
<template>
  <section class="business-page">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">Calendar</p>
        <h1>饮食日历</h1>
        <p>计划、已记录与待完成的餐次会分别标记，同一天可以同时出现。</p>
      </div>
      <div class="calendar-nav">
        <AppButton variant="ghost" @click="move(-1)">上个月</AppButton><strong>{{ range.label }}</strong
        ><AppButton variant="ghost" @click="move(1)">下个月</AppButton>
      </div>
    </header>
    <AppErrorState v-if="error" title="日历读取失败" :description="error" @retry="load" />
    <div v-else-if="loading" class="calendar-grid"><AppSkeleton v-for="index in 14" :key="index" height="110px" /></div>
    <div v-else class="calendar-grid">
      <div v-for="label in weekdayHeaders" :key="label" class="calendar-weekday">{{ label }}</div>
      <RouterLink
        v-for="cell in cells"
        :key="cell.date"
        :to="{ path: '/plans', query: { date: cell.date } }"
        class="calendar-day app-card"
        :class="{
          'calendar-day--outside': !cell.inCurrentMonth,
          'calendar-day--today': cell.isToday
        }"
        :data-date="cell.date"
        :data-in-current-month="cell.inCurrentMonth ? 'true' : 'false'"
        :data-today="cell.isToday ? 'true' : 'false'"
        ><strong>{{ Number(cell.date.slice(-2)) }} 日</strong>
        <div class="calendar-marks">
          <span v-if="marker(cell.date)?.hasPlans">计划 {{ marker(cell.date)?.plans.length }}</span
          ><span v-if="marker(cell.date)?.hasRecords"
            >记录 {{ marker(cell.date)?.records.filter((x) => x.status === 'CONFIRMED').length }}</span
          ><span v-if="marker(cell.date)?.hasDrafts"
            >待完成 {{ marker(cell.date)?.records.filter((x) => x.status === 'DRAFT').length }}</span
          >
        </div></RouterLink
      >
    </div>
    <div v-if="days.length" class="calendar-agenda">
      <RouterLink
        v-for="day in days"
        :key="day.date"
        :to="{ path: '/plans', query: { date: day.date } }"
        class="agenda-day app-card"
        ><header>
          <strong>{{ Number(day.date.slice(-2)) }} 日</strong><span>{{ weekday(day.date) }}</span>
        </header>
        <p v-for="plan in day.plans" :key="plan.id">
          <b>{{ displayLabel(plan.mealType) }}</b> {{ displayLabel(plan.status) }}
        </p>
        <p v-for="record in day.records" :key="record.id">
          <b>{{ displayLabel(record.mealType) }}</b> {{ displayLabel(record.status) }}
        </p></RouterLink
      >
    </div>
  </section>
</template>
<style scoped>
.calendar-nav {
  display: flex;
  align-items: center;
  gap: 10px;
}
.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 10px;
}
.calendar-weekday {
  font-size: 13px;
  color: var(--color-text-muted);
  text-align: center;
}
.calendar-day {
  min-height: 110px;
  padding: 14px;
  color: inherit;
  text-decoration: none;
}
.calendar-day--outside {
  opacity: 0.45;
}
.calendar-day--today {
  outline: 2px solid var(--color-primary);
}
.calendar-marks {
  display: grid;
  gap: 5px;
  margin-top: var(--space-3);
}
.calendar-marks span {
  padding: var(--space-1) var(--space-2);
  border-radius: 99px;
  font-size: 11px;
  background: var(--color-primary-soft);
}
.calendar-agenda {
  display: none;
}
@media (max-width: 1023px) {
  .calendar-nav {
    justify-content: space-between;
  }
  .calendar-grid {
    display: none;
  }
  .calendar-agenda {
    display: grid;
    gap: 10px;
  }
  .agenda-day {
    display: grid;
    gap: var(--space-2);
    color: inherit;
    text-decoration: none;
  }
  .agenda-day header {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }
  .agenda-day header strong {
    font-size: 20px;
  }
  .agenda-day header span {
    color: var(--color-text-muted);
  }
  .agenda-day p {
    margin: 0;
    padding: var(--space-2) 10px;
    border-radius: 10px;
    background: #fff7f9;
  }
}
</style>
