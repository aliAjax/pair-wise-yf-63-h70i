<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import { useCentralRegistry } from '~/composables/useCentralRegistry';
import type { AuditAction, Participant, PendingRandomization, TrialRole } from '~/types/trial';

const { t } = useI18n();
const trial = useTrialStore();
const { participants, audits, pendingOrdered, confirming, ready, centralOutage } = storeToRefs(trial);
const role = ref<TrialRole>('investigator');
const offline = ref(false);

onMounted(async () => {
  await trial.init();
});

const schema = toTypedSchema(z.object({
  participantNo: z.string().min(4, '请输入至少4位受试者编号'),
  identityKey: z.string().min(4, '请输入身份核验标识'),
  site: z.string().min(2, '请选择研究中心'),
  ageBand: z.enum(['18-44', '45-64', '65+']),
  actor: z.string().min(2, '请输入操作人')
}));
const { defineField, handleSubmit, errors, resetForm } = useForm({
  validationSchema: schema,
  initialValues: { participantNo: '', identityKey: '', site: '上海中心', ageBand: '45-64', actor: '研究者张宁' }
});
const [participantNo] = defineField('participantNo');
const [identityKey] = defineField('identityKey');
const [site] = defineField('site');
const [ageBand] = defineField('ageBand');
const [actor] = defineField('actor');
/** 操作人在各动作调用处需要确定的字符串 */
const actorName = computed(() => actor.value ?? '');

const canEnroll = computed(() => role.value !== 'pharmacist');
const canUnblind = computed(() => role.value === 'investigator');
const canDispense = computed(() => role.value === 'pharmacist');

/**
 * 治疗组可见性（中央分组默认遮蔽）：
 * - 研究者：默认隐藏，紧急揭盲（须留原因）后可见；
 * - 药品管理员：永远只见“已遮蔽”，只能维护发药信息；
 * - 监察员：仅已揭盲记录可见，用于核查。
 */
const visibleArm = (row: Participant) => {
  if (role.value === 'pharmacist') return '已遮蔽';
  if (row.status === 'unblinded') return row.arm ?? '未知';
  if (role.value === 'monitor') return '已遮蔽';
  return '已隐藏';
};

const submit = handleSubmit(async (values) => {
  const result = await trial.randomize(values, offline.value);
  if (result.ok) ElMessage.success(result.message);
  else ElMessage.error(result.message);
  if (result.ok) {
    resetForm({ values: { participantNo: '', identityKey: '', site: values.site, ageBand: values.ageBand, actor: values.actor } });
  }
});

