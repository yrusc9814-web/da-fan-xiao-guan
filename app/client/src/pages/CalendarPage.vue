<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AppButton from '../components/ui/AppButton.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppErrorState from '../components/ui/AppErrorState.vue';
import { apiRequest } from '../services/api';
interface Day{date:string;hasPlans:boolean;hasRecords:boolean;hasDrafts:boolean;plans:Array<{id:string;mealType:string;status:string}>;records:Array<{id:string;mealType:string;status:string}>}
const cursor=ref(new Date()),days=ref<Day[]>([]),loading=ref(true),error=ref('');
const range=computed(()=>{const y=cursor.value.getFullYear(),m=cursor.value.getMonth();const start=new Date(y,m,1),end=new Date(y,m+1,0);return{label:`${y} 年 ${m+1} 月`,start:start.toLocaleDateString('sv-SE'),end:end.toLocaleDateString('sv-SE')}});
async function load(){loading.value=true;error.value='';try{const data=await apiRequest<{days:Day[]}>('/calendar',{query:{start:range.value.start,end:range.value.end}});days.value=data.days}catch(e){error.value=e instanceof Error?e.message:'加载失败'}finally{loading.value=false}}
async function move(delta:number){cursor.value=new Date(cursor.value.getFullYear(),cursor.value.getMonth()+delta,1);await load()}
onMounted(load);
</script>
<template><section class="business-page"><header class="business-hero"><div><p class="business-eyebrow">Calendar</p><h1>饮食日历</h1><p>计划、正式记录与草稿分别标记，同一天可以同时出现。</p></div><div class="calendar-nav"><AppButton variant="ghost" @click="move(-1)">上个月</AppButton><strong>{{range.label}}</strong><AppButton variant="ghost" @click="move(1)">下个月</AppButton></div></header><AppErrorState v-if="error" title="日历读取失败" :description="error" @retry="load"/><p v-else-if="loading">正在读取日历…</p><AppEmptyState v-else-if="!days.length" title="这个月还没有安排" description="在饮食计划中安排一餐，或补一篇日记。"/><div v-else class="calendar-grid"><article v-for="day in days" :key="day.date" class="calendar-day app-card"><strong>{{day.date.slice(-2)}} 日</strong><div class="calendar-marks"><span v-if="day.hasPlans">计划 {{day.plans.length}}</span><span v-if="day.hasRecords">记录 {{day.records.filter(x=>x.status==='CONFIRMED').length}}</span><span v-if="day.hasDrafts">草稿 {{day.records.filter(x=>x.status==='DRAFT').length}}</span></div></article></div></section></template>
<style scoped>.calendar-nav{display:flex;align-items:center;gap:10px}.calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:10px}.calendar-day{min-height:110px;padding:14px}.calendar-marks{display:grid;gap:5px;margin-top:12px}.calendar-marks span{padding:4px 8px;border-radius:99px;font-size:11px;background:var(--color-primary-soft)}@media(max-width:760px){.calendar-nav{justify-content:space-between}.calendar-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}</style>
