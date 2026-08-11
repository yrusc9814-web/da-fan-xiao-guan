<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { DinerDto, KitchenToolDto, RecipeDto, StoreDto } from '../../../shared/types';
import AppButton from '../components/ui/AppButton.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog.vue';
import { apiRequest, ApiRequestError } from '../services/api';
import { displayLabel } from '../utils/display';
import { finiteInRange, positiveInteger } from '../utils/validation';

type CatalogKind = 'recipes' | 'stores' | 'diners' | 'tools';
type CatalogItem = RecipeDto | StoreDto | DinerDto | KitchenToolDto;
const props = defineProps<{ kind: CatalogKind }>();
const router = useRouter();
const route = useRoute();
const settings = computed(
  () =>
    ({
      recipes: {
        title: '我的菜谱',
        eyebrow: 'Recipe book',
        create: '新增菜谱',
        empty: '还没有菜谱，先记录一道拿手菜吧。'
      },
      stores: {
        title: '觅食店铺',
        eyebrow: 'Food discovery',
        create: '新增店铺',
        empty: '还没有收藏店铺，从一家常去的小馆开始吧。'
      },
      diners: {
        title: '食用者',
        eyebrow: 'Diners',
        create: '新增食用者',
        empty: '添加一起吃饭的人，推荐会更贴合忌口与过敏信息。'
      },
      tools: {
        title: '厨房工具',
        eyebrow: 'Kitchen tools',
        create: '新增工具',
        empty: '录入现有工具后，推荐会过滤无法制作的菜谱。'
      }
    })[props.kind]
);
const items = ref<CatalogItem[]>([]),
  loading = ref(true),
  saving = ref(false);
const error = ref(''),
  conflict = ref(''),
  query = ref('');
const showForm = ref(false),
  editingId = ref<string | null>(null);
const pendingDelete = ref<CatalogItem | null>(null);
const emptyForm = () => ({
  name: '',
  note: '',
  imagePath: '',
  address: '',
  storeType: '',
  cuisine: '',
  averageCost: '',
  supportsDineIn: true,
  supportsTakeout: true,
  contact: '',
  businessHours: '',
  rating: '',
  recommendedDishes: '',
  avoidDishes: '',
  tagsText: '',
  mealTypes: ['LUNCH', 'DINNER'] as string[],
  likesText: '',
  dislikesText: '',
  tabooText: '',
  allergyText: '',
  portionNote: '',
  active: true,
  category: '',
  quantity: '1',
  status: ''
});
const form = ref(emptyForm());

