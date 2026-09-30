<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import { useRegistryStore } from '~/stores/registry';
import type { AuditAction, Participant, PendingRandomization, PendingStatus, TrialRole } from '~/types/trial';

const { t } = useI18n();
const trial = useTrialStore();
const registry = useRegistryStore();
const { participants, audits, pending } = storeToRefs(trial);
const role = ref<TrialRole>('investigator');
const offline = ref(false);
const actor = ref('研究者张宁');
const busy = ref(false);

const schema = toTypedSchema(z.object({
  participantNo: z.string().min(4, '请输入至少4位受试者编号'),
  identityKey: z.string().min(4, '请输入身份核验标识'),
  site: z.string().min(2, '请选择研究中心'),
  ageBand: z.enum(['18-44', '45-64', '65+']),
  actor: z.string().min(2, '请输入操作人')
}));
const { defineField, handleSubmit, errors, resetForm } = useForm({ validationSchema: schema, initialValues: { participantNo: '', identityKey: '', site: '上海中心', ageBand: '45-64', actor: '研究者张宁' } });
const [participantNo] = defineField('participantNo');
const [identityKey] = defineField('identityKey');
const [site] = defineField('site');
const [ageBand] = defineField('ageBand');
const [actorField] = defineField('actor');

/** 治疗组可见规则：药品管理员只见发药信息；研究者/监察员仅揭盲后可见 */
const visibleArm = (arm?: 'A' | 'B', status?: string) => {
  if (role.value === 'pharmacist') return '已隐藏';
  if (status === 'unblinded') return arm ?? '未知';
  return '已隐藏';
};

const canEnroll = computed(() => role.value !== 'pharmacist');

const submit = handleSubmit(async (values) => {
  const result = await trial.enroll(values, offline.value);
  if (!result.ok) {
    ElMessage.error(result.message);
    return;
  }
  ElMessage.success(result.message);
  resetForm({ values: { participantNo: '', identityKey: '', site: values.site, ageBand: values.ageBand, actor: values.actor } });
});

