<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import AppIcon from '../components/AppIcon.vue';
import MascotPlaceholder from '../components/mascot/MascotPlaceholder.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppCard from '../components/ui/AppCard.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppSectionHeader from '../components/ui/AppSectionHeader.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import { useAppStore } from '../stores/app';
import { useDashboardStore } from '../stores/dashboard';
import { fetchCalendar } from '../services/api';
import type { DashboardCalendarDay, DashboardMealSlot, DashboardRecipe } from '../../../shared/types';

import tomatoEggsImage from '../assets/recipe-photos/tomato-eggs.png';
import steamedFishImage from '../assets/recipe-photos/steamed-fish.png';
import broccoliImage from '../assets/recipe-photos/broccoli.png';
import braisedRibsImage from '../assets/recipe-photos/braised-ribs.png';
import tofuImage from '../assets/recipe-photos/tofu.png';
import shrimpImage from '../assets/recipe-photos/shrimp.png';
import recipePlaceholderImage from '../assets/recipe-placeholder.svg';
import randomDiceImage from '../assets/home-actions/random-dice.webp';
import mealBowlImage from '../assets/home-actions/meal-bowl.webp';
import inventoryBasketImage from '../assets/home-actions/inventory-basket.webp';
import recommendClipboardImage from '../assets/home-actions/recommend-clipboard.webp';

const appStore = useAppStore();
const dashboardStore = useDashboardStore();
const calendarOffset = ref(0);
const remoteCalendarDays = ref<DashboardCalendarDay[]>([]);
const calendarLoading = ref(false);
const calendarError = ref('');
let calendarRequestSequence = 0;

const recipeImages: Record<string, string> = {
  'tomato-eggs.png': tomatoEggsImage,
  'steamed-fish.png': steamedFishImage,
  'broccoli.png': broccoliImage,
  'braised-ribs.png': braisedRibsImage,
  'tofu.png': tofuImage,
  'shrimp.png': shrimpImage
};

const quickActions = [
  {
    title: '随机决定',
    description: '不知道吃什么？\n让运气帮你决定',
    to: '/recommendations?mode=random',
    image: randomDiceImage,
    tone: 'pink'
  },
  {
    title: '搭配一顿饭',
    description: '智能搭配食材\n生成营养均衡一餐',
    to: '/recommendations?mode=meal-set',
    image: mealBowlImage,
    tone: 'green'
  },
  {
    title: '库存消耗',
    description: '优先消耗即将过期\n的食材不浪费',
    to: '/inventory',
    image: inventoryBasketImage,
    tone: 'orange'
  },
  {
    title: '库存推荐',
    description: '根据库存推荐\n合适的菜谱',
    to: '/recommendations?mode=inventory',
    image: recommendClipboardImage,
    tone: 'purple'
  }
];

const dashboard = computed(() => dashboardStore.data);
const nickname = computed(() => dashboard.value?.userNickname ?? '');
const greeting = computed(() =>
  dashboard.value?.greetingPeriod === 'morning'
    ? '早上好'
    : dashboard.value?.greetingPeriod === 'afternoon'
      ? '下午好'
      : '晚上好'
);
const visibleCalendarDays = computed(() =>
  calendarOffset.value === 0 ? (dashboard.value?.calendarDays ?? []) : remoteCalendarDays.value
);
const calendarRange = computed(() => {
  const days = visibleCalendarDays.value;
  if (days.length === 0) return '本周';
  return `${formatShortDate(days[0]?.date ?? '')} – ${formatShortDate(days[days.length - 1]?.date ?? '')}`;
});

function recipeImage(imagePath: string | null): string | null {
  return imagePath ? (recipeImages[imagePath] ?? null) : null;
}

function isDevelopmentSeedRecipe(recipe: DashboardRecipe): boolean {
  return recipe.id.startsWith('dev-recipe-') && Boolean(recipe.imagePath && recipeImages[recipe.imagePath]);
}