function normalizeItems(value: unknown): CatalogItem[] {
  if (Array.isArray(value)) return value as CatalogItem[];
  return value && typeof value === 'object' && 'items' in value && Array.isArray((value as { items: unknown }).items)
    ? (value as { items: CatalogItem[] }).items
    : [];
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    items.value = normalizeItems(await apiRequest(`/${props.kind}`, { query: { search: query.value, pageSize: 100 } }));
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '加载失败';
  } finally {
    loading.value = false;
  }
}
async function createItem() {
  if (props.kind === 'recipes') {
    await router.push('/recipes/new');
    return;
  }
  if (!form.value.name.trim()) {
    error.value = '名称不能为空';
    return;
  }
  if (props.kind === 'stores' && form.value.averageCost && !finiteInRange(form.value.averageCost, 0)) {
    error.value = '人均消费必须是非负数字';
    return;
  }
  if (props.kind === 'stores' && form.value.rating && !finiteInRange(form.value.rating, 0, 5)) {
    error.value = '评分必须在 0–5 之间';
    return;
  }
  if (props.kind === 'tools' && !positiveInteger(form.value.quantity)) {
    error.value = '工具数量必须是大于 0 的整数';
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    const body =
      props.kind === 'stores'
        ? {
            name: form.value.name.trim(),
            imagePath: form.value.imagePath || null,
            address: form.value.address || null,
            storeType: form.value.storeType || null,
            cuisine: form.value.cuisine || null,
            averageCost: form.value.averageCost ? Number(form.value.averageCost) : null,
            supportsDineIn: form.value.supportsDineIn,
            supportsTakeout: form.value.supportsTakeout,
            contact: form.value.contact || null,
            businessHours: form.value.businessHours || null,
            rating: form.value.rating ? Number(form.value.rating) : null,
            recommendedDishes: form.value.recommendedDishes || null,
            avoidDishes: form.value.avoidDishes || null,
            tagsText: form.value.tagsText || null,
            notes: form.value.note || null,
            mealTypes: form.value.mealTypes
          }
        : props.kind === 'diners'
          ? {
              name: form.value.name.trim(),
              avatarPath: form.value.imagePath || null,
              likesText: form.value.likesText || null,
              dislikesText: form.value.dislikesText || null,
              tabooText: form.value.tabooText || null,
              allergyText: form.value.allergyText || null,
              portionNote: form.value.portionNote || null,
              notes: form.value.note || null,
              active: form.value.active
            }
          : {
              name: form.value.name.trim(),
              imagePath: form.value.imagePath || null,
              category: form.value.category || null,
              quantity: Number(form.value.quantity),
              status: form.value.status || null,
              notes: form.value.note || null
            };
    const existing = editingId.value ? items.value.find((item) => item.id === editingId.value) : null;
    await apiRequest(editingId.value ? `/${props.kind}/${editingId.value}` : `/${props.kind}`, {
      method: editingId.value ? 'PUT' : 'POST',
      body: JSON.stringify(existing ? { ...body, version: existing.version } : body)
    });
    form.value = emptyForm();
    editingId.value = null;
    showForm.value = false;
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '保存失败';
  } finally {
    saving.value = false;
  }
}
function toggleMeal(mealType: string) {
  form.value.mealTypes = form.value.mealTypes.includes(mealType)
    ? form.value.mealTypes.filter((value) => value !== mealType)
    : [...form.value.mealTypes, mealType];
}
function editItem(item: CatalogItem) {
  if (props.kind === 'recipes') {
    void router.push(`/recipes/${item.id}/edit`);
    return;
  }
  const value = item as any;
  editingId.value = item.id;
  showForm.value = true;
  form.value = {
    ...emptyForm(),
    name: item.name,
    note: value.notes ?? '',
    imagePath: value.imagePath ?? value.avatarPath ?? '',
    address: value.address ?? '',
    storeType: value.storeType ?? '',
    cuisine: value.cuisine ?? '',
    averageCost: value.averageCost == null ? '' : String(value.averageCost),
    supportsDineIn: value.supportsDineIn ?? true,
    supportsTakeout: value.supportsTakeout ?? true,
    contact: value.contact ?? '',
    businessHours: value.businessHours ?? '',
    rating: value.rating == null ? '' : String(value.rating),
    recommendedDishes: value.recommendedDishes ?? '',
    avoidDishes: value.avoidDishes ?? '',
    tagsText: value.tagsText ?? '',
    mealTypes: (value.mealTypes ?? []).map((entry: any) => (typeof entry === 'string' ? entry : entry.mealType)),
    likesText: value.likesText ?? '',
    dislikesText: value.dislikesText ?? '',
    tabooText: value.tabooText ?? '',
    allergyText: value.allergyText ?? '',
    portionNote: value.portionNote ?? '',
    active: value.active ?? true,
    category: value.category ?? '',
    quantity: String(value.quantity ?? 1),
    status: value.status ?? ''
  };
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function closeForm() {
  showForm.value = false;
  editingId.value = null;
  form.value = emptyForm();
}
async function removeItem(item: CatalogItem) {
  pendingDelete.value = item;
}
async function confirmRemove() {
  const item = pendingDelete.value;
  if (!item) return;
  saving.value = true;
  conflict.value = '';
  try {
    const versionOptions =
      props.kind === 'recipes' || props.kind === 'tools'
        ? { query: { version: item.version } }
        : { body: JSON.stringify({ version: item.version }) };
    await apiRequest(`/${props.kind}/${item.id}`, { method: 'DELETE', ...versionOptions });
    pendingDelete.value = null;
    await load();
  } catch (reason) {
    if (reason instanceof ApiRequestError && reason.status === 409) conflict.value = reason.message;
    else error.value = reason instanceof Error ? reason.message : '删除失败';
  } finally {
    saving.value = false;
  }
}
async function toggleFavorite(item: RecipeDto | StoreDto) {
  conflict.value = '';
  try {
    await apiRequest(`/${props.kind}/${item.id}/favorite`, {
      method: 'POST',
      body: JSON.stringify({ favorite: !item.favorite, version: item.version })
    });
    await load();
  } catch (reason) {
    if (reason instanceof ApiRequestError && reason.status === 409) conflict.value = reason.message;
    else error.value = reason instanceof Error ? reason.message : '更新失败';
  }
}
function detail(item: CatalogItem): string {
  if (props.kind === 'recipes') {
    const x = item as RecipeDto;
    return [
      x.cookingTimeMinutes ? `${x.cookingTimeMinutes} 分钟` : null,
      x.ingredients?.length ? `${x.ingredients.length} 种食材` : '待补食材'
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (props.kind === 'stores') {
    const x = item as StoreDto;
    return (
      [x.cuisine, x.address, x.averageCost ? `人均 ¥${x.averageCost}` : null].filter(Boolean).join(' · ') ||
      '待补店铺信息'
    );
  }
  if (props.kind === 'tools') {
    const x = item as KitchenToolDto;
    return [x.category, `${x.quantity} 件`, displayLabel(x.status)].filter(Boolean).join(' · ') || '可用于推荐硬过滤';
  }
  const x = item as DinerDto;
  return (
    [x.allergyText ? `过敏：${x.allergyText}` : null, x.tabooText ? `忌口：${x.tabooText}` : null]
      .filter(Boolean)
      .join(' · ') || '暂无忌口或过敏信息'
  );
}
onMounted(async () => {
  await load();
  const focus = String(route.query.focus ?? '');
  if (focus) {
    await nextTick();
    document.getElementById(`catalog-${focus}`)?.scrollIntoView({ block: 'center' });
  }
});
</script>

<template>
  <section class="business-page">
    <header class="business-hero">
      <div>
        <p class="business-eyebrow">{{ settings.eyebrow }}</p>
        <h1>{{ settings.title }}</h1>
        <p>所有内容保存在本机，支持搜索、冲突保护与历史关联。</p>
      </div>
      <AppButton
        @click="kind === 'recipes' ? router.push('/recipes/new') : showForm ? closeForm() : (showForm = true)"
        >{{ showForm ? '收起' : settings.create }}</AppButton
      >
    </header>
    <form v-if="showForm" class="business-form app-card" @submit.prevent="createItem">
      <h2>{{ editingId ? '编辑' : '新增' }}{{ settings.title }}</h2>
      <AppInput v-model="form.name" label="名称" placeholder="请输入名称" /><AppInput
        v-model="form.imagePath"
        :label="kind === 'diners' ? '头像路径' : '图片路径'"
        placeholder="可选"
      /><template v-if="kind === 'stores'"
        ><div class="catalog-fields">
          <AppInput v-model="form.address" label="地址" /><AppInput
            v-model="form.storeType"
            label="店铺类型"
          /><AppInput v-model="form.cuisine" label="菜系" /><AppInput
            v-model="form.averageCost"
            label="人均消费"
          /><AppInput v-model="form.contact" label="联系方式" /><AppInput
            v-model="form.businessHours"
            label="营业时间"
          /><AppInput v-model="form.rating" label="评分 0-5" /><AppInput
            v-model="form.tagsText"
            label="标签"
          /><AppInput v-model="form.recommendedDishes" label="推荐菜" /><AppInput
            v-model="form.avoidDishes"
            label="避雷菜"
          />
        </div>
        <div class="catalog-checks">
          <label><input v-model="form.supportsDineIn" type="checkbox" />堂食</label
          ><label><input v-model="form.supportsTakeout" type="checkbox" />外卖</label
          ><label v-for="meal in ['BREAKFAST', 'LUNCH', 'DINNER', 'AFTERNOON_TEA', 'SOUP']" :key="meal"
            ><input type="checkbox" :checked="form.mealTypes.includes(meal)" @change="toggleMeal(meal)" />{{
              displayLabel(meal)
            }}</label
          >
        </div></template
      ><template v-if="kind === 'diners'"
        ><div class="catalog-fields">
          <AppInput v-model="form.likesText" label="喜欢" /><AppInput
            v-model="form.dislikesText"
            label="不喜欢"
          /><AppInput v-model="form.tabooText" label="忌口（推荐硬过滤）" /><AppInput
            v-model="form.allergyText"
            label="过敏（推荐硬过滤）"
          /><AppInput v-model="form.portionNote" label="默认餐量" />
        </div>
        <label><input v-model="form.active" type="checkbox" />当前启用</label></template
      ><template v-if="kind === 'tools'"
        ><div class="catalog-fields">
          <AppInput v-model="form.category" label="分类" /><AppInput v-model="form.quantity" label="数量" /><label
            class="app-field"
            ><span class="app-field__label">状态</span
            ><select v-model="form.status">
              <option value="AVAILABLE">可用</option>
              <option value="BROKEN">损坏</option>
              <option value="MAINTENANCE">维护中</option>
            </select></label
          >
        </div></template
      ><AppInput v-model="form.note" label="备注" placeholder="可选" />
      <div class="business-card__actions">
        <AppButton type="button" variant="ghost" @click="closeForm">取消</AppButton
        ><AppButton type="submit" :loading="saving">保存</AppButton>
      </div>
    </form>
    <div class="business-toolbar app-card">
      <AppInput v-model="query" label="搜索" placeholder="输入名称或关键词" @keyup.enter="load" /><AppButton
        variant="secondary"
        @click="load"
        >查询</AppButton
      >
    </div>
    <div v-if="conflict" class="business-conflict" role="alert">
      {{ conflict }}，列表已保留，请刷新后重新操作。 <button type="button" @click="load">重新加载</button>
    </div>
    <AppErrorState v-if="error" title="暂时无法读取数据" :description="error" @retry="load" />
    <div v-else-if="loading" class="business-grid"><AppSkeleton v-for="index in 6" :key="index" height="150px" /></div>
    <AppEmptyState v-else-if="items.length === 0" title="这里还是空的" :description="settings.empty" />
    <div v-else class="business-grid">
      <article
        v-for="item in items"
        :id="`catalog-${item.id}`"
        :key="item.id"
        class="business-card app-card catalog-card"
        :class="{ 'business-card--focused': route.query.focus === item.id }"
      >
        <img
          v-if="(item as any).imagePath"
          class="catalog-card__image"
          :src="(item as any).imagePath"
          :alt="item.name"
          loading="lazy"
          decoding="async"
        />
        <div class="business-card__head">
          <div>
            <h2>{{ item.name }}</h2>
            <p>{{ detail(item) }}</p>
          </div>
          <button
            v-if="kind === 'recipes' || kind === 'stores'"
            class="business-favorite"
            type="button"
            @click="toggleFavorite(item as RecipeDto | StoreDto)"
          >
            {{ (item as RecipeDto | StoreDto).favorite ? '♥' : '♡' }}
          </button>
        </div>
        <div class="business-card__actions">
          <RouterLink v-if="kind === 'recipes'" :to="`/recipes/${item.id}`">查看详情</RouterLink
          ><button type="button" @click="editItem(item)">编辑</button
          ><button type="button" @click="removeItem(item)">{{ kind === 'diners' ? '停用' : '删除' }}</button>
        </div>
      </article>
    </div>
    <ConfirmDeleteDialog
      :model-value="Boolean(pendingDelete)"
      :item-name="pendingDelete?.name ?? ''"
      :loading="saving"
      @update:model-value="
        (value) => {
          if (!value) pendingDelete = null;
        }
      "
      @confirm="confirmRemove"
    />
  </section>
</template>
<style scoped>
.catalog-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.catalog-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.catalog-card {
  overflow: hidden;
}
.catalog-card__image {
  width: calc(100% + 40px);
  height: 170px;
  margin: -20px -20px 0;
  object-fit: cover;
}
.catalog-card a {
  color: var(--color-primary-hover);
  font-weight: 700;
}
@media (max-width: 640px) {
  .catalog-fields {
    grid-template-columns: 1fr;
  }
  .catalog-card__image {
    height: 190px;
  }
}
</style>