const unblind = async (row: Participant) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${row.participantNo} 紧急揭盲必须填写原因`, '紧急揭盲（研究者）', {
      inputType: 'textarea',
      inputPlaceholder: '请填写紧急揭盲原因（将写入不可删除的安全审计）',
      inputValidator: (value) => Boolean(value?.trim()) || '揭盲原因不能为空',
      confirmButtonText: '确认揭盲并审计'
    });
    const result = trial.emergencyUnblind(row.id, value, actorName.value, role.value);
    if (result.ok) ElMessage.warning(result.message);
    else ElMessage.error(result.message);
  } catch {}
};

// 发药信息维护（仅药品管理员）
const dispensingTarget = ref<Participant | null>(null);
const dispensingVisible = ref(false);
const dispensingForm = ref({ kitNo: '', lotNo: '' });
const openDispensing = (row: Participant) => {
  dispensingTarget.value = row;
  dispensingForm.value = { kitNo: row.dispensing?.kitNo ?? '', lotNo: row.dispensing?.lotNo ?? '' };
  dispensingVisible.value = true;
};
const closeDispensing = () => {
  dispensingVisible.value = false;
};
const saveDispensing = () => {
  if (!dispensingTarget.value) return;
  const result = trial.updateDispensing(
    dispensingTarget.value.requestId,
    dispensingForm.value,
    actorName.value,
    role.value
  );
  if (result.ok) {
    ElMessage.success(result.message);
    dispensingVisible.value = false;
  } else {
    ElMessage.error(result.message);
  }
};

const recheck = async (id: string) => {
  const result = await trial.reconfirmCommitted(id, actorName.value);
  if (result.ok) ElMessage.success(result.message);
  else ElMessage.warning(result.message);
};

const confirmOne = async (id: string) => {
  const result = await trial.confirmPending(id, actorName.value);
  if (result.ok) ElMessage.success(result.message);
  else ElMessage.warning(result.message);
};

/** 模拟两名管理员同时点“确认入库”：入口锁 + 中央幂等，只产生一次入库、一个随机号 */
const confirmConcurrent = async (id: string) => {
  const [r1, r2] = await Promise.all([
    trial.confirmPending(id, '管理员甲'),
    trial.confirmPending(id, '管理员乙')
  ]);
  ElMessage.info(`管理员甲：${r1.message} ｜ 管理员乙：${r2.message}`);
};

/** 演示：把该队列项已拿到的中央回执置为过期，再确认必须被拒绝且不改分组 */
const expireReceiptThenConfirm = async (id: string) => {
  const registry = useCentralRegistry();
  await registry.expireActiveReceipt(id);
  const result = await trial.confirmPending(id, actorName.value);
  ElMessage.warning(result.message);
};

const refreshReceipt = async (id: string) => {
  const result = await trial.refreshReceipt(id, actorName.value);
  if (result.ok) ElMessage.success(result.message);
  else ElMessage.error(result.message);
};

const replayAll = async () => {
  const summary = await trial.replayPending(actorName.value);
  if (summary.committed) ElMessage.success(`重放完成：${summary.committed} 条按原序入库`);
  if (summary.paused) ElMessage.warning('中央仍不可达，重放已暂停，失败原因与重试次数已保留');
  if (!summary.committed && !summary.paused) ElMessage.info('没有可重放的记录');
};

const toggleOutage = async (value: boolean) => {
  await trial.setCentralOutage(value, actorName.value);
  ElMessage.info(value ? '中央登记已中断：入组内容保留，不本地发号' : '中央登记已恢复：按原提交顺序重放');
};

const statusMeta: Record<string, { label: string; type: 'info' | 'warning' | 'success' | 'danger' }> = {
  pending: { label: '待提交', type: 'warning' },
  failed: { label: '失败待重试', type: 'danger' },
  committed: { label: '已入库', type: 'success' }
};

const actionMeta: Record<AuditAction, { label: string; type: 'primary' | 'success' | 'warning' | 'danger' }> = {
  randomized: { label: '中央随机入库', type: 'success' },
  unblinded: { label: '紧急揭盲', type: 'danger' },
  'pending-queued': { label: '离线入队', type: 'warning' },
  'pending-committed': { label: '回执确认入库', type: 'success' },
  'pending-failed': { label: '确认失败', type: 'danger' },
  'duplicate-blocked': { label: '重复入组拦截', type: 'warning' },
  'central-unavailable': { label: '中央不可达', type: 'danger' },
  'central-restored': { label: '中央恢复', type: 'success' },
  'replay-started': { label: '开始按序重放', type: 'primary' },
  'replay-paused': { label: '重放暂停', type: 'warning' },
  'receipt-expired': { label: '过期回执拒绝', type: 'warning' },
  'receipt-unknown': { label: '未知回执拒绝', type: 'danger' },
  'receipt-confirmed': { label: '回执核验一致', type: 'primary' },
  'confirm-conflict': { label: '中央冲突拒绝', type: 'danger' },
  'dispensing-updated': { label: '发药信息维护', type: 'primary' },
  forbidden: { label: '越权操作拒绝', type: 'danger' }
};

const counts = computed(() => ({
  total: participants.value.length,
  unblinded: participants.value.filter((item) => item.status === 'unblinded').length,
  sites: Object.keys(trial.bySite).length,
  pending: trial.pendingCount,
  failed: pendingOrdered.value.filter((q) => q.status === 'failed').length
}));
</script>

<template>
  <main v-loading="!ready" class="page">
    <header class="hero">
      <div>
        <el-tag type="success">GCP 中央登记原型</el-tag>
        <h1>{{ t('title') }}</h1>
        <p>{{ t('subtitle') }}</p>
      </div>
      <el-segmented
        v-model="role"
        :options="[{ label: '研究者', value: 'investigator' }, { label: '药品管理员', value: 'pharmacist' }, { label: '监察员', value: 'monitor' }]"
      />
    </header>

    <el-alert
      :type="centralOutage ? 'error' : 'success'"
      :closable="false"
      show-icon
      style="margin-bottom:16px"
      :title="centralOutage ? '中央登记服务中断：入组保留原内容、按序排队，本地不发号' : '中央登记服务在线：确认以中央回执为准'"
    >
      <template #default>
        <span>受试者编号与身份核验标识全场只能登记一次；重复/过期回执不能改写已落定分组。</span>
        <el-switch
          :model-value="centralOutage"
          style="margin-left:12px"
          active-text="模拟中央中断"
          inline-prompt
          @change="(val: string | number | boolean) => toggleOutage(Boolean(val))"
        />
      </template>
    </el-alert>

    <section style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;margin-bottom:20px">
      <div class="stat"><span>中央已入库</span><b>{{ counts.total }}</b></div>
      <div class="stat"><span>紧急揭盲</span><b>{{ counts.unblinded }}</b></div>
      <div class="stat"><span>参与中心</span><b>{{ counts.sites }}</b></div>
      <div class="stat"><span>待提交</span><b>{{ counts.pending }}</b></div>
      <div class="stat"><span>失败待重试</span><b>{{ counts.failed }}</b></div>
    </section>

    <div class="grid">
      <el-card shadow="never">
        <template #header>
          <b>{{ t('randomize') }}</b>
          <el-tag :type="offline ? 'warning' : 'info'" style="float:right;margin-left:8px">
            {{ offline ? '离线登记' : '在线中央登记' }}
          </el-tag>
          <el-switch v-model="offline" active-text="离线" style="float:right" />
        </template>
        <el-alert
          v-if="!canEnroll"
          type="warning"
          :closable="false"
          title="药品管理员只能维护发药信息，不能执行入组随机"
          style="margin-bottom:12px"
        />
        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item label="研究中心" :error="errors.site">
            <el-select v-model="site" style="width:100%" :disabled="!canEnroll">
              <el-option label="上海中心" value="上海中心" />
              <el-option label="广州中心" value="广州中心" />
              <el-option label="新加坡中心" value="新加坡中心" />
            </el-select>
          </el-form-item>
          <el-form-item label="受试者编号（全场唯一）" :error="errors.participantNo">
            <el-input v-model="participantNo" placeholder="S01-003" :disabled="!canEnroll" />
          </el-form-item>
          <el-form-item label="身份核验标识（全场唯一）" :error="errors.identityKey">
            <el-input v-model="identityKey" placeholder="脱敏身份键或筛选号" :disabled="!canEnroll" />
          </el-form-item>
          <el-form-item label="年龄分层" :error="errors.ageBand">
            <el-radio-group v-model="ageBand" :disabled="!canEnroll">
              <el-radio-button value="18-44">18-44</el-radio-button>
              <el-radio-button value="45-64">45-64</el-radio-button>
              <el-radio-button value="65+">65+</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="操作人" :error="errors.actor">
            <el-input v-model="actor" />
          </el-form-item>
          <el-button type="primary" native-type="submit" style="width:100%" :disabled="!canEnroll">
            {{ offline ? '离线保留入组（恢复后按序重放）' : '提交中央登记' }}
          </el-button>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header>
          <div style="display:flex;justify-content:space-between">
            <b>{{ t('participants') }}</b>
            <el-tag>{{ role }}</el-tag>
          </div>
        </template>
        <el-table :data="participants" max-height="480">
          <el-table-column prop="participantNo" label="受试者" min-width="100" />
          <el-table-column prop="site" label="中心" min-width="100" />
          <el-table-column label="中央随机号" width="100">
            <template #default="{ row }"><b>{{ row.sequence }}</b></template>
          </el-table-column>
          <el-table-column label="治疗组" width="90">
            <template #default="{ row }">
              <el-tag :type="row.status === 'unblinded' ? 'danger' : 'info'">{{ visibleArm(row as Participant) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="发药信息" min-width="150">
            <template #default="{ row }">
              <span v-if="row.dispensing">药盒 {{ row.dispensing.kitNo }} · 批号 {{ row.dispensing.lotNo }}</span>
              <span v-else style="color:#9aa8b0">未发药</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170">
            <template #default="{ row }">
              <el-button v-if="canUnblind && row.status !== 'unblinded'" size="small" type="danger" plain @click="unblind(row as Participant)">揭盲</el-button>
              <el-button v-if="canDispense" size="small" type="primary" plain @click="openDispensing(row as Participant)">发药</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <b>{{ t('pending') }}</b>
            <el-button size="small" type="success" plain :disabled="centralOutage || counts.pending === 0" @click="replayAll">
              联网恢复·按原序重放
            </el-button>
          </div>
        </template>
        <el-alert
          type="info"
          :closable="false"
          style="margin-bottom:10px"
          title="队列按原提交顺序重放；失败保留原因与重试次数；已入库记录沿用原随机号"
        />
        <el-empty v-if="pendingOrdered.length === 0" description="暂无待提交记录" />
        <el-table v-else :data="pendingOrdered" max-height="520">
          <el-table-column label="#" width="44">
            <template #default="{ row }">{{ row.orderIndex + 1 }}</template>
          </el-table-column>
          <el-table-column label="受试者" min-width="100">
            <template #default="{ row }">{{ row.payload.participantNo }}</template>
          </el-table-column>
          <el-table-column label="原入组内容" min-width="180">
            <template #default="{ row }">
              {{ row.payload.site }} · {{ row.payload.ageBand }} · {{ row.payload.identityKey }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusMeta[row.status]?.type">{{ statusMeta[row.status]?.label ?? row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="重试" width="56">
            <template #default="{ row }">{{ row.retries }}</template>
          </el-table-column>
          <el-table-column label="中央回执 / 失败原因" min-width="200">
            <template #default="{ row }">
              <div v-if="row.receipt" style="font-family:monospace;font-size:12px">
                {{ row.receipt.receiptId }}
                <div style="color:#9aa8b0">随机号 {{ row.receipt.sequence }}</div>
              </div>
              <div v-else-if="row.failureReason" style="color:#c45656;font-size:12px">{{ row.failureReason }}</div>
              <span v-else style="color:#9aa8b0">尚无回执</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="250">
            <template #default="{ row }">
              <template v-if="row.status !== 'committed'">
                <el-button
                  size="small"
                  type="primary"
                  :loading="confirming.includes(row.id)"
                  @click="confirmOne(row.id)"
                >
                  确认入库
                </el-button>
                <el-button size="small" plain :disabled="centralOutage" @click="confirmConcurrent(row.id)">并发确认</el-button>
                <el-button size="small" type="warning" plain @click="refreshReceipt(row.id)">刷新回执</el-button>
              </template>
              <template v-else>
                <el-button size="small" plain @click="recheck(row.id)">核验回执</el-button>
                <el-button size="small" type="warning" plain @click="expireReceiptThenConfirm(row.id)">模拟过期回执</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never">
        <template #header>
          <b>{{ t('audit') }}</b>
          <el-tag type="warning" style="float:right">仅追加·不可删除</el-tag>
        </template>
        <el-timeline>
          <el-timeline-item
            v-for="entry in audits"
            :key="entry.id"
            :timestamp="new Date(entry.at).toLocaleString()"
            :type="actionMeta[entry.action]?.type ?? 'primary'"
          >
            <b>{{ entry.actor }} · {{ actionMeta[entry.action]?.label ?? entry.action }}</b>
            <div>{{ entry.detail }}</div>
            <div v-if="entry.receiptId" style="font-size:12px;color:#607889;font-family:monospace">
              回执 {{ entry.receiptId }}<span v-if="typeof entry.retries === 'number'"> · 第 {{ entry.retries }} 次尝试</span>
            </div>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </div>

    <el-dialog v-model="dispensingVisible" title="维护发药信息（药品管理员）" width="420px" @close="closeDispensing">
      <el-alert
        type="info"
        :closable="false"
        style="margin-bottom:12px"
        :title="`受试者 ${dispensingTarget?.participantNo ?? ''} · 中央随机号 ${dispensingTarget?.sequence ?? ''}；治疗组对药品管理员遮蔽`"
      />
      <el-form label-position="top">
        <el-form-item label="药盒号" required>
          <el-input v-model="dispensingForm.kitNo" placeholder="如 KIT-2041" />
        </el-form-item>
        <el-form-item label="药品批号" required>
          <el-input v-model="dispensingForm.lotNo" placeholder="如 LOT-2026-09" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="closeDispensing">取消</el-button>
        <el-button type="primary" @click="saveDispensing">保存发药信息</el-button>
      </template>
    </el-dialog>
  </main>
</template>

<style scoped>
@media (max-width: 900px) {
  section { grid-template-columns: 1fr 1fr !important; }
}
</style>