function uploadedRecipeImage(imagePath: string | null): string | null {
  if (!imagePath || imagePath.includes('\0') || imagePath.includes('://')) return null;

  const normalized = imagePath
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/^uploads\//, '');
  const segments = normalized.split('/');
  if (!normalized || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;

  return `/uploads/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

function resolvedRecipeImage(recipe: DashboardRecipe): string {
  if (isDevelopmentSeedRecipe(recipe)) {
    return recipeImage(recipe.imagePath) ?? recipePlaceholderImage;
  }

  return uploadedRecipeImage(recipe.imagePath) ?? recipePlaceholderImage;
}

function handleRecipeImageError(event: Event): void {
  const image = event.currentTarget as HTMLImageElement;
  if (image.dataset.fallback === 'true' || image.src.endsWith(recipePlaceholderImage)) return;
  image.dataset.fallback = 'true';
  image.src = recipePlaceholderImage;
}

function mealIcon(mealType: DashboardMealSlot['mealType']): 'meal-breakfast' | 'meal-lunch' | 'meal-dinner' {
  if (mealType === 'BREAKFAST') return 'meal-breakfast';
  if (mealType === 'LUNCH') return 'meal-lunch';
  return 'meal-dinner';
}

function calendarMark(day: DashboardCalendarDay): string {
  if (day.isToday) return '今天';
  return ['🍲', '🥦', '🍥', '🍳', '🍮', '🍚', '🍓'][Math.max(0, Math.min(6, day.dayOfMonth % 7))] ?? '—';
}

function tagTone(tag: string): 'green' | 'pink' | 'orange' {
  const normalized = tag.trim();
  if (['低脂', '高蛋白', '素食', '减脂', '健康', '清淡'].includes(normalized)) return 'green';
  if (['川菜', '湘菜', '辣'].includes(normalized)) return 'orange';
  return 'pink';
}

function formatShortDate(date: string): string {
  if (!date) return '';
  const [, month, day] = date.split('-');
  return month && day ? `${month}/${day}` : date;
}

function toLocalBusinessDateNumber(date: string | null): number | null {
  if (!date) return null;
  const parts = date.split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null;

  const [year, month, day] = parts;
  if (year === undefined || month === undefined || day === undefined) return null;
  return Date.UTC(year, month - 1, day);
}

function currentLocalBusinessDateNumber(): number {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

function formatExpiryStatus(expiryDate: string | null): string {
  const expiryDateNumber = toLocalBusinessDateNumber(expiryDate);
  if (expiryDateNumber === null) return '日期未知';

  const daysRemaining = Math.round((expiryDateNumber - currentLocalBusinessDateNumber()) / 86_400_000);
  if (daysRemaining < 0) return '已过期';
  if (daysRemaining === 0) return '今天到期';
  return `剩余${daysRemaining}天`;
}

function addBusinessDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function calendarDay(date: string, status: DashboardCalendarDay['status'], today: string): DashboardCalendarDay {
  const value = new Date(`${date}T00:00:00Z`);
  return {
    date,
    weekday: ['日', '一', '二', '三', '四', '五', '六'][value.getUTCDay()] ?? '',
    dayOfMonth: value.getUTCDate(),
    isToday: date === today,
    status
  };
}

async function loadCalendarWeek(offset: number): Promise<void> {
  if (offset === 0 || !dashboard.value?.calendarDays[0]) return;
  const sequence = ++calendarRequestSequence;
  const start = addBusinessDays(dashboard.value.calendarDays[0].date, offset * 7);
  const end = addBusinessDays(start, 6);
  calendarLoading.value = true;
  calendarError.value = '';
  remoteCalendarDays.value = [];
  try {
    const response = await fetchCalendar(start, end);
    if (sequence !== calendarRequestSequence) return;
    const byDate = new Map(response.days.map((day) => [day.date, day]));
    remoteCalendarDays.value = Array.from({ length: 7 }, (_, index) => {
      const date = addBusinessDays(start, index);
      const day = byDate.get(date);
      const status = day?.hasRecords ? 'recorded' : day?.hasPlans || day?.hasDrafts ? 'planned' : 'empty';
      return calendarDay(date, status, dashboard.value?.currentDate ?? '');
    });
  } catch (error) {
    if (sequence === calendarRequestSequence)
      calendarError.value = error instanceof Error ? error.message : '日历读取失败';
  } finally {
    if (sequence === calendarRequestSequence) calendarLoading.value = false;
  }
}

watch(calendarOffset, (offset) => {
  void loadCalendarWeek(offset);
});

onMounted(() => {
  void appStore.checkHealth();
  void dashboardStore.load();
});
</script>

<template>
  <section class="homepage" aria-labelledby="homepage-title">
    <template v-if="dashboardStore.isLoading && !dashboard">
      <AppCard class="dashboard-loading"><AppSkeleton :lines="8" /></AppCard>
    </template>

    <AppErrorState
      v-else-if="dashboardStore.status === 'error'"
      title="首页数据暂时不可用"
      :description="dashboardStore.errorMessage ?? '请稍后重试'"
    >
      <AppButton size="sm" @click="dashboardStore.load()">重新加载</AppButton>
    </AppErrorState>

    <template v-else-if="dashboard">
      <header class="home-hero" aria-labelledby="homepage-title">
        <div class="home-hero__copy">
          <h1 id="homepage-title">
            {{ greeting }}<template v-if="nickname">，{{ nickname }}</template> <span aria-hidden="true">♥</span>
          </h1>
          <p>{{ dashboard.greetingText }}</p>
        </div>
        <span class="home-hero__cloud home-hero__cloud--left" aria-hidden="true"></span>
        <span class="home-hero__cloud home-hero__cloud--right" aria-hidden="true"></span>
        <span class="home-hero__heart home-hero__heart--one" aria-hidden="true">♥</span>
        <span class="home-hero__heart home-hero__heart--two" aria-hidden="true">♥</span>
        <span class="home-hero__heart home-hero__heart--three" aria-hidden="true">♥</span>
        <span class="home-hero__heart home-hero__heart--four" aria-hidden="true">♥</span>
        <span class="home-hero__flowerpot" aria-hidden="true"><i>✿</i></span>
        <span class="home-hero__flowerpot home-hero__flowerpot--right" aria-hidden="true"><i>✿</i></span>
        <span class="home-hero__checklist" aria-hidden="true"><AppIcon name="clipboard-check" :size="30" /></span>
        <MascotPlaceholder placement="home-hero" />
      </header>

      <section class="quick-actions" aria-labelledby="quick-actions-title">
        <h2 id="quick-actions-title" class="sr-only">快捷入口</h2>
        <AppCard v-for="action in quickActions" :key="action.title" class="quick-action-card">
          <div class="quick-action-card__copy">
            <h3>{{ action.title }}</h3>
            <p>{{ action.description }}</p>
            <RouterLink :to="action.to" class="app-button app-button--secondary app-button--sm"
              >去{{ action.title.replace('库存', '') }}</RouterLink
            >
          </div>
          <div class="quick-action-card__visual" :class="`quick-action-card__visual--${action.tone}`">
            <img
              :src="action.image"
              :alt="`${action.title}插画`"
              width="384"
              height="256"
              loading="lazy"
              decoding="async"
            />
          </div>
        </AppCard>
      </section>

      <section class="homepage-section homepage-section--recommendations" aria-labelledby="recommendations-title">
        <AppSectionHeader title="今日推荐菜谱" description="从本地菜谱中挑选几道今天的灵感。">
          <template #actions>
            <RouterLink class="section-link" to="/recommendations"
              >查看更多 <AppIcon name="chevron-right" :size="16"
            /></RouterLink>
          </template>
        </AppSectionHeader>
        <div v-if="dashboard.recommendedRecipes.length" class="recipe-scroller" aria-label="今日推荐菜谱">
          <RouterLink
            v-for="recipe in dashboard.recommendedRecipes"
            :key="recipe.id"
            class="recipe-card"
            :to="`/recipes/${recipe.id}`"
          >
            <div class="recipe-card__image">
              <img
                :src="resolvedRecipeImage(recipe)"
                :alt="recipe.name"
                loading="lazy"
                decoding="async"
                @error="handleRecipeImageError"
              />
            </div>
            <div class="recipe-card__body">
              <h3>{{ recipe.name }}</h3>
              <div class="recipe-card__tags">
                <span v-for="tag in recipe.tags.slice(0, 2)" :key="tag" :data-tone="tagTone(tag)">{{ tag }}</span>
              </div>
              <div class="recipe-card__meta">
                <span><AppIcon name="calendar" :size="14" />{{ recipe.cookingTimeMinutes ?? '—' }}分钟</span>
                <span v-if="recipe.rating !== null" class="recipe-card__rating">★ {{ recipe.rating }}</span>
              </div>
            </div>
          </RouterLink>
        </div>
        <AppEmptyState v-else title="还没有推荐菜谱" description="完成菜谱录入后，这里会出现今日灵感。" />
      </section>

      <section class="dashboard-info-grid" aria-label="今日概览">
        <AppCard class="dashboard-card today-records-card">
          <AppSectionHeader title="今日饮食记录" description="记录每一餐，慢慢找到适合自己的节奏。">
            <template #actions
              ><span class="section-count"
                >{{ dashboard.todayRecords.filter((meal) => meal.recorded).length }}/3 餐</span
              ></template
            >
          </AppSectionHeader>
          <div class="meal-slots">
            <div
              v-for="meal in dashboard.todayRecords"
              :key="meal.mealType"
              class="meal-slot"
              :data-recorded="meal.recorded"
              :data-meal-type="meal.mealType"
            >
              <span class="meal-slot__icon" aria-hidden="true"
                ><AppIcon :name="mealIcon(meal.mealType)" :size="21"
              /></span>
              <div class="meal-slot__content">
                <strong>{{ meal.label }}</strong>
                <p>{{ meal.title ?? '还没有记录' }}</p>
              </div>
              <time v-if="meal.time">{{ meal.time }}</time>
            </div>
          </div>
          <RouterLink class="inline-action" to="/records"
            >查看饮食记录 <AppIcon name="arrow-right" :size="14"
          /></RouterLink>
        </AppCard>

        <AppCard class="dashboard-card weekly-stats-card">
          <AppSectionHeader title="本周统计" description="用轻量数据看见自己的饮食节奏。">
            <template #actions
              ><RouterLink class="section-link" to="/statistics"
                >全部 <AppIcon name="chevron-right" :size="16" /></RouterLink
            ></template>
          </AppSectionHeader>
          <div class="stats-grid">
            <div>
              <span class="stats-grid__icon" aria-hidden="true"><AppIcon name="calendar" :size="22" /></span
              ><strong>记录天数</strong><span>{{ dashboard.weeklyStats.recordedDays }}/7 天</span>
            </div>
            <div>
              <span class="stats-grid__icon" aria-hidden="true"><AppIcon name="clock" :size="22" /></span
              ><strong>总餐次</strong><span>{{ dashboard.weeklyStats.totalMeals }} 餐</span>
            </div>
            <div>
              <span class="stats-grid__icon" aria-hidden="true"><AppIcon name="star" :size="22" /></span
              ><strong>平均评分</strong><span>{{ dashboard.weeklyStats.averageRating ?? '—' }} 分</span>
            </div>
            <div>
              <span class="stats-grid__icon" aria-hidden="true"><AppIcon name="ingredient" :size="22" /></span
              ><strong>食材消耗</strong><span>{{ dashboard.weeklyStats.consumedIngredientCount }} 种</span>
            </div>
          </div>
        </AppCard>

        <AppCard class="dashboard-card inventory-card">
          <AppSectionHeader title="库存概览" description="掌握食材状态，减少临期浪费。">
            <template #actions
              ><RouterLink class="section-link" to="/inventory"
                >全部 <AppIcon name="chevron-right" :size="16" /></RouterLink
            ></template>
          </AppSectionHeader>
          <div class="inventory-metrics">
            <div class="inventory-metric inventory-metric--pink">
              <strong>{{ dashboard.inventory.totalIngredients }}</strong
              ><span>食材总数</span>
            </div>
            <div class="inventory-metric inventory-metric--orange">
              <strong>{{ dashboard.inventory.expiringSoon }}</strong
              ><span>即将过期</span>
            </div>
            <div class="inventory-metric inventory-metric--purple">
              <strong>{{ dashboard.inventory.insufficient }}</strong
              ><span>库存不足</span>
            </div>
          </div>
          <div v-if="dashboard.inventory.expiringIngredients.length" class="expiring-list">
            <strong>即将过期的食材</strong>
            <div v-for="ingredient in dashboard.inventory.expiringIngredients.slice(0, 3)" :key="ingredient.id">
              <span class="expiring-list__ingredient">
                <span class="expiring-list__food" aria-hidden="true"><AppIcon name="ingredient" :size="20" /></span>
                <span class="expiring-list__name">{{ ingredient.name }}</span>
              </span>
              <time :datetime="ingredient.expiryDate ?? undefined">{{ ingredient.expiryDate ?? '日期未知' }}</time>
              <small>{{ formatExpiryStatus(ingredient.expiryDate) }}</small>
            </div>
          </div>
          <AppEmptyState v-else title="库存状态良好" description="暂时没有临期食材。" />
        </AppCard>
      </section>

      <section class="homepage-section calendar-section" aria-labelledby="calendar-title">
        <AppSectionHeader title="饮食日历" description="看看这一周的计划和记录。">
          <template #actions>
            <div class="calendar-actions">
              <button type="button" aria-label="上一周" @click="calendarOffset -= 1">
                <AppIcon name="chevron-left" :size="18" />
              </button>
              <span>{{ calendarRange }}</span>
              <button type="button" aria-label="下一周" @click="calendarOffset += 1">
                <AppIcon name="chevron-right" :size="18" />
              </button>
            </div>
          </template>
        </AppSectionHeader>
        <AppSkeleton v-if="calendarLoading" :lines="2" />
        <AppErrorState v-else-if="calendarError" title="这一周的日历暂时不可用" :description="calendarError">
          <AppButton size="sm" @click="loadCalendarWeek(calendarOffset)">重新加载</AppButton>
        </AppErrorState>
        <div v-else-if="visibleCalendarDays.length" class="calendar-week">
          <div
            v-for="day in visibleCalendarDays"
            :key="day.date"
            class="calendar-day"
            :class="{ 'calendar-day--today': day.isToday }"
            :data-status="day.status"
          >
            <span>周{{ day.weekday }}</span>
            <strong>{{ day.dayOfMonth }}</strong>
            <small>{{ calendarMark(day) }}</small>
          </div>
        </div>
        <AppEmptyState v-else title="日历暂无内容" description="有计划或记录后会显示在这里。" />
      </section>

      <AppCard class="homepage-tip" :elevated="false">
        <AppIcon name="sparkle" :size="20" />
        <span>{{ dashboard.tip }}</span>
      </AppCard>
    </template>
  </section>
</template>