const unblind = async (id: string, participantNumber: string) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${participantNumber} 填写紧急揭盲原因（将形成不可删除的安全审计）`, '紧急揭盲', {
      inputType: 'textarea',
      inputValidator: (value) => Boolean(value?.trim()) || '揭盲原因不能为空',
      confirmButtonText: '确认并审计'
    });
    trial.emergencyUnblind(id, value, actor.value);
    ElMessage.warning('已揭盲，审计记录已追加');
  } catch {}
};

const maintainDispensing = async (row: Participant) => {
  try {
    const { value } = await ElMessageBox.prompt(`维护 ${row.participantNo} 的发药信息（药品编号）`, '发药信息维护', {
      inputValue: row.drugKitNo ?? '',
      inputValidator: (value) => Boolean(value?.trim()) || '药品编号不能为空',
      confirmButtonText: '保存并审计'
    });
    trial.updateDispensing(row.id, value, actor.value);
    ElMessage.success('发药信息已更新并记入审计');
  } catch {}
};

const confirmRow = async (row: PendingRandomization) => {
  busy.value = true;
  try {
    const result = await trial.commitPending(row.id, actor.value);
    if (result.ok) ElMessage.success(result.message);
    else ElMessage.warning(result.message);
  } finally {
    busy.value = false;
  }
};

const replay = async () => {
  busy.value = true;
  try {
    const result = await trial.replayAll(actor.value);
    if (result.total === 0) ElMessage.info('没有待重放的记录');
    else ElMessage.success(`按原顺序重放 ${result.total} 条：成功 ${result.succeeded}，失败 ${result.failed}`);
  } finally {
    busy.value = false;
  }
};

watch(offline, async (value) => {
  registry.setOnline(!value);
  if (value) {
    ElMessage.warning('已切换离线：入组内容将原样保留在待提交队列，恢复后按原顺序重放');
    return;
  }
  const result = await trial.replayAll(actor.value);
  if (result.total > 0) ElMessage.success(`联网恢复，按原提交顺序重放 ${result.total} 条：成功 ${result.succeeded}，失败 ${result.failed}`);
});

/** 跨标签页同步：多名管理员并发确认时共享同一份中央入库结果 */
const sync = () => {
  trial.hydrate();
  registry.hydrate();
};
onMounted(() => window.addEventListener('storage', sync));
onUnmounted(() => window.removeEventListener('storage', sync));

const counts = computed(() => ({
  total: participants.value.length,
  unblinded: participants.value.filter((item) => item.status === 'unblinded').length,
  sites: Object.keys(trial.bySite).length,
  pending: trial.pendingCount
}));

const statusTag = (status: PendingStatus) => ({ pending: 'info', committing: 'warning', committed: 'success', failed: 'danger' } as const)[status];
const statusText = (status: PendingStatus) => ({ pending: '待提交', committing: '确认中', committed: '已入库', failed: '失败' })[status];
const auditType = (action: AuditAction) => ({
  randomized: 'success',
  'pending-committed': 'success',
  'receipt-duplicate': 'warning',
  'receipt-expired': 'warning',
  'pending-failed': 'danger',
  'duplicate-blocked': 'warning',
  unblinded: 'danger',
  'replay-started': 'primary',
  'dispensing-updated': 'primary',
  'pending-queued': 'primary'
}[action] as 'success' | 'warning' | 'danger' | 'primary');
</script>

<template>
  <main class="page">
    <header class="hero">
      <div><el-tag type="success">GCP 本地原型</el-tag><h1>{{ t('title') }}</h1><p>{{ t('subtitle') }}</p></div>
      <el-segmented v-model="role" :options="[{ label: '研究者', value: 'investigator' }, { label: '药品管理员', value: 'pharmacist' }, { label: '监察员', value: 'monitor' }]" />
    </header>

    <section style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:20px">
      <div class="stat"><span>已随机入组</span><b>{{ counts.total }}</b></div>
      <div class="stat"><span>紧急揭盲</span><b>{{ counts.unblinded }}</b></div>
      <div class="stat"><span>参与中心</span><b>{{ counts.sites }}</b></div>
      <div class="stat"><span>待提交/失败</span><b>{{ counts.pending }}</b></div>
    </section>

    <div class="grid">
      <el-card shadow="never">
        <template #header>
          <b>{{ t('randomize') }}</b>
          <el-switch v-model="offline" active-text="模拟离线" style="float:right" :disabled="role === 'pharmacist'" />
        </template>
        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item label="研究中心" :error="errors.site"><el-select v-model="site" style="width:100%"><el-option label="上海中心" value="上海中心" /><el-option label="广州中心" value="广州中心" /><el-option label="新加坡中心" value="新加坡中心" /></el-select></el-form-item>
          <el-form-item label="受试者编号" :error="errors.participantNo"><el-input v-model="participantNo" placeholder="S01-003" /></el-form-item>
          <el-form-item label="身份核验标识" :error="errors.identityKey"><el-input v-model="identityKey" placeholder="脱敏身份键或筛选号" /></el-form-item>
          <el-form-item label="年龄分层" :error="errors.ageBand"><el-radio-group v-model="ageBand"><el-radio-button value="18-44">18-44</el-radio-button><el-radio-button value="45-64">45-64</el-radio-button><el-radio-button value="65+">65+</el-radio-button></el-radio-group></el-form-item>
          <el-form-item label="操作人" :error="errors.actor"><el-input v-model="actorField" /></el-form-item>
          <el-button type="primary" native-type="submit" style="width:100%" :disabled="!canEnroll">执行分层区组随机</el-button>
          <div v-if="role === 'pharmacist'" class="role-hint">药品管理员仅可维护发药信息，入组与确认由研究者/管理员执行</div>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header><div style="display:flex;justify-content:space-between"><b>{{ t('participants') }}</b><el-tag>{{ role }}</el-tag></div></template>
        <el-table :data="participants" max-height="480">
          <el-table-column prop="participantNo" label="受试者" min-width="110" />
          <el-table-column prop="site" label="中心" min-width="110" />
          <el-table-column prop="sequence" label="随机号" width="90" />
          <el-table-column label="治疗组" width="90">
            <template #default="{ row }"><el-tag :type="row.status === 'unblinded' ? 'danger' : 'info'">{{ visibleArm(row.arm, row.status) }}</el-tag></template>
          </el-table-column>
          <el-table-column label="发药信息" min-width="150">
            <template #default="{ row }">
              <span v-if="row.drugKitNo">{{ row.drugKitNo }}<div class="muted">{{ row.dispensedAt ? new Date(row.dispensedAt).toLocaleString() : '' }}</div></span>
              <span v-else class="muted">未发药</span>
            </template>
          </el-table-column>
          <el-table-column prop="receiptId" label="中央回执" min-width="120">
            <template #default="{ row }"><span class="muted">{{ row.receiptId ?? '—' }}</span></template>
          </el-table-column>
          <el-table-column label="操作" width="110">
            <template #default="{ row }">
              <el-button v-if="role === 'investigator'" size="small" type="danger" plain @click="unblind(row.id, row.participantNo)">揭盲</el-button>
              <el-button v-if="role === 'pharmacist'" size="small" type="primary" plain @click="maintainDispensing(row as Participant)">维护发药</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header>
          <b>{{ t('pending') }}</b>
          <el-button size="small" type="success" plain style="float:right" :disabled="offline || busy || role === 'pharmacist'" @click="replay">联网重放（按原顺序）</el-button>
        </template>
        <el-empty v-if="pending.length === 0" description="暂无待提交记录" />
        <el-table v-else :data="pending" max-height="420">
          <el-table-column prop="payload.participantNo" label="受试者" min-width="100" />
          <el-table-column label="状态" width="90">
            <template #default="{ row }"><el-tag :type="statusTag(row.status)">{{ statusText(row.status) }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="retryCount" label="重试" width="60" />
          <el-table-column label="失败原因" min-width="140">
            <template #default="{ row }"><span class="muted">{{ row.lastError ?? '—' }}</span></template>
          </el-table-column>
          <el-table-column prop="receiptId" label="回执号" min-width="120">
            <template #default="{ row }"><span class="muted">{{ row.receiptId ?? '—' }}</span></template>
          </el-table-column>
          <el-table-column label="操作" width="110">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'pending' || row.status === 'failed'"
                size="small"
                type="primary"
                :loading="busy || row.status === 'committing'"
                :disabled="offline || role === 'pharmacist'"
                @click="confirmRow(row as PendingRandomization)"
              >{{ row.status === 'failed' ? '重试' : '确认入库' }}</el-button>
              <span v-else-if="row.status === 'committed'" class="muted">已落定</span>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
      <el-card shadow="never">
        <template #header><b>{{ t('audit') }}</b><el-tag type="warning" style="float:right">仅追加</el-tag></template>
        <el-timeline>
          <el-timeline-item v-for="entry in audits" :key="entry.id" :timestamp="new Date(entry.at).toLocaleString()" :type="auditType(entry.action)">
            <b>{{ entry.actor }} · {{ entry.action }}</b><div>{{ entry.detail }}</div>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </div>
  </main>
</template>

<style scoped>
@media (max-width: 900px) { section { grid-template-columns: 1fr 1fr !important; } }
.muted { color: #8aa0ad; font-size: 12px; }
.role-hint { margin-top: 8px; color: #b07a1f; font-size: 12px; }
</style>
